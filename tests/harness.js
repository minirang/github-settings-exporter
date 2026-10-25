'use strict';
/*
 * 오프라인 테스트 하네스.
 *  - background.js(+config/security/storage/formatter)는 vm 컨텍스트에서 "service worker" 처럼 실행된다.
 *    killBackground() 로 service worker 종료를, 메시지/이벤트로 자동 재시작(wake)을 흉내 낸다. storage 는 유지된다.
 *  - 각 탭의 페이지는 jsdom 이고, content script(security/extractor/metadata/content.js)는 실제 소스 그대로 주입된다.
 *  - chrome.* API 는 이 파일의 가짜 구현이다(실제 Chrome 동작과 다를 수 있다).
 */
const { JSDOM } = require('jsdom');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// 기본값: 저장소 루트(..). manifest.json 이 없으면 형제 폴더 ../github-settings-exporter. EXT_DIR 환경변수로 직접 지정 가능
const EXT_DIR = process.env.EXT_DIR || [path.join(__dirname, '..'), path.join(__dirname, '..', 'github-settings-exporter')]
    .find((d) => fs.existsSync(path.join(d, 'manifest.json')));
const EXT_ID = 'testextensionid';
const read = (f) => fs.readFileSync(path.join(EXT_DIR, f), 'utf8');
const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONTENT_FILES = ['security.js', 'extractor.js', 'metadata.js', 'content.js'];

class Browser {
    constructor(fixtures) {
        this.fixtures = fixtures;      // (url, tab, browser) => fixture
        this.storage = {};
        this.tabs = new Map();
        this.pages = new Map();
        this.nextTabId = 100;
        this.bg = null;
        this.bgSeq = 0;
        this.configPatch = '';
        this.alarms = new Map();
        this.loadDelay = 30;
        this.injectDelay = 20;
        this.stats = { tabsCreated: 0, reloads: 0, injectionsDeclared: 0, executeScriptCalls: 0, navigations: [], loads: {} };
        // 사용자가 보고 있는 원래 탭(확장프로그램이 건드리면 안 된다)
        this.tabs.set(1, { id: 1, url: 'https://github.com/o/r', status: 'complete', active: true, windowId: 1 });
    }

    // ---------------- background(service worker) ----------------
    startBackground() {
        const b = this;
        const inst = { id: ++this.bgSeq, dead: false, listeners: { onMessage: [], onUpdated: [], onRemoved: [], onAlarm: [], onStartup: [], onInstalled: [], onChanged: [] } };
        const frozen = () => new Promise(() => {});
        const guard = (fn) => (...a) => (inst.dead ? frozen() : fn(...a));
        const ev = (name) => ({ addListener: (f) => inst.listeners[name].push(f) });
        const chromeApi = {
            runtime: { id: EXT_ID, onMessage: ev('onMessage'), onStartup: ev('onStartup'), onInstalled: ev('onInstalled') },
            storage: {
                local: {
                    get: guard(async (keys) => b._storageGet(keys)),
                    set: guard(async (items) => b._storageSet(items)),
                    remove: guard(async (keys) => b._storageRemove(keys))
                },
                onChanged: ev('onChanged')
            },
            tabs: {
                onUpdated: ev('onUpdated'),
                onRemoved: ev('onRemoved'),
                create: guard(async ({ url, active }) => {
                    const id = b.nextTabId++;
                    const tab = { id, url: '', pendingUrl: url, status: 'loading', active: !!active, windowId: 1 };
                    b.tabs.set(id, tab);
                    b.stats.tabsCreated++;
                    b.stats.navigations.push(url);
                    b._scheduleLoad(tab, url);
                    return clone(tab);
                }),
                update: guard(async (id, props) => {
                    const tab = b.tabs.get(id);
                    if (!tab) throw new Error('No tab with id: ' + id);
                    if (props.url) { b.stats.navigations.push(props.url); b._scheduleLoad(tab, props.url); }
                    if (props.active) tab.active = true;
                    return clone(tab);
                }),
                get: guard(async (id) => {
                    const tab = b.tabs.get(id);
                    if (!tab) throw new Error('No tab with id: ' + id);
                    return clone(tab);
                }),
                remove: guard(async (id) => { b.closeTab(id); }),
                reload: guard(async (id) => {
                    const tab = b.tabs.get(id);
                    if (!tab) throw new Error('No tab with id: ' + id);
                    b.stats.reloads++;
                    b._scheduleLoad(tab, tab.url || tab.pendingUrl);
                }),
                sendMessage: guard(async (tabId, msg) => b._sendToPage(tabId, msg))
            },
            scripting: {
                executeScript: guard(async ({ target, files }) => {
                    b.stats.executeScriptCalls++;
                    const page = b.pages.get(target.tabId);
                    if (!page) throw new Error('No tab with id: ' + target.tabId);
                    if (page.fx.injectBlocked) throw new Error('Cannot access contents of the page.');
                    files.forEach((f) => page.win.eval(read(f)));
                    page.installed = true;
                    return [{ result: null }];
                })
            },
            alarms: {
                onAlarm: ev('onAlarm'),
                create: guard(async (name, info) => { b.alarms.set(name, info); }),
                clear: guard(async (name) => b.alarms.delete(name))
            },
            windows: { update: guard(async () => ({})) }
        };
        const wrapTimer = (set) => (fn, ms, ...args) => set(() => { if (!inst.dead) fn(...args); }, ms);
        const sandbox = {
            chrome: chromeApi, console, URL, crypto: require('crypto').webcrypto,
            setTimeout: wrapTimer(setTimeout), setInterval: wrapTimer(setInterval), clearTimeout, clearInterval
        };
        const ctx = vm.createContext(sandbox);
        vm.runInContext('this.self = this;', ctx);
        sandbox.importScripts = (...files) => files.forEach((f) => vm.runInContext(read(f), ctx, { filename: f }));
        vm.runInContext(read('background.js'), ctx, { filename: 'background.js' });
        if (this.configPatch) vm.runInContext(this.configPatch, ctx);
        inst.ctx = ctx;
        inst.eval = (code) => vm.runInContext(code, ctx);
        this.bg = inst;
        return inst;
    }

    ensureBackground() { return this.bg && !this.bg.dead ? this.bg : this.startBackground(); }
    killBackground() { if (this.bg) { this.bg.dead = true; this.bg = null; } }

    /** config.js 의 GSE_CONFIG 를 테스트용으로 덮어쓴다(서비스 워커 재시작 후에도 유지). */
    configure(sections, overrides) {
        const o = Object.assign({
            navigation: { navigationTimeoutMs: 2500, handshakeTimeoutMs: 1500, reloadRetryCount: 1 },
            extraction: { sectionTimeoutMs: 6000, rootTimeoutMs: 1500, domStableTimeMs: 150, domStableTimeoutMs: 1500, ignoreTags: ['nav', 'footer'] }
        }, overrides || {});
        this.configPatch =
            'Object.assign(GSE_CONFIG.navigation,' + JSON.stringify(o.navigation) + ');' +
            'Object.assign(GSE_CONFIG.extraction,' + JSON.stringify(o.extraction) + ');' +
            (o.metadata ? 'Object.assign(GSE_CONFIG.metadata,' + JSON.stringify(o.metadata) + ');' : '') +
            (o.resume ? 'Object.assign(GSE_CONFIG.resume,' + JSON.stringify(o.resume) + ');' : '') +
            'GSE_CONFIG.sections = ' + JSON.stringify(sections) + ';';
        this.ensureBackground().eval(this.configPatch);
    }

    _emit(name, ...args) {
        const bg = this.ensureBackground();
        bg.listeners[name].slice().forEach((f) => { try { f(...args); } catch (e) { console.error('[listener error]', name, e); } });
    }

    deliverToBackground(msg, sender) {
        const bg = this.ensureBackground();
        const m = clone(msg);
        return new Promise((resolve) => {
            let responded = false;
            let isAsync = false;
            const sendResponse = (r) => { if (!responded) { responded = true; resolve(clone(r)); } };
            bg.listeners.onMessage.slice().forEach((f) => {
                const ret = f(m, Object.assign({ id: EXT_ID }, sender || {}), sendResponse);
                if (ret === true) isAsync = true;
            });
            if (!isAsync && !responded) resolve(undefined);
        });
    }

    fireAlarm(name) { this._emit('onAlarm', { name }); }

    // ---------------- storage ----------------
    _storageGet(keys) {
        if (keys === null || keys === undefined) return clone(this.storage);
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        list.forEach((k) => { if (k in this.storage) out[k] = clone(this.storage[k]); });
        return out;
    }
    _storageSet(items) {
        const changes = {};
        Object.keys(items).forEach((k) => {
            changes[k] = { oldValue: clone(this.storage[k]), newValue: clone(items[k]) };
            this.storage[k] = clone(items[k]);
        });
        this._emit('onChanged', changes, 'local');
    }
    _storageRemove(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        const changes = {};
        list.forEach((k) => { if (k in this.storage) { changes[k] = { oldValue: clone(this.storage[k]) }; delete this.storage[k]; } });
        if (Object.keys(changes).length) this._emit('onChanged', changes, 'local');
    }
    session() { return clone(this.storage['gse:session']); }
    dataKeys() { return Object.keys(this.storage).filter((k) => k.indexOf('gse:data:') === 0); }

    // ---------------- tabs / pages ----------------
    closeTab(id) {
        if (!this.tabs.has(id)) return;
        const page = this.pages.get(id);
        if (page) { try { page.win.close(); } catch (_) {} this.pages.delete(id); }
        this.tabs.delete(id);
        this._emit('onRemoved', id, {});
    }

    shadowTabs() { return [...this.tabs.values()].filter((t) => t.id !== 1); }

    _scheduleLoad(tab, url) {
        const token = (tab._token = (tab._token || 0) + 1);
        tab.status = 'loading';
        tab.pendingUrl = url;
        this._emit('onUpdated', tab.id, { status: 'loading' }, clone(tab));
        setTimeout(() => this._commit(tab, url, token), this.loadDelayFn ? this.loadDelayFn(url, tab) : this.loadDelay);
    }

    _commit(tab, url, token) {
        if (!this.tabs.has(tab.id) || tab._token !== token) return;
        const old = this.pages.get(tab.id);
        if (old) { try { old.win.close(); } catch (_) {} this.pages.delete(tab.id); }
        this.stats.loads[url] = (this.stats.loads[url] || 0) + 1;
        let fx = this.fixtures(url, tab, this);
        let guard = 0;
        while (fx.redirectTo && guard++ < 5) { url = fx.redirectTo; this.stats.loads[url] = (this.stats.loads[url] || 0) + 1; fx = this.fixtures(url, tab, this); }
        tab.url = url;
        delete tab.pendingUrl;
        const page = this._makePage(tab, url, fx);
        this.pages.set(tab.id, page);
        const complete = () => {
            if (!this.tabs.has(tab.id) || tab._token !== token) return;
            tab.status = 'complete';
            this._emit('onUpdated', tab.id, { status: 'complete' }, clone(tab));
        };
        const inject = () => {
            if (!this.pages.has(tab.id) || this.pages.get(tab.id) !== page || fx.noAutoInject) return;
            this.stats.injectionsDeclared++;
            CONTENT_FILES.forEach((f) => page.win.eval(read(f)));
            page.installed = true;
        };
        if (fx.completeAfterInject) setTimeout(() => { inject(); complete(); }, this.injectDelay);
        else { complete(); setTimeout(inject, this.injectDelay); } // 가장 까다로운 순서: complete 가 먼저, content script 는 나중
    }

    _makePage(tab, url, fx) {
        const html = fx.html || '<!doctype html><html><body></body></html>';
        const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
        const win = dom.window;
        win.performance.getEntriesByType = (t) => (t === 'navigation' ? [{ responseStatus: fx.status || 200 }] : []);
        const page = { tab, dom, win, fx, listeners: [], installed: false };
        win.chrome = {
            runtime: {
                id: EXT_ID,
                onMessage: { addListener: (f) => page.listeners.push(f) },
                sendMessage: (msg) => this.deliverToBackground(msg, { tab: { id: tab.id, url: tab.url } })
            }
        };
        if (fx.setup) fx.setup(win);
        return page;
    }

    _sendToPage(tabId, msg) {
        const page = this.pages.get(tabId);
        if (!page || !page.installed || !page.listeners.length) return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
        return new Promise((resolve) => {
            let responded = false;
            let isAsync = false;
            const sendResponse = (r) => { if (!responded) { responded = true; resolve(clone(r)); } };
            page.listeners.slice().forEach((f) => { if (f(clone(msg), { id: EXT_ID }, sendResponse) === true) isAsync = true; });
            if (!isAsync && !responded) resolve(undefined);
        });
    }

    listenerCount(tabId) { const p = this.pages.get(tabId); return p ? p.listeners.length : 0; }
    destroy() { this.killBackground(); [...this.pages.values()].forEach((p) => { try { p.win.close(); } catch (_) {} }); this.pages.clear(); }
}

async function waitFor(fn, timeout, label) {
    const t0 = Date.now();
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() - t0 > (timeout || 15000)) throw new Error('timeout waiting for: ' + (label || fn.toString().slice(0, 80)));
        await sleep(40);
    }
}

module.exports = { Browser, waitFor, sleep, clone, read, EXT_ID, EXT_DIR };
