/*
 * GitHub Settings Exporter - storage.js  (service worker 전용: importScripts 로 로드)
 *
 * chrome.storage.local 에 세션 상태를 저장/복원한다.
 *   gse:session        세션 메타 + 각 Section 결과의 "메타"(status, attempts, error ...). 큰 데이터는 넣지 않는다.
 *   gse:data:<key>     Section 별 정규화 결과(data). key = "s<sectionId>" 또는 "meta"
 *   gse:log            최소한의 실행 로그(링 버퍼)
 *
 * 동시성: service worker 안에서 여러 이벤트(메시지/탭 이벤트/알람)가 동시에 세션을 갱신할 수 있으므로
 * 모든 쓰기는 mutate() 를 통해 직렬화한다. mutate() 의 콜백은 "동기적으로 짧게" 상태만 바꾸고,
 * 탭 이동/메시지 전송 같은 부수효과는 콜백 밖에서 수행한다.
 * 결과 데이터와 세션 갱신은 한 번의 chrome.storage.local.set 으로 원자적으로 저장된다.
 */
(function (global) {
    'use strict';
    if (global.GSE_Storage) return;

    var Sec = global.GSE_Security;

    var KEY_SESSION = 'gse:session';
    var KEY_DATA_PREFIX = 'gse:data:';
    var KEY_LOG = 'gse:log';
    var SCHEMA_VERSION = 1;
    var LOG_MAX = 150;
    var ABORT = { __gseAbort: true };

    var DEFAULTS = {
        navigation: { mode: 'normal-with-hard-reload-fallback', navigationTimeoutMs: 30000, handshakeTimeoutMs: 10000, reloadRetryCount: 1 },
        extraction: {
            sectionTimeoutMs: 30000, rootTimeoutMs: 15000, domStableTimeMs: 1000, domStableTimeoutMs: 15000,
            onDomStabilityTimeout: 'proceed', includeHiddenElements: false, maxItemsPerSection: 3000, maxTextBlocks: 800,
            maxStringLength: 4000, maxSectionBytes: 1500000, ignoreTags: ['nav', 'footer'], ignoreTextPatterns: ['^Loading(\\.\\.\\.|…)?$'], maxExpandPerAction: 25
        },
        resume: { skipSuccessfulSections: true, retryFailedSections: true },
        metadata: { enabled: false, mode: 'visible-dom-only' },
        security: { redactSensitiveValues: true, skipHiddenInputs: true, neverExtractSecretValues: true }
    };

    function nowIso() { return new Date().toISOString(); }

    function uuid() {
        if (global.crypto && typeof global.crypto.randomUUID === 'function') return global.crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 3 | 8)).toString(16);
        });
    }

    function clone(o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); }
    function posInt(v, d) { var n = Number(v); return isFinite(n) && n > 0 ? Math.floor(n) : d; }

    // 직렬화 lock
    var chain = Promise.resolve();
    function withLock(fn) {
        var run = chain.then(function () { return fn(); });
        chain = run.catch(function () { /* 다음 작업은 계속 */ });
        return run;
    }

    // 읽기/쓰기
    function getSession() {
        return chrome.storage.local.get(KEY_SESSION).then(function (r) { return r[KEY_SESSION] || null; });
    }

    /**
     * 세션을 읽어 fn(session, ctx) 로 갱신하고 저장한다. fn 이 ABORT 를 반환하면 저장하지 않는다.
     * ctx.setData(key, data) / ctx.removeData(key) 는 세션 저장과 "같은 set 호출"로 반영된다(원자적).
     * @returns {Promise<{aborted:boolean, value:any, session:Object|null}>}
     */
    function mutate(fn) {
        return withLock(async function () {
            var session = await getSession();
            var writes = {};
            var removals = [];
            var ctx = {
                setData: function (key, data) { writes[KEY_DATA_PREFIX + key] = data; },
                removeData: function (key) { removals.push(KEY_DATA_PREFIX + key); }
            };
            var value = await fn(session, ctx);
            if (value === ABORT) return { aborted: true, value: undefined, session: session };
            if (session) session.updatedAt = nowIso();
            var toSet = Object.assign({}, writes);
            if (session) toSet[KEY_SESSION] = session;
            if (Object.keys(toSet).length) await chrome.storage.local.set(toSet);
            if (removals.length) await chrome.storage.local.remove(removals);
            return { aborted: false, value: value, session: session };
        });
    }

    /** 새 세션으로 교체한다. 이전 세션의 data 키는 모두 삭제한다(새로 시작). */
    function replaceSession(session) {
        return withLock(async function () {
            await removeDataKeys();
            await chrome.storage.local.set((function () { var o = {}; o[KEY_SESSION] = session; return o; })());
        });
    }

    async function removeDataKeys() {
        var all = await chrome.storage.local.get(null);
        var keys = Object.keys(all).filter(function (k) { return k.indexOf(KEY_DATA_PREFIX) === 0; });
        if (keys.length) await chrome.storage.local.remove(keys);
    }

    /** 세션/결과/로그 전체 삭제 */
    function clearAll() {
        return withLock(async function () {
            await removeDataKeys();
            await chrome.storage.local.remove([KEY_SESSION, KEY_LOG]);
        });
    }

    function dataKeyFor(entry) { return entry.kind === 'metadata' ? 'meta' : 's' + entry.id; }

    async function getAllData(session) {
        var keys = session.plan.map(function (e) { return KEY_DATA_PREFIX + dataKeyFor(e); });
        var r = await chrome.storage.local.get(keys);
        var out = {};
        session.plan.forEach(function (e) {
            var v = r[KEY_DATA_PREFIX + dataKeyFor(e)];
            if (v) out[dataKeyFor(e)] = v;
        });
        return out;
    }

    // 로그(링 버퍼). 민감한 값을 넣지 않는다: id/type/짧은 메시지만.
    function appendLog(level, message, data) {
        return withLock(async function () {
            var r = await chrome.storage.local.get(KEY_LOG);
            var arr = r[KEY_LOG] || [];
            var entry = { at: nowIso(), level: level, message: String(message).slice(0, 300) };
            if (data !== undefined) entry.data = Sec ? Sec.scrubDeep(data).value : data;
            arr.push(entry);
            if (arr.length > LOG_MAX) arr = arr.slice(arr.length - LOG_MAX);
            var o = {}; o[KEY_LOG] = arr;
            await chrome.storage.local.set(o);
        }).catch(function () { /* 로그 실패는 무시 */ });
    }

    function getLog() {
        return chrome.storage.local.get(KEY_LOG).then(function (r) { return r[KEY_LOG] || []; });
    }

    // 세션 생성 / 설정 스냅샷
    function snapshotSettings(cfg) {
        cfg = cfg || {};
        var s = {};
        Object.keys(DEFAULTS).forEach(function (k) {
            s[k] = Object.assign({}, clone(DEFAULTS[k]), clone(cfg[k] || {}));
        });
        s.security.neverExtractSecretValues = true; // 끌 수 없다
        return s;
    }

    function planEntryFromSection(sec, repo, settings) {
        var opts = sec.options || {};
        var selectors = sec.selectors || {};
        return {
            index: 0,
            kind: 'section',
            id: sec.id,
            name: String(sec.name),
            path: sec.path,
            url: repo.url + sec.path,
            selectors: { root: selectors.root, ignore: Array.isArray(selectors.ignore) ? selectors.ignore.slice() : [] },
            actions: clone(sec.actions || []),
            timeoutMs: posInt(opts.timeoutMs, settings.extraction.sectionTimeoutMs),
            enabled: opts.enabled !== false
        };
    }

    function newResult(entry) {
        var r = {
            index: entry.index, kind: entry.kind, id: entry.id, name: entry.name, path: entry.path, url: entry.url,
            status: entry.enabled ? 'pending' : 'skipped',
            attempts: 0, startedAt: null, finishedAt: null, hasData: false, error: null, warnings: [], history: []
        };
        if (!entry.enabled) r.skipReason = 'disabled';
        return r;
    }

    function reindex(session) {
        session.plan.forEach(function (e, i) { e.index = i; if (session.results[i]) session.results[i].index = i; });
    }

    function createSession(opts) {
        var settings = snapshotSettings(opts.config);
        var repo = opts.repository;
        var plan = [];
        if (settings.metadata.enabled) {
            plan.push({
                index: 0, kind: 'metadata', id: 'metadata', name: 'Repository metadata', path: '', url: repo.url,
                selectors: { root: 'body', ignore: [] }, actions: [], timeoutMs: settings.extraction.sectionTimeoutMs, enabled: true
            });
        }
        (opts.config.sections || []).forEach(function (sec) { plan.push(planEntryFromSection(sec, repo, settings)); });
        plan.forEach(function (e, i) { e.index = i; });
        var now = nowIso();
        return {
            schemaVersion: SCHEMA_VERSION,
            sessionId: uuid(),
            status: 'running',
            stopRequested: false,
            pauseReason: null,
            repository: { owner: repo.owner, name: repo.name, url: repo.url },
            originTabId: opts.originTabId == null ? null : opts.originTabId,
            settings: settings,
            plan: plan,
            results: plan.map(newResult),
            currentSectionIndex: null,
            nextSectionIndex: 0,
            phase: 'preparing',
            phaseStartedAt: now,
            shadowTabId: null,
            currentRequest: null,
            navigation: null,
            startedAt: now,
            updatedAt: now,
            finishedAt: null,
            lastProgressAt: now,
            lastError: null
        };
    }

    // 이어받기
    function shouldRun(entry, r, settings) {
        if (entry.kind === 'section' && !entry.enabled) return false;
        switch (r.status) {
            case 'success': return !settings.resume.skipSuccessfulSections;
            case 'skipped': return !!entry.enabled;
            case 'failed':
            case 'timeout': return !!settings.resume.retryFailedSections;
            default: return true; // pending / running / interrupted
        }
    }

    /** 현재 config 를 반영한다: 설정 스냅샷 갱신 + 같은 id 의 Section 정의(selector/path/actions/timeout/enabled) 갱신 + 새 Section 추가 */
    function reconcileWithConfig(session, config) {
        session.settings = snapshotSettings(config);
        var byId = {};
        (config.sections || []).forEach(function (sec) { byId[String(sec.id)] = sec; });
        session.plan.forEach(function (entry, i) {
            if (entry.kind !== 'section') return;
            var sec = byId[String(entry.id)];
            if (!sec) return;
            var fresh = planEntryFromSection(sec, session.repository, session.settings);
            fresh.index = i;
            session.plan[i] = fresh;
            var r = session.results[i];
            r.name = fresh.name; r.path = fresh.path; r.url = fresh.url;
        });
        (config.sections || []).forEach(function (sec) {
            var exists = session.plan.some(function (e) { return e.kind === 'section' && String(e.id) === String(sec.id); });
            if (!exists) {
                var entry = planEntryFromSection(sec, session.repository, session.settings);
                session.plan.push(entry);
                session.results.push(newResult(entry));
            }
        });
        reindex(session);
    }

    function firstPendingIndex(session) {
        for (var i = 0; i < session.results.length; i++) if (session.results[i].status === 'pending') return i;
        return -1;
    }

    function countResumable(session) {
        var n = 0;
        session.plan.forEach(function (entry, i) {
            if (shouldRun(entry, session.results[i], session.settings)) n++;
        });
        return n;
    }

    /** 이어받기 준비: 다시 실행할 Section 을 pending 으로 되돌린다. 이전 실패 기록은 history 에 남긴다. */
    function prepareResume(session) {
        session.plan.forEach(function (entry, i) {
            var r = session.results[i];
            if (entry.kind === 'section' && !entry.enabled) {
                if (r.status !== 'success') { r.status = 'skipped'; r.skipReason = 'disabled'; }
                return;
            }
            if (!shouldRun(entry, r, session.settings) || r.status === 'pending') return;
            if (r.status === 'failed' || r.status === 'timeout' || r.status === 'interrupted' || r.status === 'success') {
                r.history = (r.history || []).concat([{
                    status: r.status, error: r.error || null, startedAt: r.startedAt, finishedAt: r.finishedAt, attempts: r.attempts
                }]).slice(-5);
            }
            r.status = 'pending';
            r.error = null;
            r.finishedAt = null;
            delete r.skipReason;
        });
        session.nextSectionIndex = Math.max(0, firstPendingIndex(session));
    }

    // 집계
    function computeSummary(session) {
        var s = { total: 0, success: 0, failed: 0, timeout: 0, skipped: 0, interrupted: 0, pending: 0, running: 0 };
        session.results.forEach(function (r) {
            if (r.kind !== 'section') return;
            s.total++;
            if (s[r.status] !== undefined) s[r.status]++;
        });
        return s;
    }

    /** 진행률: 실행 대상(enabled) Section 중 끝난(success/failed/timeout) 개수 */
    function computeProgress(session) {
        var total = 0;
        var done = 0;
        session.results.forEach(function (r, i) {
            var e = session.plan[i];
            if (r.kind !== 'section' || !e || !e.enabled) return;
            total++;
            if (r.status === 'success' || r.status === 'failed' || r.status === 'timeout') done++;
        });
        return { done: done, total: total };
    }

    /** 결과 data 가 너무 크면 text block -> item 순으로 잘라내고 표시한다. */
    function enforceSizeLimit(data, maxBytes) {
        var size = JSON.stringify(data).length;
        if (!maxBytes || size <= maxBytes) return { data: data, trimmed: false, size: size };
        var d = clone(data);
        d.meta = d.meta || {};
        d.meta.truncated = d.meta.truncated || {};
        d.meta.warnings = d.meta.warnings || [];
        var guard = 0;
        while (JSON.stringify(d).length > maxBytes && guard++ < 40) {
            if (d.textBlocks && d.textBlocks.length) {
                d.textBlocks = d.textBlocks.slice(0, Math.floor(d.textBlocks.length / 2));
                d.meta.truncated.textBlocks = true;
            } else if (d.items && d.items.length) {
                d.items = d.items.slice(0, Math.floor(d.items.length / 2));
                d.meta.truncated.items = true;
            } else break;
        }
        d.meta.warnings.push('size_limit_applied');
        if (d.meta.counts) { d.meta.counts.items = (d.items || []).length; d.meta.counts.textBlocks = (d.textBlocks || []).length; }
        return { data: d, trimmed: true, size: JSON.stringify(d).length };
    }

    global.GSE_Storage = {
        ABORT: ABORT,
        KEY_SESSION: KEY_SESSION,
        KEY_DATA_PREFIX: KEY_DATA_PREFIX,
        KEY_LOG: KEY_LOG,
        SCHEMA_VERSION: SCHEMA_VERSION,
        nowIso: nowIso,
        uuid: uuid,
        getSession: getSession,
        mutate: mutate,
        replaceSession: replaceSession,
        clearAll: clearAll,
        getAllData: getAllData,
        dataKeyFor: dataKeyFor,
        appendLog: appendLog,
        getLog: getLog,
        createSession: createSession,
        reconcileWithConfig: reconcileWithConfig,
        prepareResume: prepareResume,
        countResumable: countResumable,
        firstPendingIndex: firstPendingIndex,
        computeSummary: computeSummary,
        computeProgress: computeProgress,
        enforceSizeLimit: enforceSizeLimit
    };
})(typeof globalThis !== 'undefined' ? globalThis : self);
