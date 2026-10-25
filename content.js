/*
 * GitHub Settings Exporter - content.js  (github.com 페이지에 주입되는 content script)
 *
 * 평소(사용자가 GitHub 를 일반적으로 쓸 때)에는 메시지 listener 만 등록하고 DOM 을 건드리지 않는다.
 * background 가 Shadow Tab 에 요청했을 때만 동작한다.
 *
 * 메시지 (background -> content)
 *   GSE_PING   handshake. { ok, version, url, readyState, page:{httpStatus,hints} } 로 응답
 *   GSE_RUN    추출 작업 시작. 즉시 { ok, accepted } 로 ack 하고, 작업이 끝나면 GSE_RESULT 를 별도 메시지로 보낸다
 *   GSE_CANCEL 진행 중인 작업 취소(관찰자/타이머 정리)
 * 메시지 (content -> background)
 *   GSE_PROGRESS { sessionId, requestId, sectionId, phase }
 *   GSE_RESULT   { sessionId, requestId, sectionId, kind, url, ok, data?, error?, diagnostics?, warnings? }
 *
 * 재주입 guard: 이 파일이 같은 컨텍스트에 다시 실행되어도 listener 는 한 번만 등록된다
 * (scripting.executeScript 복구 경로 때문에 중요).
 */
(function (global) {
    'use strict';
    if (global.__GSE_CONTENT__) return;

    var VERSION = '1.0.0';
    var Sec = global.GSE_Security;
    var Ex = global.GSE_Extractor;
    var Meta = global.GSE_Metadata;
    if (!Sec || !Ex) return;

    var state = { version: VERSION, jobs: new Map() };
    global.__GSE_CONTENT__ = state;

    // root 탐색/안정화에서 관찰할 속성(클래스/스타일 변화는 애니메이션 소음이 크므로 제외)
    var ATTR_FILTER = ['aria-expanded', 'aria-checked', 'aria-selected', 'aria-pressed', 'aria-disabled', 'aria-hidden',
        'disabled', 'checked', 'hidden', 'open', 'value', 'selected'];

    var LOGIN_PATH_RE = /^\/(login|logout|session|sessions|signup|join|password_reset|two-factor)(\/|$)/i;
    var SSO_PATH_RE = /^\/(orgs|enterprises)\/[^/]+\/sso(\/|$)/i;

    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    function pathKey(u) {
        try { var x = new URL(u); return (x.origin + x.pathname.replace(/\/+$/, '')).toLowerCase(); } catch (_) { return String(u); }
    }
    function sameUrl(a, b) { return pathKey(a) === pathKey(b); }

    // 현재 페이지 분류(로그인/CAPTCHA/HTTP 상태). 우회하지 않고 "감지"만 한다.
    function classifyPage() {
        var hints = [];
        var httpStatus = null;
        var path = location.pathname;
        try {
            var nav = performance.getEntriesByType('navigation')[0];
            if (nav && typeof nav.responseStatus === 'number' && nav.responseStatus > 0) httpStatus = nav.responseStatus;
        } catch (_) {}
        if (location.hostname !== 'github.com') hints.push('off_github');
        if (LOGIN_PATH_RE.test(path) || SSO_PATH_RE.test(path)) hints.push('login_path');
        try {
            if (document.querySelector('form[action^="/session"] input[type="password"], form[action*="/sessions/"] input[type="password"]')) hints.push('login_form');
        } catch (_) {}
        try {
            // 숨겨진 captcha 필드(일반 페이지에도 있을 수 있음)로 오탐하지 않도록 "화면에 보이는" 요소만 센다
            var cands = document.querySelectorAll('iframe[src*="arkoselabs" i], iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[src*="captcha" i], [id*="captcha" i], [class*="captcha" i], [data-captcha]');
            for (var ci = 0; ci < cands.length; ci++) { if (isVisibleEl(cands[ci])) { hints.push('captcha'); break; } }
        } catch (_) {}
        return { url: location.href, path: path, httpStatus: httpStatus, hints: hints, title: (document.title || '').slice(0, 120) };
    }

    function isVisibleEl(el) {
        try {
            if (el.hidden) return false;
            if (typeof el.checkVisibility === 'function') return el.checkVisibility();
            var cs = getComputedStyle(el);
            return cs.display !== 'none' && cs.visibility !== 'hidden';
        } catch (_) { return false; }
    }

    function looksBlocked(page) {
        return page.hints.length > 0 || (typeof page.httpStatus === 'number' && page.httpStatus >= 400);
    }

    function blockedMessage(page) {
        return '정상적인 설정 페이지가 아닙니다(HTTP ' + (page.httpStatus == null ? '?' : page.httpStatus) + ', 감지: ' + (page.hints.join(',') || '없음') + ').';
    }

    // background 로 전송
    async function sendToBackground(message, attempts) {
        attempts = attempts || 1;
        for (var i = 0; i < attempts; i++) {
            try {
                await chrome.runtime.sendMessage(message);
                return true;
            } catch (_) {
                if (i < attempts - 1) await sleep(400 * (i + 1));
            }
        }
        return false;
    }

    function sendProgress(msg, phase) {
        sendToBackground({ type: 'GSE_PROGRESS', sessionId: msg.sessionId, requestId: msg.requestId, sectionId: msg.sectionId, phase: phase, url: location.href }, 1);
    }

    function fail(type, message, diagnostics) {
        var r = { ok: false, error: { type: type, message: message } };
        if (diagnostics) r.diagnostics = diagnostics;
        return r;
    }

    // job 수명 관리: 모든 observer / timer 는 cleanups 에 등록되어 job 종료 시 반드시 정리된다
    function runCleanups(job) {
        var list = job.cleanups.splice(0, job.cleanups.length);
        list.forEach(function (fn) { try { fn(); } catch (_) {} });
    }
    function cancelJob(job) {
        job.cancelled = true;
        runCleanups(job);
    }

    // root 탐색: 일반 DOM -> (없으면) 열린 Shadow DOM 까지
    function findRoot(selector) {
        var el = document.querySelector(selector); // 잘못된 selector 면 SyntaxError
        if (el) return el;
        return Ex.deepQuerySelector(document, selector, { onError: function (s, e) { throw e; } });
    }

    function waitForRoot(job, selector, timeoutMs) {
        return new Promise(function (resolve) {
            var done = false, mo = null, iv = null, to = null;
            function cleanup() {
                if (mo) { mo.disconnect(); mo = null; }
                if (iv) { clearInterval(iv); iv = null; }
                if (to) { clearTimeout(to); to = null; }
            }
            function finish(res) { if (done) return; done = true; cleanup(); resolve(res); }
            job.cleanups.push(function () { finish({ cancelled: true }); });
            function check() {
                if (job.cancelled) return finish({ cancelled: true });
                try {
                    var el = findRoot(selector);
                    if (el) finish({ el: el });
                } catch (e) { finish({ error: e }); }
            }
            check();
            if (done) return;
            mo = new MutationObserver(check);
            mo.observe(document.documentElement, { childList: true, subtree: true });
            iv = setInterval(check, 250);
            to = setTimeout(function () { finish({ el: null, timedOut: true }); }, Math.max(1, timeoutMs));
        });
    }

    /** root subtree 의 변경이 stableMs 동안 없으면 안정. timeoutMs 를 넘기면 stable=false 로 반환(무한 대기 없음). */
    function waitForStable(job, selector, rootEl, stableMs, timeoutMs) {
        return new Promise(function (resolve) {
            var done = false, mo = null, iv = null;
            var root = rootEl;
            var startedAt = Date.now();
            var lastChange = startedAt;
            function cleanup() {
                if (mo) { mo.disconnect(); mo = null; }
                if (iv) { clearInterval(iv); iv = null; }
            }
            function finish(stable) { if (done) return; done = true; cleanup(); resolve({ stable: stable, root: root }); }
            job.cleanups.push(function () { finish(false); });
            function observe() {
                if (mo) mo.disconnect();
                mo = new MutationObserver(function () { lastChange = Date.now(); });
                mo.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTR_FILTER });
            }
            observe();
            iv = setInterval(function () {
                if (job.cancelled) return finish(false);
                var t = Date.now();
                if (!root.isConnected) {
                    // React/Turbo 가 root 를 교체했을 수 있다: 다시 찾는다
                    var r2 = null;
                    try { r2 = findRoot(selector); } catch (_) {}
                    if (r2) { root = r2; observe(); lastChange = t; }
                } else if (t - lastChange >= stableMs) {
                    return finish(true);
                }
                if (t - startedAt >= timeoutMs) finish(false);
            }, 100);
        });
    }

    // expand action: <details> 열기 / aria-expanded="false" 펼침 컨트롤 누르기만 허용
    async function runActions(job, selector, holder, actions, ex, remaining) {
        var report = [];
        var cap = Number(ex.maxExpandPerAction) > 0 ? Number(ex.maxExpandPerAction) : 25;
        for (var i = 0; i < actions.length; i++) {
            var a = actions[i] || {};
            var entry = { index: i, type: a.type, selector: a.selector, matched: 0, performed: 0, skipped: {}, errors: [] };
            report.push(entry);
            if (a.type !== 'expand') { entry.errors.push('unsupported_action_type (only "expand" is supported)'); continue; }
            if (typeof a.selector !== 'string' || !a.selector.trim()) { entry.errors.push('missing_selector'); continue; }
            var els = Ex.deepQuerySelectorAll(holder.root, a.selector, { onError: function (s, e) { entry.errors.push('selector_error: ' + (e && e.message)); } });
            entry.matched = els.length;
            var limit = Math.min(Number(a.maxCount) > 0 ? Number(a.maxCount) : cap, cap);
            for (var j = 0; j < els.length && entry.performed < limit; j++) {
                if (job.cancelled) return report;
                var el = els[j];
                var verdict = Ex.checkExpandSafety(el, a);
                if (!verdict.ok) { entry.skipped[verdict.reason] = (entry.skipped[verdict.reason] || 0) + 1; continue; }
                try {
                    if (el.localName === 'details') el.open = true;
                    else if (el.localName === 'summary' && el.getAttribute('aria-expanded') == null) el.parentElement.open = true;
                    else el.click();
                    entry.performed++;
                } catch (e) { entry.errors.push(String(e && e.message || e)); }
            }
            if (entry.performed > 0) {
                var wait = Number(a.waitAfterMs);
                await sleep(Math.max(0, Math.min(isFinite(wait) ? wait : 500, 5000)));
                if (job.cancelled) return report;
                var budget = Math.min(5000, remaining());
                if (budget > 0) {
                    var st = await waitForStable(job, selector, holder.root, Math.min(Number(ex.domStableTimeMs) || 1000, 1000), budget);
                    holder.root = st.root;
                }
            }
        }
        return report;
    }

    // 작업 실행
    async function executeJob(job, msg) {
        var ex = (msg.settings && msg.settings.extraction) || {};
        var sc = (msg.settings && msg.settings.security) || {};
        var section = msg.section || {};
        var selectors = section.selectors || {};
        var deadlineAt = Number(msg.deadlineAt) || (Date.now() + (Number(section.timeoutMs) || 30000));
        function remaining() { return deadlineAt - Date.now(); }

        var page = classifyPage();
        if (looksBlocked(page)) return fail('page_blocked', blockedMessage(page), page);
        if (msg.expectedUrl && !sameUrl(location.href, msg.expectedUrl)) {
            return fail('unexpected_redirect', '예상한 URL이 아닙니다: ' + location.pathname, page);
        }
        var selector = selectors.root;
        if (typeof selector !== 'string' || !selector.trim()) return fail('invalid_root_selector', 'selectors.root 가 비어 있습니다.', page);

        // 1) root
        sendProgress(msg, 'waiting_for_root');
        var rootTimeout = Number(ex.rootTimeoutMs) || 15000;
        var rootBudget = Math.max(1, Math.min(rootTimeout, remaining()));
        var rootRes = await waitForRoot(job, selector, rootBudget);
        if (job.cancelled || rootRes.cancelled) return null;
        if (rootRes.error) return fail('invalid_root_selector', 'root selector 오류: ' + (rootRes.error.message || rootRes.error), page);
        if (!rootRes.el) {
            page = classifyPage();
            if (looksBlocked(page)) return fail('page_blocked', blockedMessage(page), page);
            if (rootBudget < rootTimeout) return fail('section_timeout', 'Section 시간 예산이 소진되어 root 를 찾지 못했습니다: ' + selector, page);
            return fail('root_not_found', '설정 컨테이너를 찾을 수 없음: ' + selector, page);
        }

        // 2) DOM 안정화
        var stBudget = Math.min(Number(ex.domStableTimeoutMs) || 15000, remaining());
        if (stBudget <= 0) return fail('section_timeout', 'Section 시간 예산이 소진되었습니다.', page);
        var st = await waitForStable(job, selector, rootRes.el, Number(ex.domStableTimeMs) || 1000, stBudget);
        if (job.cancelled) return null;
        var warnings = [];
        if (!st.stable) {
            if (ex.onDomStabilityTimeout === 'fail') return fail('dom_stability_timeout', 'DOM 이 제한 시간 안에 안정화되지 않았습니다.', page);
            warnings.push('dom_stability_timeout');
        }
        var holder = { root: st.root };

        // 3) metadata 단계는 root 와 무관하게 document 의 "보이는 정보"만 읽는다
        sendProgress(msg, 'extracting');
        if (msg.kind === 'metadata') {
            if (!Meta) return fail('extraction_error', 'metadata 모듈을 사용할 수 없습니다.', page);
            return { ok: true, data: Meta.extract(document), warnings: warnings };
        }

        // 4) 사용자가 명시한 안전한 펼침 동작
        var actions = Array.isArray(section.actions) ? section.actions : [];
        var actionReport = [];
        if (actions.length) {
            actionReport = await runActions(job, selector, holder, actions, ex, remaining);
            if (job.cancelled) return null;
        }

        // 5) 추출 (root subtree 안에서만)
        var data = Ex.extract(holder.root, {
            includeHiddenElements: ex.includeHiddenElements,
            skipHiddenInputs: sc.skipHiddenInputs,
            redactSensitiveValues: sc.redactSensitiveValues,
            ignoreSelectors: selectors.ignore,
            ignoreTags: ex.ignoreTags,
            maxItemsPerSection: ex.maxItemsPerSection,
            maxTextBlocks: ex.maxTextBlocks,
            maxStringLength: ex.maxStringLength,
            ignoreTextPatterns: ex.ignoreTextPatterns
        });
        data.meta.actions = actionReport;
        data.meta.stability = { stable: st.stable };
        data.meta.rootSelector = selector;
        data.meta.warnings = (data.meta.warnings || []).concat(warnings);
        return { ok: true, data: data, warnings: warnings };
    }

    async function runJob(job, msg) {
        var result;
        try {
            result = await executeJob(job, msg);
        } catch (e) {
            result = fail('extraction_error', '추출 중 오류: ' + (e && e.message ? e.message : e), classifyPage());
        } finally {
            runCleanups(job);
        }
        if (job.cancelled || !result) { job.done = true; return; }
        var out = Object.assign({
            type: 'GSE_RESULT', sessionId: msg.sessionId, requestId: msg.requestId, sectionId: msg.sectionId, kind: msg.kind, url: location.href
        }, result);
        if (out.ok && out.data) out.data = Sec.scrubDeep(out.data).value;
        job.done = true;
        job.result = out;
        await sendToBackground(out, 4);
    }

    // 메시지 처리
    function handlePing(msg) {
        return {
            ok: true, version: VERSION, url: location.href, readyState: document.readyState,
            sessionId: msg.sessionId || null, requestId: msg.requestId || null, page: classifyPage()
        };
    }

    function handleRun(msg) {
        if (!msg.requestId || !msg.sessionId) return { ok: false, error: 'missing_ids' };
        var existing = state.jobs.get(msg.requestId);
        if (existing) {
            // 같은 요청의 재전송(background 가 재시작되어 ack 를 못 받은 경우): 중복 실행하지 않는다
            if (existing.done && existing.result) sendToBackground(existing.result, 4);
            return { ok: true, accepted: true, duplicate: true };
        }
        state.jobs.forEach(function (j) { if (!j.done) cancelJob(j); });
        var job = { requestId: msg.requestId, sessionId: msg.sessionId, cancelled: false, done: false, result: null, cleanups: [] };
        state.jobs.set(msg.requestId, job);
        if (state.jobs.size > 4) {
            var oldest = state.jobs.keys().next().value;
            state.jobs.delete(oldest);
        }
        runJob(job, msg).catch(function () { /* runJob 은 내부에서 모든 오류를 처리한다 */ });
        return { ok: true, accepted: true };
    }

    function handleCancel() {
        state.jobs.forEach(function (j) { if (!j.done) cancelJob(j); });
        return { ok: true };
    }

    function onMessage(msg, sender, sendResponse) {
        if (!msg || typeof msg.type !== 'string' || msg.type.indexOf('GSE_') !== 0) return false;
        try {
            if (msg.type === 'GSE_PING') sendResponse(handlePing(msg));
            else if (msg.type === 'GSE_RUN') sendResponse(handleRun(msg));
            else if (msg.type === 'GSE_CANCEL') sendResponse(handleCancel(msg));
            else return false;
        } catch (e) {
            sendResponse({ ok: false, error: String(e && e.message || e) });
        }
        return false;
    }

    chrome.runtime.onMessage.addListener(onMessage);
})(typeof globalThis !== 'undefined' ? globalThis : self);
