/*
 * GitHub Settings Exporter - background.js  (Manifest V3 classic service worker)
 *
 * 설계 요약
 *  - 전역 변수에 작업 상태를 두지 않는다. 모든 상태(세션/phase/탭 ID/요청 ID/결과)는 chrome.storage.local 에 있고,
 *    service worker 가 종료되었다가 깨어나도 저장된 phase 에서 이어진다.
 *  - 이벤트 기반: tabs.onUpdated / runtime.onMessage(content 결과) / alarms(watchdog) / 타이머가 같은 "re-drive" 함수들을 호출한다.
 *    모든 상태 전이는 mutate() 안에서 (sessionId, requestId, phase)를 확인하는 compare-and-set 이므로
 *    같은 이벤트가 중복으로 와도 한 Section 이 두 번 실행되지 않는다.
 *  - 부수효과(탭 이동, 메시지 전송)는 상태를 "먼저 저장(claim)한 쪽"만 수행한다.
 *    claim 후 service worker 가 죽으면 watchdog 이 phase 경과 시간을 보고 복구한다.
 *  - 긴 대기(root 탐색 / DOM 안정화)는 content script 가 하고, 결과를 별도 메시지(GSE_RESULT)로 보낸다.
 *    background 는 그 사이에 살아 있을 필요가 없다(메시지가 service worker 를 깨운다).
 *
 * Phase:  idle -> preparing -> navigating -> waiting_for_document -> handshaking -> waiting_for_root
 *         -> extracting -> saving_result -> advancing -> (다음 Section) ... -> completed
 */
importScripts('config.js', 'security.js', 'storage.js', 'formatter.js');

var Store = self.GSE_Storage;
var Fmt = self.GSE_Formatter;
var Sec = self.GSE_Security;
var ABORT = Store.ABORT;

var ALARM_WATCHDOG = 'gse-watchdog';
var CONTENT_FILES = ['security.js', 'extractor.js', 'metadata.js', 'content.js'];
var HANDSHAKE_POLL_MS = 400;
var RUN_GRACE_MS = 10000;        // content 가 결과를 보내오기까지의 여유
var TRANSITION_STALE_MS = 8000;  // 짧아야 하는 전이 상태(preparing/navigating/saving_result/advancing)가 이보다 오래 머물면 재시도
var NAV_SAME_URL_WAIT_MS = 3000;
var ACTIVE_PHASES = ['navigating', 'waiting_for_document', 'handshaking', 'waiting_for_root', 'extracting'];
var PAUSE_TYPES = ['authentication_required', 'captcha_required', 'rate_limited', 'external_redirect'];

var RESERVED_OWNERS = new Set(['settings', 'orgs', 'organizations', 'notifications', 'login', 'logout', 'pulls', 'issues',
    'marketplace', 'explore', 'topics', 'sponsors', 'features', 'enterprise', 'enterprises', 'about', 'new', 'dashboard', 'search',
    'codespaces', 'stars', 'trending', 'collections', 'events', 'sessions', 'session', 'join', 'signup', 'apps', 'users', 'pricing',
    'security', 'site', 'contact', 'customer-stories', 'readme', 'copilot', 'models', 'account', 'import', 'watching', 'developer',
    'solutions', 'resources', 'sitemap', 'git-guides', 'github', 'support', 'premium-support', 'partners', 'campus', 'community']);

var LOGIN_PATH_RE = /^\/(login|logout|session|sessions|signup|join|password_reset|two-factor)(\/|$)/i;
var SSO_PATH_RE = /^\/(orgs|enterprises)\/[^/]+\/sso(\/|$)/i;

var MESSAGES = {
    authentication_required: 'GitHub 로그인/인증(SSO, 2FA, sudo) 화면이 감지되어 작업을 일시 중지했습니다. Shadow Tab 에서 직접 인증을 마친 뒤 "이어받기"를 누르세요. 인증 화면은 분석하지 않습니다.',
    captcha_required: 'CAPTCHA/사람 확인 화면이 감지되어 작업을 일시 중지했습니다. Shadow Tab 에서 직접 확인을 마친 뒤 "이어받기"를 누르세요. 우회하지 않습니다.',
    rate_limited: 'GitHub 가 요청 제한(HTTP 429)을 응답했습니다. 잠시 기다린 뒤 "이어받기"를 누르세요.',
    external_redirect: 'github.com 밖(또는 읽을 수 없는 URL)으로 이동했습니다. SSO/로그인 이동으로 보여 작업을 일시 중지했습니다. Shadow Tab 을 확인한 뒤 "이어받기"를 누르세요.',
    page_not_found: 'HTTP 404: 존재하지 않는 경로이거나 이 계정에 접근 권한이 없는 페이지입니다. (GitHub 는 권한이 없는 설정 페이지에도 404 를 응답합니다)',
    permission_denied: 'HTTP 403: 이 페이지에 접근할 권한이 없습니다.',
    http_error: 'GitHub 가 오류 상태(HTTP 4xx/5xx)를 응답했습니다.',
    unexpected_redirect: '목표 URL 과 다른 경로로 이동(리다이렉트)되어 추출하지 않았습니다.',
    navigation_timeout: '페이지 로딩 시간이 초과되었습니다.',
    handshake_timeout: 'content script 가 응답하지 않았습니다(handshake 시간 초과).',
    root_not_found: '설정 컨테이너(root selector)를 찾을 수 없음',
    invalid_root_selector: 'root selector 가 올바른 CSS selector 가 아닙니다.',
    dom_stability_timeout: 'DOM 이 제한 시간 안에 안정화되지 않았습니다.',
    section_timeout: 'Section 처리 시간이 초과되었습니다.',
    extraction_error: '추출 중 오류가 발생했습니다.',
    navigation_error: '탭 이동에 실패했습니다.',
    storage_error: '결과를 저장하지 못했습니다(저장 공간 부족 등).',
    session_interrupted: '작업이 중단되었습니다.',
    stopped_by_user: '사용자가 작업을 중지했습니다.',
    unknown_error: '알 수 없는 오류'
};

// 작은 유틸
function nowIso() { return new Date().toISOString(); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function log(level, message, data) { return Store.appendLog(level, message, data); }

function parseRepoFromUrl(urlStr) {
    var u;
    try { u = new URL(urlStr); } catch (_) { return null; }
    if (u.protocol !== 'https:' || u.hostname !== 'github.com') return null;
    var seg = u.pathname.split('/').filter(Boolean);
    if (seg.length < 2) return null;
    var owner, name;
    try { owner = decodeURIComponent(seg[0]); name = decodeURIComponent(seg[1]); } catch (_) { return null; }
    if (RESERVED_OWNERS.has(owner.toLowerCase())) return null;
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) return null;
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name === '.' || name === '..') return null;
    return { owner: owner, name: name, url: 'https://github.com/' + owner + '/' + name };
}

function urlKey(u) {
    try {
        var x = new URL(u);
        return (x.origin + x.pathname.replace(/\/+$/, '')).toLowerCase();
    } catch (_) { return String(u || ''); }
}

/** 탭 URL 만으로 판단 가능한 차단(로그인 등) 분류 */
function classifyUrl(urlStr) {
    if (!urlStr) return { type: 'external_redirect', reason: 'unreadable_url' };
    var u;
    try { u = new URL(urlStr); } catch (_) { return { type: 'external_redirect', reason: 'invalid_url' }; }
    if (u.protocol === 'chrome-error:') return { type: 'navigation_error', reason: 'chrome_error_page' };
    if (u.hostname !== 'github.com') return { type: 'external_redirect', reason: 'off_github', host: u.hostname };
    if (LOGIN_PATH_RE.test(u.pathname) || SSO_PATH_RE.test(u.pathname)) return { type: 'authentication_required', reason: 'login_path' };
    return null;
}

/** handshake/실패 진단 정보(page)로 판단한 분류. null 이면 정상으로 본다. */
function classifyPageInfo(p) {
    if (!p) return null;
    var hints = p.hints || [];
    if (hints.indexOf('login_path') >= 0 || hints.indexOf('login_form') >= 0) return { action: 'pause', type: 'authentication_required' };
    if (hints.indexOf('captcha') >= 0) return { action: 'pause', type: 'captcha_required' };
    if (hints.indexOf('off_github') >= 0) return { action: 'pause', type: 'external_redirect' };
    if (p.httpStatus === 429) return { action: 'pause', type: 'rate_limited' };
    if (p.httpStatus === 404) return { action: 'fail', type: 'page_not_found' };
    if (p.httpStatus === 403) return { action: 'fail', type: 'permission_denied' };
    if (typeof p.httpStatus === 'number' && p.httpStatus >= 500) return { action: 'recover', type: 'http_error' };
    return null;
}

async function getTab(tabId) {
    if (tabId == null) return null;
    try { return await chrome.tabs.get(tabId); } catch (_) { return null; }
}

async function removeTab(tabId) {
    if (tabId == null) return;
    try { await chrome.tabs.remove(tabId); } catch (_) { /* 이미 닫힘 */ }
}

function currentEntry(s) { return s.plan[s.currentSectionIndex]; }
function currentResult(s) { return s.results[s.currentSectionIndex]; }

/** 이 세션/요청/phase 가 아직 유효한가 (compare-and-set 조건) */
function isCurrent(s, sessionId, requestId, phases) {
    if (!s || s.status !== 'running' || s.stopRequested) return false;
    if (s.sessionId !== sessionId) return false;
    if (requestId && (!s.currentRequest || s.currentRequest.requestId !== requestId)) return false;
    if (phases && phases.indexOf(s.phase) < 0) return false;
    return true;
}

function makeError(s, type, message, extra) {
    var entry = currentEntry(s);
    var r = currentResult(s);
    var e = {
        type: type,
        message: message || MESSAGES[type] || MESSAGES.unknown_error,
        phase: s.phase,
        sectionId: entry ? entry.id : null,
        sectionName: entry ? entry.name : null,
        url: entry ? entry.url : null,
        attempts: r ? r.attempts : 0,
        at: nowIso()
    };
    if (extra) Object.keys(extra).forEach(function (k) { if (extra[k] !== undefined) e[k] = extra[k]; });
    return e;
}

function setPhase(s, phase) {
    s.phase = phase;
    s.phaseStartedAt = nowIso();
    s.lastProgressAt = s.phaseStartedAt;
}

function validateConfig(cfg) {
    var errs = [];
    if (!cfg || !Array.isArray(cfg.sections) || !cfg.sections.length) return ['config.sections 가 비어 있습니다.'];
    var ids = {};
    var modes = ['normal-with-hard-reload-fallback', 'always-reload'];
    if (cfg.navigation && cfg.navigation.mode && modes.indexOf(cfg.navigation.mode) < 0) errs.push('navigation.mode 는 ' + modes.join(' | ') + ' 중 하나여야 합니다.');
    cfg.sections.forEach(function (sec, i) {
        var tag = 'sections[' + i + ']' + (sec && sec.name ? ' (' + sec.name + ')' : '');
        if (!sec || typeof sec !== 'object') { errs.push(tag + ': 객체가 아닙니다.'); return; }
        if (sec.id === undefined || sec.id === null || sec.id === '') errs.push(tag + ': id 가 없습니다.');
        else if (ids[String(sec.id)]) errs.push(tag + ': id ' + sec.id + ' 가 중복입니다.');
        else ids[String(sec.id)] = true;
        if (String(sec.id) === 'metadata') errs.push(tag + ': id "metadata" 는 예약어입니다.');
        if (!sec.name || typeof sec.name !== 'string') errs.push(tag + ': name 이 없습니다.');
        if (typeof sec.path !== 'string' || sec.path.charAt(0) !== '/') errs.push(tag + ': path 는 "/" 로 시작하는 문자열이어야 합니다.');
        if (!sec.selectors || typeof sec.selectors.root !== 'string' || !sec.selectors.root.trim()) errs.push(tag + ': selectors.root 가 필요합니다.');
        if (sec.selectors && sec.selectors.ignore !== undefined && !Array.isArray(sec.selectors.ignore)) errs.push(tag + ': selectors.ignore 는 배열이어야 합니다.');
        if (!Array.isArray(sec.actions)) errs.push(tag + ': actions 는 배열이어야 합니다(빈 배열 가능).');
        else sec.actions.forEach(function (a, j) {
            if (!a || a.type !== 'expand') errs.push(tag + ': actions[' + j + '].type 은 "expand" 만 지원합니다.');
            else if (typeof a.selector !== 'string' || !a.selector.trim()) errs.push(tag + ': actions[' + j + '].selector 가 필요합니다.');
        });
        if (!sec.options || typeof sec.options.enabled !== 'boolean') errs.push(tag + ': options.enabled(boolean) 가 필요합니다.');
        if (!sec.options || !(Number(sec.options.timeoutMs) > 0)) errs.push(tag + ': options.timeoutMs(양수) 가 필요합니다.');
    });
    return errs;
}

// 감시 대상 탭 ID 캐시 (tabs.onUpdated 는 브라우저의 모든 탭에서 발생하므로 storage 를 매번 읽지 않는다)
var shadowCache = { loaded: false, tabId: null };

async function getShadowTabIdCached() {
    if (!shadowCache.loaded) {
        var s = await Store.getSession();
        shadowCache.tabId = s && s.status === 'running' ? s.shadowTabId : null;
        shadowCache.loaded = true;
    }
    return shadowCache.tabId;
}

chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local' || !changes[Store.KEY_SESSION]) return;
    var v = changes[Store.KEY_SESSION].newValue;
    shadowCache.tabId = v && v.status === 'running' ? v.shadowTabId : null;
    shadowCache.loaded = true;
});

// watchdog (복구용). 알람은 정확한 시각을 보장하지 않으므로 "경과 시간"을 보고 판단한다.
async function ensureWatchdog() {
    try { await chrome.alarms.create(ALARM_WATCHDOG, { delayInMinutes: 0.5, periodInMinutes: 0.5 }); } catch (_) {}
}
async function clearWatchdog() {
    try { await chrome.alarms.clear(ALARM_WATCHDOG); } catch (_) {}
}
/** service worker 가 살아 있는 동안의 빠른 경로. 죽으면 알람이 대신한다. */
function scheduleTick(ms) {
    setTimeout(function () { watchdogTick().catch(function () {}); }, ms);
}

// 세션 시작 / 이어받기 / 중지 / 초기화
async function startSession(payload) {
    var errs = validateConfig(self.GSE_CONFIG);
    if (errs.length) return { ok: false, error: 'invalid_config', details: errs, message: 'config.js 설정 오류:\n- ' + errs.join('\n- ') };

    var repo = parseRepoFromUrl(payload && payload.activeTabUrl);
    if (!repo) return { ok: false, error: 'not_a_repository', message: 'GitHub Repository 페이지(https://github.com/<owner>/<repo>...)에서 실행하세요.' };

    var existing = await Store.getSession();
    if (existing && existing.status === 'running') return { ok: false, error: 'already_running', message: '이미 작업이 실행 중입니다.' };
    if (existing) {
        var oldTab = existing.shadowTabId;
        existing.shadowTabId = null;
        await removeTab(oldTab);
    }

    var session = Store.createSession({ config: self.GSE_CONFIG, repository: repo, originTabId: payload.activeTabId });
    await Store.replaceSession(session);
    shadowCache.loaded = true;
    shadowCache.tabId = null;
    await ensureWatchdog();
    await log('info', 'session_start', { sessionId: session.sessionId, repo: repo.owner + '/' + repo.name, sections: session.plan.length });
    startNextSection().catch(onDriveError);
    return { ok: true, sessionId: session.sessionId };
}

async function resumeSession() {
    var errs = validateConfig(self.GSE_CONFIG);
    if (errs.length) return { ok: false, error: 'invalid_config', details: errs, message: 'config.js 설정 오류:\n- ' + errs.join('\n- ') };

    var res = await Store.mutate(function (s) {
        if (!s) return { error: 'no_session', message: '이어받을 세션이 없습니다.' };
        if (s.status === 'running') return { error: 'already_running', message: '이미 작업이 실행 중입니다.' };
        Store.reconcileWithConfig(s, self.GSE_CONFIG);
        if (Store.countResumable(s) === 0) return { error: 'nothing_to_resume', message: '이어서 처리할 Section 이 없습니다.' };
        Store.prepareResume(s);
        s.status = 'running';
        s.stopRequested = false;
        s.pauseReason = null;
        s.lastError = null;
        s.finishedAt = null;
        s.currentRequest = null;
        s.navigation = null;
        s.currentSectionIndex = null;
        setPhase(s, 'preparing');
        return { ok: true, sessionId: s.sessionId, shadowTabId: s.shadowTabId };
    });
    if (res.value && res.value.error) return Object.assign({ ok: false }, res.value);

    var tab = await getTab(res.value.shadowTabId);
    if (!tab && res.value.shadowTabId != null) {
        // 기존 Shadow Tab 이 무효(브라우저 재시작 등): 새로 만든다
        await Store.mutate(function (s) { if (s && s.shadowTabId === res.value.shadowTabId) s.shadowTabId = null; else return ABORT; });
    }
    await ensureWatchdog();
    await log('info', 'session_resume', { sessionId: res.value.sessionId });
    startNextSection().catch(onDriveError);
    return { ok: true, sessionId: res.value.sessionId };
}

async function stopSession() {
    var res = await Store.mutate(function (s) {
        if (!s || (s.status !== 'running' && s.status !== 'interrupted')) return ABORT;
        var wasRunning = s.status === 'running';
        var tabId = s.shadowTabId;
        if (wasRunning) {
            var r = currentResult(s);
            if (r && r.status === 'running') {
                r.status = 'interrupted';
                r.error = makeError(s, 'stopped_by_user', MESSAGES.stopped_by_user);
                r.finishedAt = nowIso();
            }
        }
        s.stopRequested = true;
        s.status = 'stopped';
        s.shadowTabId = null;
        s.currentRequest = null;
        s.pauseReason = null;
        s.finishedAt = nowIso();
        setPhase(s, 'idle');
        return { tabId: tabId };
    });
    if (res.aborted) return { ok: false, error: 'not_running', message: '실행 중인 작업이 없습니다.' };
    shadowCache.tabId = null;
    await clearWatchdog();
    await cleanupShadowTab(res.value.tabId);
    await log('info', 'session_stopped');
    return { ok: true };
}

async function resetSession() {
    var s = await Store.getSession();
    if (s && s.status === 'running') return { ok: false, error: 'running', message: '실행 중에는 초기화할 수 없습니다. 먼저 중지하세요.' };
    var tabId = s ? s.shadowTabId : null;
    await Store.clearAll();
    shadowCache.tabId = null;
    await clearWatchdog();
    await cleanupShadowTab(tabId);
    return { ok: true };
}

async function cleanupShadowTab(tabId) {
    if (tabId == null) return;
    try { await chrome.tabs.sendMessage(tabId, { type: 'GSE_CANCEL' }, { frameId: 0 }); } catch (_) { /* content script 없음 */ }
    await removeTab(tabId);
}

function onDriveError(e) {
    log('error', 'drive_error', { message: String(e && e.message || e) });
}

// 상태 전이: Section 시작 -> 이동 -> 문서 준비 -> handshake -> 실행 요청

/** 다음 pending Section 을 claim 하고 이동을 시작한다. pending 이 없으면 세션을 완료한다. */
async function startNextSection() {
    var res = await Store.mutate(function (s) {
        if (!s || s.status !== 'running' || s.stopRequested) return ABORT;
        if (['idle', 'preparing', 'advancing', 'saving_result'].indexOf(s.phase) < 0) return ABORT; // 이미 다른 이벤트가 claim 함
        var idx = Store.firstPendingIndex(s);
        if (idx < 0) {
            var tabId = s.shadowTabId;
            s.status = 'completed';
            s.finishedAt = nowIso();
            s.shadowTabId = null;
            s.currentRequest = null;
            s.navigation = null;
            s.pauseReason = null;
            setPhase(s, 'completed');
            return { finished: true, tabId: tabId };
        }
        var entry = s.plan[idx];
        var r = s.results[idx];
        r.status = 'running';
        r.attempts += 1;
        r.startedAt = r.startedAt && r.attempts > 1 ? r.startedAt : nowIso();
        r.finishedAt = null;
        r.error = null;
        s.currentSectionIndex = idx;
        s.nextSectionIndex = idx + 1;
        s.currentRequest = { requestId: Store.uuid(), startedAt: nowIso(), deadlineAt: null, reloadsUsed: 0, injected: false, alwaysReloaded: false };
        s.navigation = { targetUrl: entry.url, fromUrl: '', issuedAt: null, sawLoading: false };
        setPhase(s, 'navigating');
        return { sectionIndex: idx, sessionId: s.sessionId, requestId: s.currentRequest.requestId };
    });
    if (res.aborted) return;
    var v = res.value;
    if (v.finished) {
        await clearWatchdog();
        await removeTab(v.tabId);
        await log('info', 'session_completed');
        return;
    }
    await log('info', 'section_start', { sectionIndex: v.sectionIndex });
    await issueNavigation(v.sessionId, v.requestId);
}

/** 현재 Section URL 로 Shadow Tab 을 이동시킨다(탭이 없으면 active:false 로 생성). */
async function issueNavigation(sessionId, requestId) {
    var s = await Store.getSession();
    if (!isCurrent(s, sessionId, requestId, ['navigating'])) return;
    var url = s.navigation.targetUrl;
    var tab = await getTab(s.shadowTabId);
    var fromUrl = tab ? (tab.url || '') : '';
    try {
        if (!tab) tab = await chrome.tabs.create({ url: url, active: false });
        else await chrome.tabs.update(tab.id, { url: url });
    } catch (e) {
        await failCurrent(sessionId, requestId, { type: 'navigation_error', status: 'failed', message: MESSAGES.navigation_error + ' (' + (e && e.message) + ')' });
        return;
    }
    var res = await Store.mutate(function (s2) {
        if (!isCurrent(s2, sessionId, requestId, ['navigating'])) return ABORT;
        s2.shadowTabId = tab.id;
        s2.navigation.issuedAt = nowIso();
        s2.navigation.fromUrl = fromUrl;
        s2.navigation.sawLoading = false;
        setPhase(s2, 'waiting_for_document');
        return true;
    });
    if (res.aborted) {
        // 중지 등으로 더 이상 유효하지 않다. 방금 만든 탭이 세션에 기록되지 않았다면 닫는다.
        var cur = await Store.getSession();
        if (!cur || cur.shadowTabId !== tab.id) await removeTab(tab.id);
        return;
    }
    scheduleTick((s.settings.navigation.navigationTimeoutMs || 30000) + 500);
    await checkDocumentReady(); // 이벤트를 놓쳤을 가능성에 대비한 재확인
}

function documentLooksFresh(nav, tab) {
    if (!nav || !nav.issuedAt) return false;
    if (nav.sawLoading) return true;
    if ((tab.url || '') !== (nav.fromUrl || '')) return true;
    return Date.now() - Date.parse(nav.issuedAt) > NAV_SAME_URL_WAIT_MS;
}

/** 탭이 목표 문서를 로딩 완료했는지 확인하고, 맞으면 handshake 단계로 넘긴다. (멱등) */
async function checkDocumentReady() {
    var s = await Store.getSession();
    if (!s || s.status !== 'running' || s.phase !== 'waiting_for_document' || !s.currentRequest) return;
    var sessionId = s.sessionId;
    var requestId = s.currentRequest.requestId;
    var tab = await getTab(s.shadowTabId);
    if (!tab) return; // 탭 제거 이벤트/ watchdog 이 처리
    if (tab.status !== 'complete') return;
    if (!documentLooksFresh(s.navigation, tab)) return;

    var url = tab.url || '';
    var blocked = classifyUrl(url);
    if (blocked) {
        if (PAUSE_TYPES.indexOf(blocked.type) >= 0) {
            await pauseCurrent(sessionId, requestId, { type: blocked.type, finalUrl: url });
            return;
        }
        if (blocked.type === 'navigation_error') {
            await recoverOrFail(sessionId, requestId, 'navigation_error', { finalUrl: url, status: 'failed' });
            return;
        }
    }
    if (urlKey(url) !== urlKey(s.navigation.targetUrl)) {
        // 목표와 다른 곳에 도착. 다른 경로로의 리다이렉트를 성공으로 처리하지 않는다.
        await recoverOrFail(sessionId, requestId, 'unexpected_redirect', { finalUrl: url, status: 'failed' });
        return;
    }

    var claim = await Store.mutate(function (s2) {
        if (!isCurrent(s2, sessionId, requestId, ['waiting_for_document'])) return ABORT;
        if (s2.settings.navigation.mode === 'always-reload' && !s2.currentRequest.alwaysReloaded) {
            s2.currentRequest.alwaysReloaded = true;
            s2.navigation.fromUrl = url;
            s2.navigation.issuedAt = nowIso();
            s2.navigation.sawLoading = false;
            setPhase(s2, 'waiting_for_document');
            return { reload: true, tabId: s2.shadowTabId, waitMs: s2.settings.navigation.navigationTimeoutMs };
        }
        setPhase(s2, 'handshaking');
        return { handshake: true };
    });
    if (claim.aborted) return;
    if (claim.value.reload) {
        try { await chrome.tabs.reload(claim.value.tabId, { bypassCache: true }); } catch (_) { /* watchdog 이 처리 */ }
        scheduleTick((claim.value.waitMs || 30000) + 500);
        return;
    }
    await performHandshake(sessionId, requestId);
}

/** content script 와 handshake(PING) 후 추출 요청(RUN)을 보낸다. 짧게 끝나는 제한된 루프(<= handshakeTimeoutMs). */
async function performHandshake(sessionId, requestId) {
    var s = await Store.getSession();
    if (!isCurrent(s, sessionId, requestId, ['handshaking'])) return;
    var tabId = s.shadowTabId;
    var started = Date.parse(s.phaseStartedAt) || Date.now();
    var timeout = s.settings.navigation.handshakeTimeoutMs || 10000;
    var pong = null;

    while (Date.now() - started < timeout) {
        var cur = await Store.getSession();
        if (!isCurrent(cur, sessionId, requestId, ['handshaking'])) return; // 다른 경로가 처리함/중지됨
        try {
            var res = await chrome.tabs.sendMessage(tabId, { type: 'GSE_PING', sessionId: sessionId, requestId: requestId }, { frameId: 0 });
            if (res && res.ok) { pong = res; break; }
        } catch (_) { /* content script 가 아직 없음 */ }
        await sleep(HANDSHAKE_POLL_MS);
    }
    if (!pong) { await onHandshakeTimeout(sessionId, requestId); return; }

    // 페이지가 로그인/CAPTCHA/오류 응답이면 분석하지 않는다
    var verdict = classifyPageInfo(pong.page);
    if (verdict) { await handleVerdict(sessionId, requestId, verdict, pong.page); return; }
    if (urlKey(pong.url) !== urlKey(s.navigation.targetUrl)) {
        await recoverOrFail(sessionId, requestId, 'unexpected_redirect', { finalUrl: pong.url, status: 'failed' });
        return;
    }

    // 실행 요청 메시지 구성 + 추출 예산(deadline) 확정
    var prep = await Store.mutate(function (s2) {
        if (!isCurrent(s2, sessionId, requestId, ['handshaking'])) return ABORT;
        var entry = currentEntry(s2);
        var req = s2.currentRequest;
        if (!req.deadlineAt) req.deadlineAt = Date.now() + (entry.timeoutMs || s2.settings.extraction.sectionTimeoutMs);
        return {
            type: 'GSE_RUN', sessionId: sessionId, requestId: requestId, sectionId: entry.id, kind: entry.kind,
            expectedUrl: entry.url, deadlineAt: req.deadlineAt,
            section: { name: entry.name, selectors: entry.selectors, actions: entry.actions, timeoutMs: entry.timeoutMs },
            settings: { extraction: s2.settings.extraction, security: s2.settings.security }
        };
    });
    if (prep.aborted) return;

    var ack = null;
    try { ack = await chrome.tabs.sendMessage(tabId, prep.value, { frameId: 0 }); } catch (_) { /* 아래에서 처리 */ }
    if (!ack || !ack.ok || !ack.accepted) { await onHandshakeTimeout(sessionId, requestId); return; }

    await Store.mutate(function (s3) {
        if (!isCurrent(s3, sessionId, requestId, ['handshaking'])) return ABORT; // 이미 PROGRESS 가 앞서 갱신했을 수 있음
        setPhase(s3, 'waiting_for_root');
        return true;
    });
    scheduleTick(Math.max(1000, prep.value.deadlineAt + RUN_GRACE_MS - Date.now() + 500)); // PROGRESS 가 먼저 phase 를 갱신했어도 감시는 필요
}

// 복구 / 실패 / 일시중지
async function handleVerdict(sessionId, requestId, verdict, page) {
    if (verdict.action === 'pause') {
        await pauseCurrent(sessionId, requestId, { type: verdict.type, finalUrl: page && page.url, details: diagnosticsOf(page) });
    } else if (verdict.action === 'recover') {
        await recoverOrFail(sessionId, requestId, verdict.type, { finalUrl: page && page.url, status: 'failed', details: diagnosticsOf(page) });
    } else {
        await failCurrent(sessionId, requestId, { type: verdict.type, status: 'failed', finalUrl: page && page.url, details: diagnosticsOf(page) });
    }
}

function diagnosticsOf(page) {
    if (!page) return undefined;
    return { httpStatus: page.httpStatus == null ? null : page.httpStatus, hints: page.hints || [], title: page.title || '' };
}

/** 현재 Section 을 interrupted 로 기록하고 세션을 일시 중지한다(Shadow Tab 은 사용자가 인증할 수 있게 남겨 둔다). */
async function pauseCurrent(sessionId, requestId, info) {
    var res = await Store.mutate(function (s) {
        if (!isCurrent(s, sessionId, requestId, ACTIVE_PHASES)) return ABORT;
        var r = currentResult(s);
        r.status = 'interrupted';
        r.finishedAt = nowIso();
        r.error = makeError(s, info.type, info.message, { finalUrl: info.finalUrl, details: info.details });
        s.lastError = r.error;
        s.status = 'interrupted';
        s.pauseReason = info.type;
        s.currentRequest = null;
        s.navigation = null;
        setPhase(s, 'idle');
        return { tabId: s.shadowTabId };
    });
    if (res.aborted) return;
    await clearWatchdog();
    try { await chrome.tabs.sendMessage(res.value.tabId, { type: 'GSE_CANCEL' }, { frameId: 0 }); } catch (_) {}
    await log('warn', 'session_paused', { type: info.type });
}

/** 현재 Section 을 실패/timeout 으로 기록하고 다음 Section 으로 진행한다. */
async function failCurrent(sessionId, requestId, info) {
    var res = await Store.mutate(function (s) {
        if (!isCurrent(s, sessionId, requestId, ACTIVE_PHASES)) return ABORT;
        recordFailure(s, info);
        return true;
    });
    if (res.aborted) return;
    await advance(sessionId);
}

function recordFailure(s, info) {
    var r = currentResult(s);
    r.status = info.status || 'failed';
    r.finishedAt = nowIso();
    r.error = makeError(s, info.type, info.message, { finalUrl: info.finalUrl, details: info.details });
    s.lastError = r.error;
    s.currentRequest = null;
    setPhase(s, 'saving_result');
}

async function advance(sessionId) {
    var res = await Store.mutate(function (s) {
        if (!s || s.sessionId !== sessionId || s.status !== 'running') return ABORT;
        if (s.phase !== 'saving_result') return ABORT;
        setPhase(s, 'advancing');
        return true;
    });
    if (res.aborted) return;
    await startNextSection();
}

/**
 * 제한된 횟수(reloadRetryCount)만 reload/재이동으로 복구하고, 소진되면 실패로 기록한다.
 * 새 requestId 를 발급하므로 이전 시도의 늦은 응답은 폐기된다.
 */
async function recoverOrFail(sessionId, requestId, failType, info) {
    var tabId = null;
    var action = null;
    // 복구 직후의 "이전 페이지가 아직 complete 상태"를 새 문서로 오인하지 않도록 현재 탭 URL 을 기록해 둔다
    var s0 = await Store.getSession();
    var tab0 = s0 && s0.sessionId === sessionId ? await getTab(s0.shadowTabId) : null;
    var currentUrl = tab0 ? (tab0.url || '') : '';
    var res = await Store.mutate(function (s) {
        if (!isCurrent(s, sessionId, requestId, ACTIVE_PHASES)) return ABORT;
        var req = s.currentRequest;
        var budget = s.settings.navigation.reloadRetryCount;
        if (req.reloadsUsed < budget) {
            req.reloadsUsed += 1;
            var r = currentResult(s);
            r.attempts += 1;
            var entry = currentEntry(s);
            var newReq = { requestId: Store.uuid(), startedAt: nowIso(), deadlineAt: null, reloadsUsed: req.reloadsUsed, injected: false, alwaysReloaded: req.alwaysReloaded };
            s.currentRequest = newReq;
            tabId = s.shadowTabId;
            // 목표 문서가 아직 로드되지 않았거나(URL 이 틀림/로딩 지연) 이동 오류면 목표 URL 로 다시 이동하고,
            // 문서는 로드됐는데 content script 가 응답하지 않는 경우 등에는 hard reload 한다.
            // (커밋되지 않은 이동 중에 reload 하면 "이전 페이지"가 다시 로드될 수 있다)
            action = (failType === 'unexpected_redirect' || failType === 'navigation_timeout' || failType === 'navigation_error') ? 'navigate' : 'reload';
            s.navigation = { targetUrl: entry.url, fromUrl: currentUrl, issuedAt: nowIso(), sawLoading: false };
            setPhase(s, 'waiting_for_document');
            return { recovering: true, newRequestId: newReq.requestId, url: entry.url, waitMs: s.settings.navigation.navigationTimeoutMs };
        }
        recordFailure(s, { type: failType, status: info.status || (/timeout/.test(failType) ? 'timeout' : 'failed'), finalUrl: info.finalUrl, details: info.details, message: info.message });
        return { recovering: false };
    });
    if (res.aborted) return;
    if (!res.value.recovering) { await advance(sessionId); return; }
    await log('warn', 'recover_' + action, { reason: failType });
    try {
        if (action === 'navigate') await chrome.tabs.update(tabId, { url: res.value.url });
        else await chrome.tabs.reload(tabId, { bypassCache: true });
    } catch (_) { /* watchdog 이 처리 */ }
    scheduleTick((res.value.waitMs || 30000) + 500);
}

/** handshake 실패: (1) content script 재주입 -> (2) reload -> (3) 실패 기록 */
async function onHandshakeTimeout(sessionId, requestId) {
    var inject = await Store.mutate(function (s) {
        if (!isCurrent(s, sessionId, requestId, ['handshaking'])) return ABORT;
        if (!s.currentRequest.injected) {
            s.currentRequest.injected = true;
            setPhase(s, 'handshaking'); // handshake 창을 새로 연다
            return { tabId: s.shadowTabId };
        }
        return { exhausted: true };
    });
    if (inject.aborted) return;
    if (inject.value.exhausted) {
        await recoverOrFail(sessionId, requestId, 'handshake_timeout', { status: 'timeout' });
        return;
    }
    // 복구 경로: 선언된 content script 가 주입되지 않았을 때(확장프로그램 재로드 직후 등) 같은 파일을 직접 주입한다.
    // content.js 에 재주입 guard 가 있어 listener 가 중복 등록되지 않는다.
    try {
        await chrome.scripting.executeScript({ target: { tabId: inject.value.tabId }, files: CONTENT_FILES });
    } catch (e) {
        await log('warn', 'inject_failed', { message: String(e && e.message || e) });
    }
    await log('warn', 'recover_inject');
    await performHandshake(sessionId, requestId);
}

async function onNavigationTimeout(sessionId, requestId) {
    await recoverOrFail(sessionId, requestId, 'navigation_timeout', { status: 'timeout' });
}

async function onSectionTimeout(sessionId, requestId) {
    await recoverOrFail(sessionId, requestId, 'section_timeout', { status: 'timeout' });
}

/** 세션 전체를 interrupted 로 전환(탭이 닫힘/브라우저 재시작 등). 결과는 유지한다. */
async function interruptSession(type, message) {
    var res = await Store.mutate(function (s) {
        if (!s || s.status !== 'running') return ABORT;
        var r = currentResult(s);
        if (r && r.status === 'running') {
            r.status = 'interrupted';
            r.finishedAt = nowIso();
            r.error = makeError(s, type, message);
            s.lastError = r.error;
        }
        s.status = 'interrupted';
        s.pauseReason = type;
        s.shadowTabId = null;
        s.currentRequest = null;
        s.navigation = null;
        setPhase(s, 'idle');
        return true;
    });
    if (res.aborted) return;
    shadowCache.tabId = null;
    await clearWatchdog();
    await log('warn', 'session_interrupted', { type: type });
}

// watchdog tick
async function watchdogTick() {
    var s = await Store.getSession();
    if (!s || s.status !== 'running') { await clearWatchdog(); return; }
    var now = Date.now();
    var sessionId = s.sessionId;
    var requestId = s.currentRequest ? s.currentRequest.requestId : null;
    var age = now - (Date.parse(s.phaseStartedAt) || now);
    var nav = s.settings.navigation;

    if (s.shadowTabId != null && ACTIVE_PHASES.indexOf(s.phase) >= 0) {
        var tab = await getTab(s.shadowTabId);
        if (!tab) { await interruptSession('session_interrupted', 'Shadow Tab 이 닫혀 작업이 중단되었습니다.'); return; }
    }

    switch (s.phase) {
        case 'navigating':
            if (age > TRANSITION_STALE_MS) await issueNavigation(sessionId, requestId);
            break;
        case 'waiting_for_document':
            if (age > nav.navigationTimeoutMs) await onNavigationTimeout(sessionId, requestId);
            else await checkDocumentReady();
            break;
        case 'handshaking':
            if (age > nav.handshakeTimeoutMs + TRANSITION_STALE_MS) await onHandshakeTimeout(sessionId, requestId);
            break;
        case 'waiting_for_root':
        case 'extracting':
            if (s.currentRequest && s.currentRequest.deadlineAt && now > s.currentRequest.deadlineAt + RUN_GRACE_MS) await onSectionTimeout(sessionId, requestId);
            break;
        case 'saving_result':
            if (age > TRANSITION_STALE_MS) await advance(sessionId);
            break;
        case 'idle':
        case 'preparing':
        case 'advancing':
            if (age > TRANSITION_STALE_MS) await startNextSection();
            break;
        default:
            break;
    }
}

// content script 메시지 (GSE_PROGRESS / GSE_RESULT)
async function onProgress(msg, sender) {
    if (!sender.tab || (msg.phase !== 'waiting_for_root' && msg.phase !== 'extracting')) return { ok: true };
    await Store.mutate(function (s) {
        if (!isCurrent(s, msg.sessionId, msg.requestId, ['handshaking', 'waiting_for_root', 'extracting'])) return ABORT;
        if (s.shadowTabId !== sender.tab.id) return ABORT;
        if (s.phase === msg.phase) return ABORT;
        if (s.phase === 'extracting') return ABORT; // 뒤로 가지 않는다
        setPhase(s, msg.phase);
        return true;
    });
    return { ok: true };
}

async function onResult(msg, sender) {
    if (!sender.tab) return { ok: false };
    var sessionId = msg.sessionId;
    var requestId = msg.requestId;
    var mapped = null; // 실패 매핑 결과(후속 처리용)

    var res;
    try {
        res = await Store.mutate(function (s, ctx) {
            if (!isCurrent(s, sessionId, requestId, ['handshaking', 'waiting_for_root', 'extracting'])) return ABORT;
            if (s.shadowTabId !== sender.tab.id) return ABORT;
            var entry = currentEntry(s);
            if (!entry || String(entry.id) !== String(msg.sectionId)) return ABORT;
            var r = currentResult(s);

            if (msg.ok && msg.data) {
                var scrubbed = Sec.scrubDeep(msg.data).value;               // 저장 직전 재검사
                var sized = Store.enforceSizeLimit(scrubbed, s.settings.extraction.maxSectionBytes);
                ctx.setData(Store.dataKeyFor(entry), sized.data);
                r.status = 'success';
                r.hasData = true;
                r.finishedAt = nowIso();
                r.error = null;
                r.warnings = (msg.warnings || []).slice(0, 20);
                if (sized.trimmed) r.warnings.push('size_limit_applied');
                s.currentRequest = null;
                setPhase(s, 'saving_result');
                return { saved: true };
            }

            var err = msg.error || { type: 'unknown_error', message: MESSAGES.unknown_error };
            var verdict = err.type === 'page_blocked' || err.type === 'root_not_found' ? classifyPageInfo(msg.diagnostics) : null;
            if (verdict && verdict.action === 'pause') { mapped = { pause: true, type: verdict.type, page: msg.diagnostics }; return { mapped: true }; }
            var type = verdict ? verdict.type
                : (err.type === 'page_blocked' ? ((msg.diagnostics && msg.diagnostics.httpStatus >= 400) ? 'http_error' : 'extraction_error') : err.type);
            var status = (type === 'section_timeout' || type === 'dom_stability_timeout') ? 'timeout' : 'failed';
            recordFailure(s, { type: type, status: status, message: err.message, finalUrl: msg.url, details: diagnosticsOf(msg.diagnostics) });
            return { failed: true };
        });
    } catch (e) {
        // 저장 실패(예: 저장 공간 초과): 성공으로 오인하지 않도록 실패로 기록
        await failCurrent(sessionId, requestId, { type: 'storage_error', status: 'failed', message: MESSAGES.storage_error + ' (' + (e && e.message) + ')' });
        return { ok: true };
    }
    if (res.aborted) return { ok: true, ignored: true }; // 늦은/중복 응답 폐기

    if (mapped && mapped.pause) {
        await pauseCurrent(sessionId, requestId, { type: mapped.type, finalUrl: msg.url, details: diagnosticsOf(mapped.page) });
        return { ok: true };
    }
    await log(res.value && res.value.saved ? 'info' : 'warn', res.value && res.value.saved ? 'section_saved' : 'section_failed', { sectionId: msg.sectionId });
    await advance(sessionId);
    return { ok: true };
}

// popup 메시지 API
async function buildState(payload) {
    var s = await Store.getSession();
    var cfg = self.GSE_CONFIG;
    var out = {
        ok: true,
        config: {
            sections: (cfg.sections || []).map(function (x) { return { id: x.id, name: x.name, path: x.path, enabled: !(x.options && x.options.enabled === false) }; }),
            metadataEnabled: !!(cfg.metadata && cfg.metadata.enabled),
            errors: validateConfig(cfg)
        },
        candidate: parseRepoFromUrl(payload && payload.activeTabUrl),
        session: null
    };
    if (!s) return out;
    var cur = s.currentSectionIndex != null ? s.results[s.currentSectionIndex] : null;
    out.session = {
        sessionId: s.sessionId,
        status: s.status,
        phase: s.phase,
        pauseReason: s.pauseReason,
        repository: s.repository,
        startedAt: s.startedAt,
        updatedAt: s.updatedAt,
        finishedAt: s.finishedAt,
        hasShadowTab: s.shadowTabId != null,
        progress: Store.computeProgress(s),
        summary: Store.computeSummary(s),
        current: cur ? { id: cur.id, name: cur.name, status: cur.status, attempts: cur.attempts } : null,
        metadataStatus: (function () { var m = s.results.filter(function (r) { return r.kind === 'metadata'; })[0]; return m ? m.status : null; })(),
        resumable: s.status !== 'running' && Store.countResumable(s) > 0,
        lastError: s.lastError ? { type: s.lastError.type, message: s.lastError.message, sectionName: s.lastError.sectionName } : null,
        results: s.results.filter(function (r) { return r.kind === 'section'; }).map(function (r) {
            return { id: r.id, name: r.name, status: r.status, attempts: r.attempts, error: r.error ? { type: r.error.type, message: r.error.message } : null, skipReason: r.skipReason || null };
        })
    };
    return out;
}

async function buildExportPayload(format) {
    var s = await Store.getSession();
    if (!s) return { ok: false, error: 'no_session', message: '저장된 결과가 없습니다.' };
    var data = await Store.getAllData(s);
    var exp = Fmt.buildExport(s, data);
    return { ok: true, format: format, text: format === 'json' ? Fmt.toJson(exp) : Fmt.toTxt(exp), generatedAt: exp.generatedAt };
}

async function focusShadowTab() {
    var s = await Store.getSession();
    if (!s || s.shadowTabId == null) return { ok: false, message: 'Shadow Tab 이 없습니다.' };
    var tab = await getTab(s.shadowTabId);
    if (!tab) return { ok: false, message: 'Shadow Tab 이 이미 닫혔습니다.' };
    try {
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
    } catch (e) { return { ok: false, message: String(e && e.message || e) }; }
    return { ok: true };
}

async function handlePopupMessage(msg) {
    switch (msg.type) {
        case 'GSE_GET_STATE': return buildState(msg);
        case 'GSE_START': return startSession(msg);
        case 'GSE_RESUME': return resumeSession();
        case 'GSE_STOP': return stopSession();
        case 'GSE_RESET': return resetSession();
        case 'GSE_GET_EXPORT': return buildExportPayload(msg.format === 'json' ? 'json' : 'txt');
        case 'GSE_FOCUS_SHADOW_TAB': return focusShadowTab();
        default: return { ok: false, error: 'unknown_message', message: String(msg.type) };
    }
}

var POPUP_TYPES = ['GSE_GET_STATE', 'GSE_START', 'GSE_RESUME', 'GSE_STOP', 'GSE_RESET', 'GSE_GET_EXPORT', 'GSE_FOCUS_SHADOW_TAB'];

// 이벤트 listener (service worker 가 깨어나려면 최상위에서 동기적으로 등록해야 한다)
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string' || msg.type.indexOf('GSE_') !== 0) return false;
    if (sender.id && sender.id !== chrome.runtime.id) return false;

    var handler;
    if (msg.type === 'GSE_PROGRESS') handler = onProgress(msg, sender);
    else if (msg.type === 'GSE_RESULT') handler = onResult(msg, sender);
    else if (POPUP_TYPES.indexOf(msg.type) >= 0) {
        if (sender.tab) { sendResponse({ ok: false, error: 'forbidden', message: 'content script 에서는 사용할 수 없는 요청입니다.' }); return false; }
        handler = handlePopupMessage(msg);
    } else return false;

    Promise.resolve(handler).then(sendResponse, function (e) {
        sendResponse({ ok: false, error: 'exception', message: String(e && e.message || e) });
    });
    return true; // 비동기 응답
});

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
    if (!changeInfo || (changeInfo.status === undefined && changeInfo.url === undefined)) return;
    getShadowTabIdCached().then(function (shadowId) {
        if (shadowId == null || shadowId !== tabId) return;
        if (changeInfo.status === 'loading') {
            return Store.mutate(function (s) {
                if (!s || s.status !== 'running' || s.phase !== 'waiting_for_document' || !s.navigation || s.navigation.sawLoading) return ABORT;
                s.navigation.sawLoading = true;
                return true;
            });
        }
        if (changeInfo.status === 'complete') return checkDocumentReady();
    }).catch(onDriveError);
});

chrome.tabs.onRemoved.addListener(function (tabId) {
    getShadowTabIdCached().then(function (shadowId) {
        if (shadowId == null || shadowId !== tabId) return;
        return interruptSession('session_interrupted', 'Shadow Tab 이 닫혀 작업이 중단되었습니다. "이어받기"로 계속할 수 있습니다.');
    }).catch(onDriveError);
});

chrome.alarms.onAlarm.addListener(function (alarm) {
    if (alarm.name === ALARM_WATCHDOG) watchdogTick().catch(onDriveError);
});

// 브라우저 재시작/확장프로그램 업데이트: Shadow Tab 과 content script 컨텍스트가 무효이므로 실행 중이던 세션은 interrupted 로 보존한다.
// (일반적인 service worker 재시작은 이 이벤트를 발생시키지 않으므로 작업이 계속된다)
function recoverAfterRestart(reason) {
    return Store.mutate(function (s) {
        if (!s || s.status !== 'running') return ABORT;
        var r = currentResult(s);
        if (r && r.status === 'running') {
            r.status = 'interrupted';
            r.finishedAt = nowIso();
            r.error = makeError(s, 'session_interrupted', '브라우저/확장프로그램이 재시작되어 작업이 중단되었습니다(' + reason + '). "이어받기"로 계속할 수 있습니다.');
            s.lastError = r.error;
        }
        s.status = 'interrupted';
        s.pauseReason = 'session_interrupted';
        s.shadowTabId = null;
        s.currentRequest = null;
        s.navigation = null;
        setPhase(s, 'idle');
        return true;
    }).then(function () { shadowCache.loaded = false; return clearWatchdog(); }).catch(onDriveError);
}
chrome.runtime.onStartup.addListener(function () { recoverAfterRestart('startup'); });
chrome.runtime.onInstalled.addListener(function (details) { recoverAfterRestart(details && details.reason || 'installed'); });
