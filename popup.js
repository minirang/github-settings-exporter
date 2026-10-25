/*
 * GitHub Settings Exporter - popup.js
 *
 * popup 은 작업 엔진이 아니다. 닫으면 UI 만 사라지고, 다시 열면 background 에서 저장된 세션 상태를 받아 복구한다.
 * popup 은 config.js 나 background 의 전역 변수를 직접 쓰지 못하므로 아래 메시지 API 만 사용한다.
 *   GSE_GET_STATE { activeTabUrl }          -> { ok, config:{sections,errors}, candidate, session }
 *   GSE_START { activeTabUrl, activeTabId } -> { ok } | { ok:false, message }
 *   GSE_RESUME / GSE_STOP / GSE_RESET / GSE_FOCUS_SHADOW_TAB
 *   GSE_GET_EXPORT { format: 'txt' | 'json' } -> { ok, text }
 * 클립보드 복사는 사용자가 복사 버튼을 눌렀을 때만 수행한다.
 */
(function () {
    'use strict';

    var $ = function (id) { return document.getElementById(id); };

    var STATUS_LABEL = { idle: '대기', running: '실행 중', stopped: '중지됨', interrupted: '일시 중지', completed: '완료', failed: '실패' };
    var PHASE_LABEL = {
        idle: '대기', preparing: '준비 중', navigating: '페이지로 이동 중', waiting_for_document: '페이지 로딩 중',
        handshaking: 'content script 연결 중', waiting_for_root: '설정 영역 찾는 중', extracting: '추출 중',
        saving_result: '결과 저장 중', advancing: '다음 Section 준비 중', completed: '완료'
    };

    var state = null;
    var activeTab = { id: null, url: '' };
    var view = 'txt';
    var exportKey = '';
    var exporting = false;
    var refreshing = false;
    var transient = null; // { text, kind, until }
    var confirming = { start: false, reset: false };
    var confirmTimers = {};

    function send(message) {
        return chrome.runtime.sendMessage(message).then(function (res) {
            return res || { ok: false, message: 'background 로부터 응답이 없습니다.' };
        }, function (e) {
            return { ok: false, message: String(e && e.message || e) };
        });
    }

    function detectActiveTab() {
        return chrome.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
            var t = tabs && tabs[0];
            activeTab = t ? { id: t.id, url: t.url || '' } : { id: null, url: '' };
        }, function () { activeTab = { id: null, url: '' }; });
    }

    // 알림
    function notify(text, kind, ms) {
        transient = { text: text, kind: kind || 'info', until: Date.now() + (ms || 8000) };
        renderNotice();
    }

    function renderNotice() {
        var el = $('notice');
        var text = '';
        var kind = 'info';
        if (transient && Date.now() < transient.until) { text = transient.text; kind = transient.kind; }
        else if (state) {
            var errs = state.config && state.config.errors || [];
            var s = state.session;
            if (errs.length) { text = 'config.js 설정 오류:\n- ' + errs.join('\n- '); kind = 'error'; }
            else if (s && s.lastError && (s.status === 'interrupted' || s.status === 'stopped')) { text = s.lastError.message; kind = 'warn'; }
        }
        el.hidden = !text;
        el.textContent = text;
        el.setAttribute('data-kind', kind);
    }

    // 렌더링
    function render() {
        if (!state) return;
        var s = state.session;
        var status = s ? s.status : 'idle';
        var running = status === 'running';

        var pill = $('statusPill');
        pill.textContent = STATUS_LABEL[status] || status;
        pill.setAttribute('data-tone', status);

        var repo = s ? s.repository : state.candidate;
        $('repoName').textContent = repo ? repo.owner + '/' + repo.name : '-';
        var hint = '';
        if (!s && !state.candidate) hint = '활성 탭이 GitHub Repository 페이지가 아닙니다. Repository 페이지에서 이 팝업을 여세요.';
        else if (!s) hint = '현재 탭은 이동하지 않고, 별도의 Shadow Tab 에서 설정 페이지를 읽습니다.';
        else if (running) hint = PHASE_LABEL[s.phase] || s.phase;
        $('repoHint').textContent = hint;

        var progress = s ? s.progress : { done: 0, total: state.config.sections.filter(function (x) { return x.enabled; }).length };
        $('progressText').textContent = 'Progress: ' + progress.done + ' / ' + progress.total;
        var cur = s && s.current && (running || status === 'interrupted') ? s.current : null;
        $('currentText').textContent = cur ? 'Current: [' + cur.id + '] ' + cur.name : '';

        var sum = s ? s.summary : { success: 0, failed: 0, timeout: 0, skipped: 0, interrupted: 0 };
        $('cntSuccess').textContent = sum.success;
        $('cntFailed').textContent = sum.failed;
        $('cntTimeout').textContent = sum.timeout;
        $('cntSkipped').textContent = sum.skipped;
        $('cntInterrupted').textContent = sum.interrupted;
        $('legendSkipped').hidden = !sum.skipped;
        $('legendInterrupted').hidden = !sum.interrupted;

        renderSegments(s);
        renderSections(s);

        var cfgErr = (state.config.errors || []).length > 0;
        $('startBtn').disabled = running || !state.candidate || cfgErr;
        $('startBtn').textContent = confirming.start ? '기존 결과를 지우고 시작' : '새로 시작';
        $('startBtn').classList.toggle('confirming', confirming.start);
        $('resumeBtn').disabled = running || !(s && s.resumable) || cfgErr;
        $('stopBtn').disabled = !(running || (s && status === 'interrupted' && s.hasShadowTab));
        $('focusBtn').disabled = !(s && s.hasShadowTab && (running || status === 'interrupted'));
        $('resetBtn').disabled = !s || running;
        $('resetBtn').textContent = confirming.reset ? '정말 초기화(결과 삭제)' : '세션 초기화';
        $('copyTxt').disabled = !s;
        $('copyJson').disabled = !s;

        renderNotice();
    }

    function renderSegments(s) {
        var box = $('segments');
        var items = s
            ? s.results.map(function (r) { return { id: r.id, name: r.name, status: r.status }; })
            : state.config.sections.map(function (x) { return { id: x.id, name: x.name, status: x.enabled ? 'pending' : 'skipped' }; });
        var sig = items.map(function (i) { return i.id + ':' + i.status; }).join('|');
        if (box.getAttribute('data-sig') === sig) return;
        box.setAttribute('data-sig', sig);
        box.textContent = '';
        items.forEach(function (i) {
            var seg = document.createElement('span');
            seg.className = 'seg';
            seg.setAttribute('data-status', i.status);
            seg.title = '[' + i.id + '] ' + i.name + ': ' + i.status;
            box.appendChild(seg);
        });
    }

    function renderSections(s) {
        var list = $('sectionList');
        var rows = s ? s.results : state.config.sections.map(function (x) { return { id: x.id, name: x.name, status: x.enabled ? 'pending' : 'skipped', error: null }; });
        var sig = JSON.stringify(rows.map(function (r) { return [r.id, r.status, r.attempts, r.error && r.error.type]; }));
        if (list.getAttribute('data-sig') === sig) return;
        list.setAttribute('data-sig', sig);
        list.textContent = '';
        rows.forEach(function (r) {
            var li = document.createElement('li');
            var dot = document.createElement('span');
            dot.className = 'dot';
            dot.setAttribute('data-status', r.status);
            var name = document.createElement('span');
            name.className = 'name';
            name.textContent = '[' + r.id + '] ' + r.name;
            var st = document.createElement('span');
            st.className = 'state';
            st.textContent = r.status + (r.attempts > 1 ? ' (x' + r.attempts + ')' : '');
            li.appendChild(dot); li.appendChild(name); li.appendChild(st);
            if (r.error) {
                var err = document.createElement('span');
                err.className = 'err';
                err.textContent = r.error.type + ': ' + r.error.message;
                li.appendChild(err);
            }
            list.appendChild(li);
        });
    }

    // 결과 미리보기 (실행 중에는 진행이 바뀔 때만 다시 가져온다)
    function previewKey() {
        var s = state && state.session;
        if (!s) return 'none|' + view;
        var done = s.progress.done + '/' + s.summary.failed + '/' + s.summary.timeout + '/' + s.summary.interrupted;
        return [s.sessionId, s.status, done, view, s.status === 'running' ? '' : s.updatedAt].join('|');
    }

    function ensurePreview() {
        var key = previewKey();
        if (key === exportKey || exporting) return;
        var ta = $('preview');
        if (!state || !state.session) { ta.value = ''; exportKey = key; return; }
        exporting = true;
        send({ type: 'GSE_GET_EXPORT', format: view }).then(function (res) {
            if (res.ok) {
                var top = ta.scrollTop;
                ta.value = res.text;
                ta.scrollTop = top;
                exportKey = key;
            } else if (res.error !== 'no_session') {
                notify('결과를 불러오지 못했습니다: ' + (res.message || res.error), 'error');
            }
        }).then(function () { exporting = false; }, function () { exporting = false; });
    }

    function setView(v) {
        view = v;
        $('viewTxt').setAttribute('aria-pressed', String(v === 'txt'));
        $('viewJson').setAttribute('aria-pressed', String(v === 'json'));
        exportKey = '';
        ensurePreview();
    }

    // 새로고침 루프
    function refresh() {
        if (refreshing) return Promise.resolve();
        refreshing = true;
        return detectActiveTab().then(function () {
            return send({ type: 'GSE_GET_STATE', activeTabUrl: activeTab.url });
        }).then(function (res) {
            if (!res.ok) { notify('상태를 불러오지 못했습니다: ' + (res.message || res.error), 'error'); return; }
            state = res;
            render();
            ensurePreview();
        }).then(function () { refreshing = false; }, function () { refreshing = false; });
    }

    // 버튼 동작
    function armConfirm(name) {
        confirming[name] = true;
        clearTimeout(confirmTimers[name]);
        confirmTimers[name] = setTimeout(function () { confirming[name] = false; render(); }, 5000);
        render();
    }
    function disarm(name) {
        confirming[name] = false;
        clearTimeout(confirmTimers[name]);
    }

    function onStart() {
        if (state && state.session && !confirming.start) { armConfirm('start'); return; } // 기존 결과를 덮어쓰므로 확인 단계
        disarm('start');
        send({ type: 'GSE_START', activeTabUrl: activeTab.url, activeTabId: activeTab.id }).then(function (res) {
            if (!res.ok) notify(res.message || res.error, 'error', 12000);
            else { exportKey = ''; notify('작업을 시작했습니다. 이 팝업을 닫아도 작업은 계속됩니다.', 'info'); }
            return refresh();
        });
    }

    function onResume() {
        send({ type: 'GSE_RESUME' }).then(function (res) {
            if (!res.ok) notify(res.message || res.error, 'error', 12000);
            else notify('이어서 진행합니다. 성공한 Section 은 다시 추출하지 않습니다.', 'info');
            return refresh();
        });
    }

    function onStop() {
        send({ type: 'GSE_STOP' }).then(function (res) {
            if (!res.ok) notify(res.message || res.error, 'error');
            else notify('작업을 중지했습니다. 저장된 결과는 유지되며 "이어받기"로 계속할 수 있습니다.', 'info');
            return refresh();
        });
    }

    function onReset() {
        if (!confirming.reset) { armConfirm('reset'); return; }
        disarm('reset');
        send({ type: 'GSE_RESET' }).then(function (res) {
            if (!res.ok) notify(res.message || res.error, 'error');
            else { exportKey = ''; $('preview').value = ''; notify('세션과 저장된 결과를 삭제했습니다.', 'info'); }
            return refresh();
        });
    }

    function onFocusShadow() {
        send({ type: 'GSE_FOCUS_SHADOW_TAB' }).then(function (res) {
            if (!res.ok) notify(res.message || res.error, 'error');
        });
    }

    function fallbackCopy(text) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
        document.body.removeChild(ta);
        return ok;
    }

    function onCopy(format) {
        send({ type: 'GSE_GET_EXPORT', format: format }).then(function (res) {
            if (!res.ok) { notify('복사할 결과가 없습니다: ' + (res.message || res.error), 'error'); return; }
            var label = format === 'json' ? 'JSON' : 'TXT';
            var done = function () { notify(label + ' 결과를 클립보드에 복사했습니다 (' + res.text.length.toLocaleString() + '자).', 'info'); };
            var fail = function () {
                if (fallbackCopy(res.text)) done();
                else notify('클립보드 복사에 실패했습니다. 미리보기 영역에서 직접 선택해 복사하세요.', 'error');
            };
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(res.text).then(done, fail);
            else fail();
        });
    }

    $('startBtn').addEventListener('click', onStart);
    $('resumeBtn').addEventListener('click', onResume);
    $('stopBtn').addEventListener('click', onStop);
    $('resetBtn').addEventListener('click', onReset);
    $('focusBtn').addEventListener('click', onFocusShadow);
    $('copyTxt').addEventListener('click', function () { onCopy('txt'); });
    $('copyJson').addEventListener('click', function () { onCopy('json'); });
    $('viewTxt').addEventListener('click', function () { setView('txt'); });
    $('viewJson').addEventListener('click', function () { setView('json'); });

    refresh();
    setInterval(refresh, 1000);
})();
