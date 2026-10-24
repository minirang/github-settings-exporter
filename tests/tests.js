'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { Browser, waitFor, sleep, read, EXT_DIR } = require('./harness');
const { makeFixtures, state } = require('./fixtures');

const only = process.argv[2] || '';
const results = [];
const open = [];

async function test(name, fn) {
  if (only && name.indexOf(only) < 0) return;
  const t0 = Date.now();
  Object.assign(state, { loggedIn: true, blockInjectFirstLoadOf: null, neverInject: false, slowMs: 600, dangerClicks: 0, moreClicks: 0 });
  try {
    await fn();
    results.push({ name, ok: true });
    console.log('PASS  ' + name + '  (' + (Date.now() - t0) + 'ms)');
  } catch (e) {
    results.push({ name, ok: false, err: e });
    console.log('FAIL  ' + name + '\n      ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n      '));
  }
  open.splice(0).forEach((b) => b.destroy());
}

const sec = (id, name, p, root, o) => {
  o = o || {};
  return { id, name, path: p, selectors: { root, ignore: o.ignore || [] }, actions: o.actions || [], options: { enabled: o.enabled !== false, timeoutMs: o.timeoutMs || 6000 } };
};
function newBrowser(sections, overrides) {
  const b = new Browser(makeFixtures());
  b.configure(sections, overrides);
  open.push(b);
  return b;
}
const send = (b, msg) => b.deliverToBackground(msg, {});
const start = (b, url) => send(b, { type: 'GSE_START', activeTabUrl: url || 'https://github.com/o/r/settings/branches', activeTabId: 1 });
const status = (b) => (b.session() || {}).status;
const waitStatus = (b, st, t) => waitFor(() => status(b) === st, t || 25000, 'status ' + st + ' (now ' + status(b) + '/' + (b.session() || {}).phase + ')');
const waitPhase = (b, idx, phase, t) => waitFor(() => { const s = b.session(); return s && s.currentSectionIndex === idx && s.phase === phase; }, t || 15000, 'section ' + idx + ' phase ' + phase);
async function exportJson(b) { const r = await send(b, { type: 'GSE_GET_EXPORT', format: 'json' }); assert.ok(r.ok, JSON.stringify(r)); return JSON.parse(r.text); }
async function exportTxt(b) { const r = await send(b, { type: 'GSE_GET_EXPORT', format: 'txt' }); assert.ok(r.ok, JSON.stringify(r)); return r.text; }
const statuses = (b) => b.session().results.map((r) => r.status);
const SECRETS = ['hunter2-super-secret', 'CSRF_SECRET_VALUE', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'not-a-pattern-just-plain', 'ghs_0123456789abcdefghijklmnopqrstuvwxyz', 'NEW_SECRET_NAME'];
const GENERAL_URL = 'https://github.com/o/r/settings';

(async () => {
  // ------------------------------------------------------------------------
  await test('T1 happy path: 추출 의미, 보안 필터, 안전한 expand, Shadow Tab 수명', async () => {
    const b = newBrowser([
      sec(1, 'General', '/settings', '#main', { ignore: ['.promo'] }),
      sec(2, 'Collaborators', '/settings/access', 'main'),
      sec(3, 'Branches', '/settings/branches', 'main'),
      sec(4, 'Actions', '/settings/actions', 'main', { actions: [{ type: 'expand', selector: "details, button[aria-expanded='false']", waitAfterMs: 50 }] }),
      sec(6, 'Secrets and variables', '/settings/secrets/actions', 'main')
    ]);
    const r1 = await start(b);
    assert.ok(r1.ok, JSON.stringify(r1));
    const dup = await start(b);
    assert.strictEqual(dup.ok, false);
    assert.strictEqual(dup.error, 'already_running');
    await waitStatus(b, 'completed', 40000);

    assert.strictEqual(b.tabs.get(1).url, 'https://github.com/o/r', '사용자 탭이 이동되면 안 됨');
    assert.strictEqual(b.stats.tabsCreated, 1, 'Shadow Tab 은 하나만');
    assert.strictEqual(b.shadowTabs().length, 0, '완료 후 Shadow Tab 정리');
    assert.strictEqual(b.session().shadowTabId, null);
    assert.deepStrictEqual(b.stats.navigations.map((u) => u.replace('https://github.com/o/r', '')),
      ['/settings', '/settings/access', '/settings/branches', '/settings/actions', '/settings/secrets/actions'], '배열 순서대로 이동');

    const exp = await exportJson(b);
    assert.deepStrictEqual(exp.sections.map((s) => s.status), ['success', 'success', 'success', 'success', 'success']);
    assert.deepStrictEqual(exp.summary, { total: 5, success: 5, failed: 0, timeout: 0, skipped: 0, interrupted: 0, pending: 0, running: 0 });
    assert.strictEqual(exp.schemaVersion, 1);
    assert.deepStrictEqual(exp.repository.metadata, {});

    // ---- General ----
    const gen = exp.sections[0];
    const it = (k) => gen.data.items.find((i) => i.key === k);
    assert.strictEqual(it('repository[name]').value, 'my-repo');
    assert.strictEqual(it('repository[name]').keyBasis, 'name');
    assert.strictEqual(it('repository[name]').label, 'Repository name');
    assert.strictEqual(it('repository[name]').labelSource, 'label');
    assert.strictEqual(it('repository[description]').value, 'An example repository');
    assert.match(it('repository[description]').description, /Short description shown on the repository page/);
    assert.strictEqual(it('deploy_password').redacted, true);
    assert.strictEqual(it('deploy_password').value, null);
    assert.strictEqual(it('deploy_password').redactReason, 'password_field');
    assert.strictEqual(it('api_token').redacted, true);
    assert.strictEqual(it('api_token').redactReason, 'sensitive_identifier');
    assert.strictEqual(it('deploy_key_value').value, '[REDACTED]', '값 패턴(ghp_) 방어');
    assert.strictEqual(it('repository[homepage]').value, 'https://example.com');
    assert.strictEqual(it('repository[homepage]').type, 'url');
    assert.strictEqual(it('repository[has_issues]').value, true);
    assert.strictEqual(it('repository[has_issues]').type, 'checkbox');
    assert.match(it('repository[has_issues]').description, /Track bugs and tasks/);
    assert.strictEqual(it('repository[has_wiki]').value, false);
    assert.strictEqual(it('locked_opt').state.disabled, true);
    const radios = gen.data.items.filter((i) => i.type === 'radio');
    assert.strictEqual(radios.length, 2);
    assert.strictEqual(radios.find((r) => r.label === 'Private').value, true);
    assert.strictEqual(radios.find((r) => r.label === 'Public').value, false);
    assert.strictEqual(radios[0].group.label, 'Visibility');
    assert.match(radios.find((r) => r.label === 'Public').description, /Anyone on the internet/);
    assert.strictEqual(it('repository[default_branch]').value, 'main');
    assert.strictEqual(it('repository[default_branch]').state.selectedValue, 'main');
    const sw = gen.data.items.find((i) => i.type === 'switch');
    assert.strictEqual(sw.label, 'Allow squash merging');
    assert.strictEqual(sw.value, true);
    const dd = gen.data.items.find((i) => i.type === 'dropdown-trigger');
    assert.match(dd.value, /Branch:\s*main/);
    assert.strictEqual(dd.state.expanded, false);
    assert.ok(!gen.data.items.some((i) => i.key === 'adv_flag'), '닫힌 <details> 내부는 추출하지 않음');
    assert.strictEqual(gen.data.items.find((i) => i.type === 'details').value, false);
    assert.ok(it('shadow_flag'), '열린 Shadow DOM 은 추출');
    assert.ok(!it('closed_flag'), '닫힌 Shadow DOM 은 우회하지 않음');
    assert.ok(!it('authenticity_token'), 'hidden input 제외');
    const gtexts = JSON.stringify(gen.data.textBlocks);
    assert.ok(!/Promotional/.test(gtexts), 'ignore selector');
    assert.ok(!/Inner nav link/.test(gtexts), 'ignoreTags(nav)');
    assert.ok(/Repository-wide notice/.test(gtexts));
    assert.ok(!/Short description shown/.test(gtexts), '설명으로 쓰인 텍스트는 text block 에 중복되지 않음');
    assert.ok(gen.data.headings.some((h) => h.text === 'General' && h.level === 2));
    assert.ok(gen.data.headings.some((h) => h.text === 'Visibility' && h.tag === 'legend'));
    assert.ok(gen.data.meta.counts.redactedItems >= 2);
    assert.ok(gen.data.meta.counts.openShadowRoots >= 1);
    // 같은 key 는 한 번만
    const keys = gen.data.items.map((i) => i.key);
    assert.strictEqual(new Set(keys).size, keys.length, 'key 유일');

    // ---- Collaborators (text rows) ----
    const col = JSON.stringify(exp.sections[1].data.textBlocks);
    assert.ok(/alice Admin/.test(col) && /bob Write/.test(col), 'li 행 단위로 묶임: ' + col);
    assert.ok(/Manage who has access/.test(col));

    // ---- Branches (ARIA) ----
    const br = exp.sections[2].data.items;
    const lb = br.find((i) => i.type === 'listbox');
    assert.strictEqual(lb.value, 'main rule');
    assert.strictEqual(lb.label, 'Rules');
    assert.ok(!br.some((i) => i.type === 'selected-option' && i.label === 'main rule'), 'listbox 가 소비한 option 은 중복 수집 안 함');
    const tab = br.find((i) => i.type === 'selected-option');
    assert.strictEqual(tab.label, 'Active');
    assert.strictEqual(tab.selection.role, 'tab');
    assert.strictEqual(tab.selection.container.role, 'tablist');

    // ---- Actions (expand 안전성) ----
    const act = exp.sections[3];
    assert.ok(act.data.items.some((i) => i.key === 'actions_hidden_flag'), '<details> 가 펼쳐져 내부가 추출됨');
    assert.ok(act.data.items.some((i) => i.key === 'more_flag'), 'aria-expanded=false 컨트롤이 펼쳐져 내부가 추출됨');
    const rep = act.data.meta.actions[0];
    assert.strictEqual(rep.performed, 2);
    assert.strictEqual(state.moreClicks, 1);
    assert.strictEqual(state.dangerClicks, 0, '위험/제출/팝업 컨트롤은 절대 클릭하지 않음');
    assert.ok(rep.skipped.may_submit_form >= 1 && rep.skipped.danger_style >= 1 && rep.skipped.popup_control_skipped >= 1, JSON.stringify(rep.skipped));

    // ---- Secrets ----
    const secs = exp.sections[4];
    assert.ok(/DEPLOY_TOKEN Updated 3 days ago/.test(JSON.stringify(secs.data.textBlocks)), '이름/메타데이터는 수집');
    assert.strictEqual(secs.data.items.find((i) => i.key === 'secret_value').redacted, true);
    assert.strictEqual(secs.data.items.find((i) => i.key === 'secret_name').redacted, true);

    // ---- 어떤 저장소/출력에도 비밀값이 없다 ----
    const txt = await exportTxt(b);
    const dumps = [JSON.stringify(b.storage), txt, JSON.stringify(exp)];
    dumps.forEach((d) => SECRETS.forEach((s) => assert.ok(!d.includes(s), 'LEAK: ' + s)));

    // ---- TXT ----
    assert.ok(txt.startsWith('GitHub Repository Settings Export\nSchema: 1\nRepository: o/r\nURL: https://github.com/o/r\n'), txt.slice(0, 120));
    ['[1] General', 'URL: ' + GENERAL_URL, 'Status: success', 'Section:', '- Repository name: my-repo', '- Issues: checked', '- Wikis: unchecked',
      '- Visibility: Private', '(options: Public | Private*)', '[REDACTED: password_field]', '- Locked option: checked [disabled]', '- Allow squash merging: on',
      '[6] Secrets and variables', '- Total: 5', '- Success: 5'].forEach((s) => assert.ok(txt.includes(s), 'TXT 누락: ' + s + '\n' + txt.slice(0, 1800)));
  });

  // ------------------------------------------------------------------------
  await test('T2 오류 격리 + 비활성 Section 건너뛰기 + 순서', async () => {
    const b = newBrowser([
      sec(1, 'General', '/settings', '#main'),
      sec(2, 'Collaborators', '/settings/access', '#does-not-exist'),
      sec(3, 'Branches', '/settings/branches', 'main', { enabled: false }),
      sec(4, 'Webhooks', '/settings/hooks', 'main'),
      sec(5, 'Security', '/settings/security_analysis', '#sec'),
      sec(6, 'Bad selector', '/settings/access', 'main[[')
    ]);
    await start(b);
    await waitStatus(b, 'completed', 40000);
    assert.deepStrictEqual(statuses(b), ['success', 'failed', 'skipped', 'failed', 'success', 'failed']);
    const s = b.session();
    assert.strictEqual(s.results[1].error.type, 'root_not_found');
    assert.strictEqual(s.results[1].error.phase, 'waiting_for_root');
    assert.strictEqual(s.results[1].error.sectionName, 'Collaborators');
    assert.strictEqual(s.results[3].error.type, 'page_not_found');
    assert.match(s.results[3].error.message, /404/);
    assert.strictEqual(s.results[5].error.type, 'invalid_root_selector');
    assert.strictEqual(s.results[2].skipReason, 'disabled');
    assert.ok(!b.stats.navigations.some((u) => /branches/.test(u)), '비활성 Section 은 이동하지 않음');
    const exp = await exportJson(b);
    assert.deepStrictEqual(exp.summary, { total: 6, success: 2, failed: 3, timeout: 0, skipped: 1, interrupted: 0, pending: 0, running: 0 });
    assert.strictEqual(exp.sections.length, 6, '실패한 Section 도 삭제하지 않고 기록');
    assert.strictEqual(exp.sections[1].error.type, 'root_not_found');
    const txt = await exportTxt(b);
    assert.ok(txt.includes('[2] Collaborators') && txt.includes('Status: failed') && txt.includes('Error: root_not_found'), txt);
    assert.ok(txt.includes('Status: skipped (disabled)'));
    assert.strictEqual(b.shadowTabs().length, 0);
  });

  // ------------------------------------------------------------------------
  await test('T3 로그인 리다이렉트: 분석하지 않고 일시 중지 → 로그인 후 이어받기', async () => {
    state.loggedIn = false;
    const b = newBrowser([sec(1, 'General', '/settings', '#main'), sec(2, 'Environments', '/settings/environments', 'main'), sec(3, 'Security', '/settings/security_analysis', '#sec')]);
    await start(b);
    await waitStatus(b, 'interrupted', 30000);
    let s = b.session();
    assert.strictEqual(s.pauseReason, 'authentication_required');
    assert.deepStrictEqual(statuses(b), ['success', 'interrupted', 'pending']);
    assert.strictEqual(s.results[1].error.type, 'authentication_required');
    assert.ok(/login/.test(s.results[1].error.finalUrl));
    assert.strictEqual(b.shadowTabs().length, 1, '사용자가 인증할 수 있게 Shadow Tab 유지');
    assert.ok(!b.dataKeys().includes('gse:data:s2'), '로그인 화면은 분석/저장하지 않음');
    const st = await send(b, { type: 'GSE_GET_STATE', activeTabUrl: GENERAL_URL });
    assert.strictEqual(st.session.status, 'interrupted');
    assert.strictEqual(st.session.resumable, true);
    assert.strictEqual(st.session.hasShadowTab, true);
    const tabId = s.shadowTabId;

    state.loggedIn = true; // 사용자가 Shadow Tab 에서 로그인을 마쳤다고 가정
    const rr = await send(b, { type: 'GSE_RESUME' });
    assert.ok(rr.ok, JSON.stringify(rr));
    await waitStatus(b, 'completed', 30000);
    s = b.session();
    assert.deepStrictEqual(statuses(b), ['success', 'success', 'success']);
    assert.strictEqual(s.results[0].attempts, 1, '성공한 Section 은 다시 추출하지 않음');
    assert.strictEqual(b.stats.loads[GENERAL_URL], 1);
    assert.strictEqual(s.results[1].attempts, 2);
    assert.strictEqual(s.results[1].history[0].status, 'interrupted', '이전 중단 기록이 보존됨');
    assert.strictEqual(b.stats.tabsCreated, 1, '유효한 기존 Shadow Tab 재사용 (id ' + tabId + ')');
    assert.strictEqual(b.shadowTabs().length, 0);
  });

  // ------------------------------------------------------------------------
  await test('T4 중지 → 결과/Shadow Tab 정리 → 늦은 응답 폐기 → 이어받기', async () => {
    state.slowMs = 900;
    const b = newBrowser([sec(1, 'General', '/settings', '#main'), sec(2, 'Slow', '/settings/slow', 'main'), sec(3, 'Security', '/settings/security_analysis', '#sec')]);
    await start(b);
    await waitPhase(b, 1, 'waiting_for_root');
    const oldTab = b.session().shadowTabId;
    const sr = await send(b, { type: 'GSE_STOP' });
    assert.ok(sr.ok);
    let s = b.session();
    assert.strictEqual(s.status, 'stopped');
    assert.strictEqual(s.stopRequested, true);
    assert.strictEqual(b.shadowTabs().length, 0, '중지 후 Shadow Tab 정리');
    assert.deepStrictEqual(statuses(b), ['success', 'interrupted', 'pending']);
    assert.strictEqual(s.results[1].error.type, 'stopped_by_user');
    await sleep(1500);
    assert.deepStrictEqual(statuses(b), ['success', 'interrupted', 'pending'], '중지 후 늦은 응답이 결과를 덮어쓰면 안 됨');
    assert.strictEqual(status(b), 'stopped');

    const rr = await send(b, { type: 'GSE_RESUME' });
    assert.ok(rr.ok, JSON.stringify(rr));
    await waitStatus(b, 'completed', 30000);
    s = b.session();
    assert.deepStrictEqual(statuses(b), ['success', 'success', 'success']);
    assert.deepStrictEqual(s.results.map((r) => r.attempts), [1, 2, 1]);
    assert.strictEqual(b.stats.loads[GENERAL_URL], 1, '성공한 Section 은 재추출하지 않음');
    assert.strictEqual(b.stats.tabsCreated, 2, '이어받기 시 새 Shadow Tab (old ' + oldTab + ')');
    assert.strictEqual(b.shadowTabs().length, 0);
    assert.ok((await exportJson(b)).sections[0].data.items.length > 5, '이전 결과 보존');
  });

  // ------------------------------------------------------------------------
  await test('T5 사용자가 Shadow Tab 을 닫음 → interrupted(결과 유지) → 이어받기', async () => {
    state.slowMs = 900;
    const b = newBrowser([sec(1, 'General', '/settings', '#main'), sec(2, 'Slow', '/settings/slow', 'main')]);
    await start(b);
    await waitPhase(b, 1, 'waiting_for_root');
    b.closeTab(b.session().shadowTabId);
    await waitStatus(b, 'interrupted', 5000);
    const s = b.session();
    assert.strictEqual(s.pauseReason, 'session_interrupted');
    assert.strictEqual(s.shadowTabId, null);
    assert.deepStrictEqual(statuses(b), ['success', 'interrupted']);
    assert.ok(b.dataKeys().includes('gse:data:s1'), '이미 저장된 결과는 유지');
    await sleep(1200);
    assert.deepStrictEqual(statuses(b), ['success', 'interrupted']);
    const rr = await send(b, { type: 'GSE_RESUME' });
    assert.ok(rr.ok, JSON.stringify(rr));
    await waitStatus(b, 'completed', 30000);
    assert.deepStrictEqual(statuses(b), ['success', 'success']);
    assert.strictEqual(b.stats.tabsCreated, 2);
  });

  // ------------------------------------------------------------------------
  await test('T6a service worker 종료 중 추출 진행: content 결과 메시지가 깨워서 이어감', async () => {
    state.slowMs = 900;
    const b = newBrowser([sec(1, 'General', '/settings', '#main'), sec(2, 'Slow', '/settings/slow', 'main'), sec(3, 'Security', '/settings/security_analysis', '#sec')]);
    await start(b);
    await waitPhase(b, 1, 'waiting_for_root');
    const seqBefore = b.bgSeq;
    b.killBackground();
    assert.strictEqual(b.bg, null);
    await waitStatus(b, 'completed', 30000);
    assert.ok(b.bgSeq > seqBefore, '새 service worker 인스턴스가 깨어남');
    assert.deepStrictEqual(statuses(b), ['success', 'success', 'success']);
    assert.deepStrictEqual(b.session().results.map((r) => r.attempts), [1, 1, 1], '중복 실행 없음');
    assert.strictEqual(b.shadowTabs().length, 0);
  });

  await test('T6b service worker 종료 중 페이지 로딩: tabs.onUpdated 가 깨워서 이어감', async () => {
    const b = newBrowser([sec(1, 'General', '/settings', '#main'), sec(2, 'Security', '/settings/security_analysis', '#sec')]);
    b.loadDelay = 500;
    await start(b);
    await waitPhase(b, 0, 'waiting_for_document');
    b.killBackground();
    await waitStatus(b, 'completed', 30000);
    assert.deepStrictEqual(statuses(b), ['success', 'success']);
    assert.deepStrictEqual(b.session().results.map((r) => r.attempts), [1, 1]);
  });

  await test('T6c watchdog: content 작업이 사라져도(페이지 크래시 등) 알람으로 복구(reload)', async () => {
    state.slowMs = 900;
    const b = newBrowser([sec(1, 'Slow', '/settings/slow', 'main', { timeoutMs: 1500 })]);
    b.configPatch += 'RUN_GRACE_MS = 300;';
    b.bg.eval('RUN_GRACE_MS = 300;');
    await start(b);
    await waitPhase(b, 0, 'waiting_for_root');
    const tabId = b.session().shadowTabId;
    b.pages.get(tabId).win.close(); // 페이지(와 content 작업)가 사라짐: 결과 메시지가 오지 않는다
    state.slowMs = 50;
    b.killBackground(); // service worker 도 죽어 있다
    const t0 = Date.now();
    while (status(b) === 'running' && Date.now() - t0 < 20000) { b.fireAlarm('gse-watchdog'); await sleep(250); }
    await waitStatus(b, 'completed', 20000);
    const s = b.session();
    assert.strictEqual(s.results[0].status, 'success');
    assert.strictEqual(s.results[0].attempts, 2, 'reload 복구로 2번째 시도');
    assert.strictEqual(b.stats.reloads, 1);
  });

  // ------------------------------------------------------------------------
  await test('T7 중복 시작/위조·늦은 응답 폐기/content 의 popup API 호출 거부', async () => {
    state.slowMs = 1200;
    const b = newBrowser([sec(1, 'Slow', '/settings/slow', 'main'), sec(2, 'Security', '/settings/security_analysis', '#sec')]);
    await start(b);
    await waitPhase(b, 0, 'waiting_for_root');
    const s = b.session();
    const fake = (extra) => Object.assign({ type: 'GSE_RESULT', sessionId: s.sessionId, requestId: s.currentRequest.requestId, sectionId: 1, kind: 'section', ok: true, data: { headings: [], items: [{ key: 'forged' }], textBlocks: [], meta: {} } }, extra);
    const r1 = await b.deliverToBackground(fake({ requestId: 'stale-request' }), { tab: { id: s.shadowTabId } });
    assert.strictEqual(r1.ignored, true, '오래된 requestId');
    const r2 = await b.deliverToBackground(fake({}), { tab: { id: 1 } });
    assert.strictEqual(r2.ignored, true, 'Shadow Tab 이 아닌 탭에서 온 응답');
    const r3 = await b.deliverToBackground(fake({ sessionId: 'other-session' }), { tab: { id: s.shadowTabId } });
    assert.strictEqual(r3.ignored, true, '다른 세션');
    const r4 = await b.deliverToBackground({ type: 'GSE_STOP' }, { tab: { id: s.shadowTabId } });
    assert.strictEqual(r4.error, 'forbidden');
    assert.strictEqual(status(b), 'running');
    assert.ok(!b.dataKeys().includes('gse:data:s1'), '위조 결과는 저장되지 않음');
    await waitStatus(b, 'completed', 30000);
    const late = await b.deliverToBackground(fake({}), { tab: { id: s.shadowTabId } });
    assert.strictEqual(late.ignored, true, '완료 후 늦은 응답');
    const exp = await exportJson(b);
    assert.ok(!JSON.stringify(exp).includes('forged'));
    assert.deepStrictEqual(statuses(b), ['success', 'success']);
  });

  // ------------------------------------------------------------------------
  await test('T8 handshake 실패 → scripting 재주입 복구, 재주입 guard(listener 1개)', async () => {
    state.blockInjectFirstLoadOf = { url: GENERAL_URL, untilLoad: 1, blockScripting: false };
    const b = newBrowser([sec(1, 'General', '/settings', '#main')]);
    await start(b);
    await waitStatus(b, 'completed', 30000);
    assert.strictEqual(b.stats.executeScriptCalls, 1);
    assert.strictEqual(b.stats.reloads, 0);
    assert.strictEqual(b.session().results[0].status, 'success');
    assert.strictEqual(b.session().results[0].attempts, 1);
    // 재주입 guard: 같은 컨텍스트에 여러 번 주입해도 listener 는 1개
    const tab = { id: 999, url: GENERAL_URL };
    const page = b._makePage(tab, tab.url, b.fixtures(tab.url, tab, b));
    ['security.js', 'extractor.js', 'metadata.js', 'content.js'].forEach((f) => page.win.eval(read(f)));
    ['security.js', 'extractor.js', 'metadata.js', 'content.js'].forEach((f) => page.win.eval(read(f)));
    assert.strictEqual(page.listeners.length, 1);
    page.win.close();
  });

  await test('T9a 주입도 막히면 reload(hard) 복구 후 성공', async () => {
    state.blockInjectFirstLoadOf = { url: GENERAL_URL, untilLoad: 1, blockScripting: true };
    const b = newBrowser([sec(1, 'General', '/settings', '#main')], { navigation: { navigationTimeoutMs: 2500, handshakeTimeoutMs: 700, reloadRetryCount: 1 } });
    await start(b);
    await waitStatus(b, 'completed', 30000);
    const r = b.session().results[0];
    assert.strictEqual(r.status, 'success');
    assert.strictEqual(r.attempts, 2);
    assert.strictEqual(b.stats.reloads, 1);
    assert.strictEqual(b.stats.executeScriptCalls, 1);
  });

  await test('T9b 복구 횟수 소진 → timeout 기록 후 다음 Section 계속', async () => {
    state.neverInject = true;
    const b = newBrowser([sec(1, 'Security', '/settings/security_analysis', '#sec'), sec(2, 'General', '/settings', '#main')],
      { navigation: { navigationTimeoutMs: 2500, handshakeTimeoutMs: 600, reloadRetryCount: 1 } });
    await start(b);
    await waitStatus(b, 'completed', 30000);
    const s = b.session();
    assert.deepStrictEqual(statuses(b), ['timeout', 'success']);
    assert.strictEqual(s.results[0].error.type, 'handshake_timeout');
    assert.strictEqual(s.results[0].error.phase, 'handshaking');
    assert.strictEqual(s.results[0].attempts, 2);
    assert.strictEqual(b.stats.reloads, 1, '무한 reload 하지 않음');
  });

  await test('T22 페이지 로딩 지연: navigation timeout → 목표 URL 재이동 1회 → timeout 기록 후 다음 Section 계속', async () => {
    const b = newBrowser([sec(1, 'Collaborators', '/settings/access', 'main'), sec(2, 'Security', '/settings/security_analysis', '#sec')],
      { navigation: { navigationTimeoutMs: 1200, handshakeTimeoutMs: 1500, reloadRetryCount: 1 } });
    b.loadDelayFn = (url) => (/\/settings\/access$/.test(url) ? 3500 : 30); // 첫 Section 은 응답이 매우 느리다
    await start(b);
    await waitStatus(b, 'completed', 30000);
    const s = b.session();
    assert.deepStrictEqual(statuses(b), ['timeout', 'success']);
    assert.strictEqual(s.results[0].error.type, 'navigation_timeout');
    assert.strictEqual(s.results[0].attempts, 2);
    assert.strictEqual(b.stats.reloads, 0, '커밋되지 않은 이동은 reload 가 아니라 목표 URL 재이동으로 복구');
    assert.strictEqual(b.stats.navigations.filter((u) => /\/settings\/access$/.test(u)).length, 2);
    assert.strictEqual(s.results[1].attempts, 1);
  });

  await test('T10 always-reload 모드: Section 마다 정확히 1회 hard reload', async () => {
    const b = newBrowser([sec(1, 'General', '/settings', '#main'), sec(2, 'Collaborators', '/settings/access', 'main')],
      { navigation: { mode: 'always-reload', navigationTimeoutMs: 2500, handshakeTimeoutMs: 1500, reloadRetryCount: 1 } });
    await start(b);
    await waitStatus(b, 'completed', 30000);
    assert.deepStrictEqual(statuses(b), ['success', 'success']);
    assert.strictEqual(b.stats.reloads, 2);
    assert.strictEqual(b.stats.loads[GENERAL_URL], 2);
  });

  // ------------------------------------------------------------------------
  await test('T11 DOM 안정화 정책: proceed(경고) / fail(timeout)', async () => {
    const ex = { sectionTimeoutMs: 6000, rootTimeoutMs: 1500, domStableTimeMs: 150, domStableTimeoutMs: 600, ignoreTags: ['nav', 'footer'] };
    const b1 = newBrowser([sec(1, 'Noisy', '/settings/noisy', 'main')], { extraction: Object.assign({ onDomStabilityTimeout: 'proceed' }, ex) });
    await start(b1);
    await waitStatus(b1, 'completed', 20000);
    const r = b1.session().results[0];
    assert.strictEqual(r.status, 'success');
    assert.ok(r.warnings.includes('dom_stability_timeout'));
    const exp = await exportJson(b1);
    assert.strictEqual(exp.sections[0].data.meta.stability.stable, false);
    assert.ok(exp.sections[0].data.items.some((i) => i.key === 'noisy_flag'));

    const b2 = newBrowser([sec(1, 'Noisy', '/settings/noisy', 'main')], { extraction: Object.assign({ onDomStabilityTimeout: 'fail' }, ex) });
    await start(b2);
    await waitStatus(b2, 'completed', 20000);
    assert.strictEqual(b2.session().results[0].status, 'timeout');
    assert.strictEqual(b2.session().results[0].error.type, 'dom_stability_timeout');
  });

  await test('T12 config 검증 / 대상 Repository 판별', async () => {
    const b = newBrowser([sec(1, 'A', '/settings', 'main'), sec(1, 'B', 'settings', 'main', { actions: [{ type: 'click', selector: 'x' }] })]);
    const r = await start(b);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'invalid_config');
    assert.ok(r.details.some((d) => /중복/.test(d)) && r.details.some((d) => /path/.test(d)) && r.details.some((d) => /expand/.test(d)), JSON.stringify(r.details));
    const b2 = newBrowser([sec(1, 'A', '/settings', 'main')]);
    for (const bad of ['https://github.com/settings/profile', 'https://example.com/o/r', 'https://github.com/o', 'chrome://extensions']) {
      const x = await start(b2, bad);
      assert.strictEqual(x.error, 'not_a_repository', bad);
    }
    const st = await send(b2, { type: 'GSE_GET_STATE', activeTabUrl: 'https://github.com/o/r/pull/3' });
    assert.deepStrictEqual(st.candidate, { owner: 'o', name: 'r', url: 'https://github.com/o/r' });
    assert.strictEqual(st.session, null);
  });

  await test('T13 CAPTCHA / 429 감지: 분석하지 않고 일시 중지', async () => {
    const b = newBrowser([sec(1, 'Captcha', '/settings/captcha', 'main')]);
    await start(b);
    await waitStatus(b, 'interrupted', 20000);
    assert.strictEqual(b.session().pauseReason, 'captcha_required');
    assert.strictEqual(b.dataKeys().length, 0);
    const b2 = newBrowser([sec(1, 'Rate', '/settings/ratelimit', 'main')]);
    await start(b2);
    await waitStatus(b2, 'interrupted', 20000);
    assert.strictEqual(b2.session().pauseReason, 'rate_limited');
    assert.strictEqual(b2.dataKeys().length, 0);
    // 일반 페이지에 숨겨진 captcha 필드가 있어도 오탐하지 않는다
    const b3 = newBrowser([sec(1, 'Normal', '/settings/hiddencaptcha', 'main')]);
    await start(b3);
    await waitStatus(b3, 'completed', 20000);
    assert.strictEqual(b3.session().results[0].status, 'success');
  });

  await test('T14 metadata(선택): 화면에 보이는 값만, 없으면 not_collected', async () => {
    const b = newBrowser([sec(1, 'Security', '/settings/security_analysis', '#sec')], { metadata: { enabled: true, mode: 'visible-dom-only' } });
    await start(b);
    await waitStatus(b, 'completed', 30000);
    assert.strictEqual(b.stats.navigations[0], 'https://github.com/o/r');
    assert.strictEqual(b.session().plan[0].kind, 'metadata');
    const exp = await exportJson(b);
    assert.strictEqual(exp.sections.length, 1, 'metadata 는 sections 에 섞이지 않음');
    assert.strictEqual(exp.summary.total, 1);
    const md = exp.repository.metadata;
    assert.strictEqual(md.fields.stars, '12');
    assert.strictEqual(md.fields.forks, '3');
    assert.deepStrictEqual(md.fields.topics, ['js', 'web']);
    assert.strictEqual(md.fields.visibilityLabel, 'Public');
    assert.strictEqual(md.fields.contributors, null);
    assert.ok(/not collected/.test(md.notCollected.contributors));
    assert.strictEqual(md.fields.description, null);
    const txt = await exportTxt(b);
    assert.ok(txt.includes('Metadata (visible-dom-only): partial') && txt.includes('- contributors: not_collected'), txt.slice(0, 900));
  });

  await test('T18 이어받기 정책: config 수정 반영 / retryFailed=false / skipSuccessful=false', async () => {
    const mk = (root) => [sec(1, 'General', '/settings', '#main'), sec(2, 'Security', '/settings/security_analysis', root)];
    const b = newBrowser(mk('#wrong'));
    await start(b);
    await waitStatus(b, 'completed', 30000);
    assert.deepStrictEqual(statuses(b), ['success', 'failed']);
    b.configure(mk('#sec'));          // 사용자가 selector 를 고치고 확장프로그램을 새로고침했다고 가정
    const rr = await send(b, { type: 'GSE_RESUME' });
    assert.ok(rr.ok, JSON.stringify(rr));
    await waitStatus(b, 'completed', 30000);
    const s = b.session();
    assert.deepStrictEqual(statuses(b), ['success', 'success']);
    assert.strictEqual(b.stats.loads[GENERAL_URL], 1);
    assert.strictEqual(s.results[1].history[0].status, 'failed');
    assert.strictEqual(s.results[1].history[0].error.type, 'root_not_found', '기존 실패 기록 보존');
    assert.strictEqual((await send(b, { type: 'GSE_RESUME' })).error, 'nothing_to_resume');

    const b2 = newBrowser(mk('#wrong'), { resume: { skipSuccessfulSections: true, retryFailedSections: false } });
    await start(b2);
    await waitStatus(b2, 'completed', 30000);
    assert.strictEqual((await send(b2, { type: 'GSE_RESUME' })).error, 'nothing_to_resume');

    const b3 = newBrowser(mk('#sec'), { resume: { skipSuccessfulSections: false, retryFailedSections: true } });
    await start(b3);
    await waitStatus(b3, 'completed', 30000);
    const rr3 = await send(b3, { type: 'GSE_RESUME' });
    assert.ok(rr3.ok, JSON.stringify(rr3));
    await waitStatus(b3, 'completed', 30000);
    assert.deepStrictEqual(b3.session().results.map((r) => r.attempts), [2, 2]);
  });

  await test('T19 결과 크기 제한: 잘림을 숨기지 않고 표시', async () => {
    const b = newBrowser([sec(1, 'General', '/settings', '#main')], {
      extraction: { sectionTimeoutMs: 6000, rootTimeoutMs: 1500, domStableTimeMs: 150, domStableTimeoutMs: 1500, ignoreTags: ['nav', 'footer'], maxSectionBytes: 3000 }
    });
    await start(b);
    await waitStatus(b, 'completed', 30000);
    const data = JSON.parse(JSON.stringify(b.storage['gse:data:s1']));
    assert.ok(JSON.stringify(data).length <= 3000, 'size ' + JSON.stringify(data).length);
    assert.ok(data.meta.warnings.includes('size_limit_applied'));
    assert.ok(data.meta.truncated.items || data.meta.truncated.textBlocks);
    assert.ok(b.session().results[0].warnings.includes('size_limit_applied'));
    const txt = await exportTxt(b);
    assert.ok(/truncated|size_limit_applied/.test(txt));
  });

  await test('T20 브라우저 재시작(onStartup): 실행 중 세션은 interrupted 로 보존 → 새 Shadow Tab 으로 이어받기', async () => {
    state.slowMs = 900;
    const b = newBrowser([sec(1, 'General', '/settings', '#main'), sec(2, 'Slow', '/settings/slow', 'main')]);
    await start(b);
    await waitPhase(b, 1, 'waiting_for_root');
    const oldTab = b.session().shadowTabId;
    b.killBackground();
    b.pages.get(oldTab).win.close(); b.pages.delete(oldTab); b.tabs.delete(oldTab); // 브라우저 종료: 이벤트 없이 사라짐
    b._emit('onStartup');
    await waitStatus(b, 'interrupted', 5000);
    assert.strictEqual(b.session().pauseReason, 'session_interrupted');
    assert.strictEqual(b.session().shadowTabId, null);
    assert.deepStrictEqual(statuses(b), ['success', 'interrupted']);
    assert.ok(b.dataKeys().includes('gse:data:s1'));
    const rr = await send(b, { type: 'GSE_RESUME' });
    assert.ok(rr.ok, JSON.stringify(rr));
    await waitStatus(b, 'completed', 30000);
    assert.deepStrictEqual(statuses(b), ['success', 'success']);
    assert.notStrictEqual(b.stats.tabsCreated, 1);
  });

  await test('T21 새로 시작: 기존 결과/data 키 삭제, 초기화는 실행 중 거부', async () => {
    state.slowMs = 900;
    const b = newBrowser([sec(1, 'General', '/settings', '#main'), sec(2, 'Slow', '/settings/slow', 'main')]);
    await start(b);
    await waitPhase(b, 1, 'waiting_for_root');
    assert.strictEqual((await send(b, { type: 'GSE_RESET' })).error, 'running');
    await waitStatus(b, 'completed', 30000);
    const id1 = b.session().sessionId;
    assert.ok(b.dataKeys().length === 2);
    state.slowMs = 50;
    b.configure([sec(1, 'Security', '/settings/security_analysis', '#sec')]);
    await start(b);
    await waitStatus(b, 'completed', 30000);
    assert.notStrictEqual(b.session().sessionId, id1);
    assert.deepStrictEqual(b.dataKeys(), ['gse:data:s1'], '이전 세션의 data 키 삭제');
    assert.ok((await send(b, { type: 'GSE_RESET' })).ok);
    assert.strictEqual(b.session(), undefined);
    assert.strictEqual(b.dataKeys().length, 0);
    assert.strictEqual((await send(b, { type: 'GSE_GET_EXPORT', format: 'txt' })).error, 'no_session');
  });

  // ------------------------------------------------------------------------
  await test('T15 extractor 단위: deep query, ignore, 제한, 라벨 우선순위, 중복, 민감값', async () => {
    const dom = new JSDOM(`<!doctype html><body>
<div id="r" class="x"><span class="x"></span><div id="host"></div><div id="chost"></div>
  <label id="lbl">Labelled by</label><input aria-labelledby="lbl" name="lb" value="v1">
  <input name="aria" aria-label="Aria wins" value="v2"><label for="both">Label ignored</label><input id="both" name="both" aria-label="Aria first" value="v3">
  <input placeholder="Only placeholder" name="ph" value="v4">
  <span id="desc1">Described by this</span><input name="dd" aria-label="DD" aria-describedby="desc1" value="v5">
  <input name="dup" aria-label="Dup A" value="1"><input name="dup" aria-label="Dup B" value="2">
  <input name="otp" autocomplete="one-time-code" aria-label="Code" value="123456">
  <input type="number" name="n" aria-label="Count" value="42"><input type="checkbox" name="ind" aria-label="Indeterminate">
  <select name="multi" aria-label="Multi" multiple><option value="a" selected>A</option><option value="b" selected>B</option><option value="c">C</option></select>
  <div hidden><input name="hid" aria-label="Hidden control" value="h"></div>
  <details><summary>Closed</summary><input name="in_details" aria-label="In details"></details>
  <input type="hidden" name="hid_token" value="zzz">
</div></body>`, { runScripts: 'outside-only' });
    const w = dom.window;
    ['security.js', 'extractor.js'].forEach((f) => w.eval(read(f)));
    const Ex = w.GSE_Extractor;
    const d = w.document;
    const r = d.getElementById('r');
    d.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<span class="x"></span><input name="sh" aria-label="Shadow" value="s">';
    d.getElementById('chost').attachShadow({ mode: 'closed' }).innerHTML = '<span class="x"></span>';
    d.getElementById('ind') ; d.querySelector('[name=ind]').indeterminate = true;
    // deep query
    assert.strictEqual(Ex.deepQuerySelectorAll(r, '.x').length, 3, 'root 자신 + 일반 + 열린 shadow(닫힌 것은 제외)');
    let errs = 0;
    assert.strictEqual(Ex.deepQuerySelectorAll(r, '[[', { onError: () => { errs++; } }).length, 0);
    assert.strictEqual(errs, 1);
    assert.strictEqual(Ex.deepQuerySelector(r, 'input[name=sh]').name, 'sh');
    assert.strictEqual(Ex.deepQuerySelector(r, '#r'), r, 'root 자신');
    // extract
    const clone = (o) => JSON.parse(JSON.stringify(o)); // jsdom realm 객체를 main realm 으로 옮겨 비교
    const out = clone(Ex.extract(r, { ignoreSelectors: ['[[', '.nothing'], ignoreTags: [] }));
    const it = (k) => out.items.find((i) => i.key === k);
    assert.strictEqual(it('lb').label, 'Labelled by'); assert.strictEqual(it('lb').labelSource, 'aria-labelledby');
    assert.strictEqual(it('aria').labelSource, 'aria-label');
    assert.strictEqual(it('both').label, 'Aria first');
    assert.strictEqual(it('ph').label, 'Only placeholder'); assert.strictEqual(it('ph').labelSource, 'placeholder');
    assert.strictEqual(it('dd').description, 'Described by this');
    assert.deepStrictEqual(out.items.filter((i) => i.key.indexOf('dup') === 0).map((i) => i.key), ['dup', 'dup#2']);
    assert.strictEqual(it('otp').redacted, true); assert.strictEqual(it('otp').redactReason, 'sensitive_autocomplete');
    assert.strictEqual(it('n').value, 42);
    assert.strictEqual(it('ind').state.indeterminate, true);
    assert.deepStrictEqual(it('multi').value, ['A', 'B']);
    assert.deepStrictEqual(it('multi').state.selectedValues, ['a', 'b']);
    assert.ok(!it('hid'), 'hidden 속성 요소 제외'); assert.ok(!it('in_details')); assert.ok(!it('hid_token'));
    assert.ok(it('sh'), '열린 shadow');
    assert.ok(out.meta.errors.some((e) => e.type === 'selector_error'), '잘못된 ignore selector 는 기록만 하고 계속');
    // includeHiddenElements
    const out2 = clone(Ex.extract(r, { includeHiddenElements: true }));
    assert.ok(out2.items.some((i) => i.key === 'hid') && out2.items.some((i) => i.key === 'in_details'));
    assert.ok(!out2.items.some((i) => i.key === 'hid_token' && i.value), 'hidden input 값은 설정과 무관하게 저장 안 함');
    const out3 = clone(Ex.extract(r, { includeHiddenElements: true, skipHiddenInputs: false }));
    const ht = out3.items.find((i) => i.key === 'hid_token');
    assert.ok(ht && ht.redacted && ht.value === null && ht.redactReason === 'hidden_input');
    // 제한
    const out4 = clone(Ex.extract(r, { maxItemsPerSection: 3 }));
    assert.strictEqual(out4.items.length, 3); assert.strictEqual(out4.meta.truncated.items, true);
    // root 가 ignore selector 와 일치
    const out5 = clone(Ex.extract(r, { ignoreSelectors: ['#r'] }));
    assert.ok(out5.meta.warnings.includes('root_matches_ignore_selector') && out5.items.length > 3);
    // root 밖은 읽지 않는다
    const outside = d.createElement('input'); outside.name = 'outside'; outside.setAttribute('aria-label', 'Outside'); d.body.appendChild(outside);
    assert.ok(!clone(Ex.extract(r, {})).items.some((i) => i.key === 'outside'));
  });

  await test('T15b extractor: Chrome 의 checkVisibility 가 display:contents 에 false 를 주는 경우에도 하위 control 을 누락하지 않음', async () => {
    const dom = new JSDOM(`<!doctype html><body><div id="r">
      <div style="display:contents"><div style="display:contents"><input name="wrapped" aria-label="Wrapped" value="1"></div></div>
      <div style="display:none"><input name="gone" aria-label="Gone" value="2"></div>
      <div style="visibility:hidden"><input name="invisible" aria-label="Invisible" value="3"></div>
      <slot></slot><p>Visible paragraph</p>
    </div></body>`, { runScripts: 'outside-only' });
    const w = dom.window;
    // Chrome 의 Element.checkVisibility() 동작을 흉내 낸다: 박스가 없으면(display:none / contents) false
    w.Element.prototype.checkVisibility = function () { const cs = w.getComputedStyle(this); return cs.display !== 'none' && cs.display !== 'contents' && cs.visibility !== 'hidden'; };
    ['security.js', 'extractor.js'].forEach((f) => w.eval(read(f)));
    const out = JSON.parse(JSON.stringify(w.GSE_Extractor.extract(w.document.getElementById('r'), {})));
    const keys = out.items.map((i) => i.key);
    assert.ok(keys.includes('wrapped'), 'display:contents 래퍼 하위 누락: ' + JSON.stringify(keys));
    assert.ok(!keys.includes('gone') && !keys.includes('invisible'));
    assert.ok(out.textBlocks.some((t) => /Visible paragraph/.test(t.text)));
  });

  await test('T15c extractor: 실제 GitHub 실행 결과에서 드러난 문제(context 오귀속, Loading 잡음, UUID id, 토글 버튼 텍스트, legend)', async () => {
    const dom = new JSDOM(`<!doctype html><body><main id="r">
      <h1>Settings: o/r</h1>
      <h2>Features</h2>
      <div><label><input type="checkbox" name="wiki" checked> Wikis</label><p>Wikis host documentation. <span role="status">Loading</span> <span>Loading</span></p></div>
      <div><h3>Get organized with issue templates</h3><p>Give contributors templates.</p></div>
      <div><label><input type="checkbox" name="sponsor"> Sponsorships</label><p>Help your community.</p></div>
      <div><h3>Display a Sponsor button</h3><p>Sponsor block.</p></div>
      <div><label><input type="checkbox" name="projects" checked> Projects</label></div>
      <h2>Pull Requests</h2>
      <h3>Default commit message</h3>
      <div><label><input type="checkbox" name="squash" checked> Allow squash merging</label></div>
      <h2>Danger Zone</h2>
      <h3>Security</h3>
      <button id="action-menu-9b10cc4a-5ec2-46d3-a393-a553d92dac7d-button" aria-haspopup="true" aria-label="Check runs threshold"><span>High or higher</span></button>
      <button aria-pressed="false" aria-label="Dependabot alerts"><span>Enable</span></button>
      <button aria-pressed="true"><span>Push protection</span></button>
      <fieldset><legend>Choose whether Actions can approve pull requests.</legend><label><input type="checkbox" name="can_approve"> Allow Actions to approve</label></fieldset>
    </main></body>`, { runScripts: 'outside-only' });
    const w = dom.window;
    ['security.js', 'extractor.js'].forEach((f) => w.eval(read(f)));
    const out = JSON.parse(JSON.stringify(w.GSE_Extractor.extract(w.document.getElementById('r'), { ignoreTextPatterns: ['^Loading(\\.\\.\\.|…)?$'] })));
    const it = (k) => out.items.find((i) => i.key === k);
    // section 수준(h2)으로 묶이고, 소제목은 nearestHeading 으로만 남는다
    assert.strictEqual(it('wiki').context, 'Features');
    assert.strictEqual(it('sponsor').context, 'Features');
    assert.strictEqual(it('sponsor').nearestHeading, 'Get organized with issue templates');
    assert.strictEqual(it('projects').context, 'Features');
    assert.strictEqual(it('squash').context, 'Pull Requests');
    // Loading 잡음 제거(role=status + 패턴)
    assert.strictEqual(it('wiki').description, 'Wikis host documentation.');
    // UUID 가 들어간 id 는 key 근거로 쓰지 않는다
    const dd = out.items.find((i) => i.type === 'dropdown-trigger');
    assert.strictEqual(dd.keyBasis, 'label');
    assert.ok(!/9b10cc4a/.test(dd.key), dd.key);
    assert.ok(dd.source.id.indexOf('9b10cc4a') > 0, 'source.id 에는 원본이 남는다');
    assert.ok(!('expanded' in dd.state), 'null 상태는 제거');
    // 버튼에 보이는 글자
    const dep = out.items.find((i) => i.label === 'Dependabot alerts');
    assert.strictEqual(dep.value, false);
    assert.strictEqual(dep.state.text, 'Enable');
    const push = out.items.find((i) => i.label === 'Push protection');
    assert.ok(!('text' in push.state), '라벨과 같은 글자는 중복 기록하지 않음');
    // fieldset legend 는 checkbox 의 groupLabel 로 남는다
    assert.strictEqual(it('can_approve').groupLabel, 'Choose whether Actions can approve pull requests.');
    // Security 처럼 h2 가 하나뿐이면 h3 가 section 수준
    const dom2 = new JSDOM(`<!doctype html><body><main id="r"><h1>T</h1><h2>Advanced</h2><h3>Dependabot</h3><button aria-pressed="false" aria-label="Alerts"></button><h3>Code Security</h3><h4>Tools</h4><button aria-pressed="true" aria-label="Autofix"></button></main></body>`, { runScripts: 'outside-only' });
    ['security.js', 'extractor.js'].forEach((f) => dom2.window.eval(read(f)));
    const o2 = JSON.parse(JSON.stringify(dom2.window.GSE_Extractor.extract(dom2.window.document.getElementById('r'), {})));
    assert.strictEqual(o2.items.find((i) => i.label === 'Alerts').context, 'Dependabot');
    assert.strictEqual(o2.items.find((i) => i.label === 'Autofix').context, 'Code Security');
    assert.strictEqual(o2.items.find((i) => i.label === 'Autofix').nearestHeading, 'Tools');
  });

  await test('T16 security 단위: 식별자/값 패턴', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
    dom.window.eval(read('security.js'));
    const S = dom.window.GSE_Security;
    ['password', 'user_token', 'X-Session-Id', 'Authorization', 'api-key', 'private_key', 'client-secret', 'access_key', 'csrf_param', '비밀번호', 'GitHub PAT', 'github_pat_x'].forEach((s) => assert.ok(S.isSensitiveIdentifier(s), s));
    ['Repository name', 'path', 'pattern', 'compass', 'bypass list', 'footprint', 'description'].forEach((s) => assert.ok(!S.isSensitiveIdentifier(s), 'false positive: ' + s));
    const samples = ['ghp_' + 'a'.repeat(36), 'github_pat_' + 'A'.repeat(30), 'AKIAABCDEFGHIJKLMNOP', 'xoxb-1234567890-abcdef', 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----', 'password=abc12345678', 'Authorization: Bearer abcdefghijklmnop1234'];
    samples.forEach((s) => assert.ok(S.scrubString('x ' + s + ' y').redacted, 'not scrubbed: ' + s));
    assert.ok(!S.scrubString('Password: required').redacted);
    const deep = S.scrubDeep({ a: ['ok', 'ghp_' + 'b'.repeat(36)], b: { c: 'AKIAABCDEFGHIJKLMNOP' } });
    assert.strictEqual(deep.count, 2);
    assert.ok(!JSON.stringify(deep.value).includes('AKIA'));
  });

  await test('T17 popup 스모크: 저장된 세션에서 UI 복구, 시작/복사 버튼', async () => {
    const b = newBrowser([sec(1, 'General', '/settings', '#main'), sec(2, 'Security', '/settings/security_analysis', '#sec')]);
    const html = fs.readFileSync(path.join(EXT_DIR, 'popup.html'), 'utf8').replace(/<script[^>]*><\/script>/, '').replace(/<link[^>]*>/, '');
    const mkPopup = () => {
      const dom = new JSDOM(html, { url: 'chrome-extension://testextensionid/popup.html', runScripts: 'outside-only', pretendToBeVisual: true });
      const win = dom.window;
      win.__copied = null;
      win.chrome = { runtime: { sendMessage: (m) => b.deliverToBackground(m, {}) }, tabs: { query: async () => [{ id: 1, url: 'https://github.com/o/r/settings', active: true }] } };
      Object.defineProperty(win.navigator, 'clipboard', { value: { writeText: async (t) => { win.__copied = t; } } });
      win.eval(read('popup.js'));
      return win;
    };
    const $ = (w, id) => w.document.getElementById(id);
    let w = mkPopup();
    await sleep(300);
    assert.strictEqual($(w, 'repoName').textContent, 'o/r');
    assert.strictEqual($(w, 'startBtn').disabled, false);
    assert.strictEqual($(w, 'resumeBtn').disabled, true);
    assert.strictEqual($(w, 'stopBtn').disabled, true);
    assert.strictEqual($(w, 'copyTxt').disabled, true);
    assert.strictEqual($(w, 'progressText').textContent, 'Progress: 0 / 2');
    $(w, 'startBtn').click();
    await waitStatus(b, 'completed', 30000);
    w.close(); // popup 을 닫아도 작업은 영향 없음
    w = mkPopup(); // 다시 열면 저장된 세션에서 복구
    await sleep(1500);
    assert.strictEqual($(w, 'statusPill').textContent, '완료');
    assert.strictEqual($(w, 'progressText').textContent, 'Progress: 2 / 2');
    assert.strictEqual($(w, 'cntSuccess').textContent, '2');
    assert.strictEqual($(w, 'segments').children.length, 2);
    assert.ok($(w, 'preview').value.includes('[1] General'), $(w, 'preview').value.slice(0, 100));
    assert.strictEqual($(w, 'startBtn').disabled, false);
    // 새로 시작은 확인 단계가 필요
    $(w, 'startBtn').click();
    assert.strictEqual($(w, 'startBtn').textContent, '기존 결과를 지우고 시작');
    assert.strictEqual(b.stats.tabsCreated, 1);
    $(w, 'copyTxt').click();
    await sleep(200);
    assert.ok(w.__copied && w.__copied.includes('[1] General'));
    $(w, 'copyJson').click();
    await sleep(200);
    assert.strictEqual(JSON.parse(w.__copied).schemaVersion, 1);
    $(w, 'viewJson').click();
    await sleep(1300);
    assert.ok($(w, 'preview').value.trim().startsWith('{'));
    w.close();
  });

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
  process.exit(failed.length ? 1 : 0);
})();
