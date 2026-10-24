/*
 * GitHub Settings Exporter - metadata.js  (content script)
 *
 * 선택 기능(config.metadata.enabled). Repository 메인 페이지의 "현재 DOM 에 보이는 정보"만 수집한다.
 *  - API 토큰을 요구/저장하지 않고, 인증 제한을 우회하지 않는다.
 *  - 화면에서 확인하지 못한 값은 추측하지 않고 null + notCollected[reason] 으로 남긴다.
 *  - 아래 selector 들은 GitHub UI 를 실제로 확인해 검증한 값이 아니라 "시도해 보는 후보"이다.
 *    UI 가 바뀌면 not_collected 가 될 수 있으며, 이는 Settings 추출에 영향을 주지 않는다.
 *  - 이후 공개 GitHub API 수집을 붙일 수 있도록 이 모듈로 분리해 두었다.
 */
(function (global) {
  'use strict';
  if (global.GSE_Metadata) return;

  function text(el) { return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : ''; }
  function first(doc, selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var el = null;
      try { el = doc.querySelector(selectors[i]); } catch (_) { /* 잘못된 selector 는 건너뜀 */ }
      if (el) return { el: el, selector: selectors[i] };
    }
    return null;
  }

  function extract(doc) {
    var loc = doc.location;
    var result = { status: 'success', mode: 'visible-dom-only', collectedAt: new Date().toISOString(), fields: {}, notCollected: {}, sources: {} };
    var f = result.fields;
    function miss(key, why) { f[key] = null; result.notCollected[key] = why; }
    function set(key, value, source) { f[key] = value; result.sources[key] = source; }

    var seg = loc.pathname.split('/').filter(Boolean);
    set('url', loc.origin + '/' + seg.slice(0, 2).join('/'), 'location');
    if (seg.length >= 2) { set('owner', seg[0], 'location'); set('name', seg[1], 'location'); }
    else { miss('owner', 'not a repository URL'); miss('name', 'not a repository URL'); }

    // 공개/비공개: 화면 라벨 후보 -> (없으면) not_collected. 텍스트는 UI 언어에 따라 달라질 수 있다.
    var vis = first(doc, ['#repo-title-component .Label', '[itemprop="name"] ~ .Label', 'strong[itemprop="name"] ~ span.Label', '.AppHeader-context-full .Label']);
    if (vis && text(vis.el)) set('visibilityLabel', text(vis.el), vis.selector); else miss('visibilityLabel', 'no visible visibility label matched');

    var desc = first(doc, ['.BorderGrid-cell p.f4', '[data-testid="repo-description"]', '[itemprop="about"]']);
    if (desc && text(desc.el)) set('description', text(desc.el), desc.selector); else miss('description', 'no description element matched (may be empty)');

    var topicEls = [];
    try { topicEls = Array.prototype.slice.call(doc.querySelectorAll('a[href^="/topics/"]')); } catch (_) { /* ignore */ }
    var topics = [];
    topicEls.forEach(function (a) { var t = text(a); if (t && topics.indexOf(t) < 0) topics.push(t); });
    if (topics.length) set('topics', topics.slice(0, 30), 'a[href^="/topics/"]'); else miss('topics', 'no topic links matched');

    var branch = first(doc, ['#branch-picker-repos-header-ref-selector', 'button[id*="branch-picker"]', '[data-hotkey="w"] .css-truncate-target']);
    if (branch && text(branch.el)) set('branchPickerText', text(branch.el), branch.selector); else miss('branchPickerText', 'branch picker not matched (shows the currently viewed branch, not necessarily the default)');

    [['stars', 'a[href$="/stargazers"]'], ['forks', 'a[href$="/forks"], a[href$="/network/members"]'], ['watchers', 'a[href$="/watchers"]']].forEach(function (p) {
      var m = first(doc, [p[1]]);
      if (m && text(m.el)) set(p[0], text(m.el), m.selector); else miss(p[0], 'summary link not matched');
    });

    var langs = [];
    try {
      Array.prototype.slice.call(doc.querySelectorAll('a[href*="search?l="], a[href*="/search?l="]')).forEach(function (a) {
        var m = /^(.+?)\s+([\d.]+)%$/.exec(text(a));
        if (m && !langs.some(function (x) { return x.name === m[1]; })) langs.push({ name: m[1], percent: Number(m[2]) });
      });
    } catch (_) { /* ignore */ }
    if (langs.length) set('languages', langs, 'a[href*="search?l="]'); else miss('languages', 'language bar links not matched');

    miss('contributors', 'not collected: requires data not shown on this page without the API');
    miss('recentCommitCadence', 'not collected: requires data not shown on this page without the API');

    var fromDom = Object.keys(result.sources).filter(function (k) { return result.sources[k] !== 'location'; });
    if (!fromDom.length) result.status = 'failed';
    else if (Object.keys(result.notCollected).length) result.status = 'partial';
    return result;
  }

  global.GSE_Metadata = { extract: extract };
})(typeof globalThis !== 'undefined' ? globalThis : self);
