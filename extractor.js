/*
 * GitHub Settings Exporter - extractor.js
 *
 * 공통 DOM extractor. 페이지별 selector 에 기대지 않고 아래 신호만으로 설정 항목을 정규화한다.
 *   input / textarea / select / checkbox / radio, ARIA custom control(role, aria-*), 현재 선택 상태,
 *   headings / legend, label, 가까운 설명 블록.
 *
 * 원칙
 *  - 지정한 root subtree 밖은 읽지 않는다. selectors.ignore 에 걸린 요소(와 그 하위)는 제외한다.
 *  - 열린 Shadow Root 만 탐색한다. 닫힌 Shadow Root 우회(chrome.dom.openOrClosedShadowRoot 등)는 하지 않는다.
 *  - iframe 내부는 탐색하지 않는다.
 *  - password / hidden input 의 값은 읽지 않는다. 식별자에 민감 패턴이 있으면 값은 저장하지 않는다.
 *  - 이 모듈은 로드만으로 DOM 을 건드리지 않는다. content.js 가 요청할 때만 동작한다.
 */
(function (global) {
  'use strict';
  if (global.GSE_Extractor) return;

  var Sec = global.GSE_Security;
  if (!Sec) throw new Error('GSE_Security must be loaded before extractor.js');

  // ---------------------------------------------------------------------------
  // 상수
  // ---------------------------------------------------------------------------
  var SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'link', 'meta', 'head', 'svg',
    'iframe', 'canvas', 'audio', 'video', 'object', 'embed', 'tool-tip']);
  var HEADING_LEVEL = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };
  var INLINE_TAGS = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'kbd',
    'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr', 'relative-time']);
  var INPUT_NON_VALUE_TYPES = new Set(['submit', 'button', 'reset', 'image', 'file']);
  var CHECKED_SELECTION_ROLES = new Set(['menuitemcheckbox', 'menuitemradio', 'option', 'treeitem']);
  var TOGGLE_ROLES = new Set(['switch', 'checkbox', 'radio']);
  var DROPDOWN_CONTAINER_ROLES = new Set(['listbox', 'menu', 'tablist', 'radiogroup', 'tree', 'grid', 'combobox', 'menubar']);
  var ROW_SELECTOR = 'tr, li, [role="row"], [role="listitem"]';
  var MAX_DESCRIPTION_CLIMB = 5;
  var MAX_DESCRIPTION_CONTAINER_TEXT = 1200;

  // ---------------------------------------------------------------------------
  // 작은 유틸
  // ---------------------------------------------------------------------------
  function normText(s) {
    return s == null ? '' : String(s).replace(/\s+/g, ' ').trim();
  }

  function posInt(v, d) {
    var n = Number(v);
    return isFinite(n) && n > 0 ? Math.floor(n) : d;
  }

  function isElement(n) { return !!n && n.nodeType === 1; }
  function isShadowRoot(n) { return !!n && n.nodeType === 11 && !!n.host; }

  function getParentEl(node) {
    if (!node) return null;
    if (node.parentElement) return node.parentElement;
    var p = node.parentNode;
    if (p && isShadowRoot(p)) return p.host;
    return null;
  }

  function cssEscape(s) {
    if (global.CSS && typeof global.CSS.escape === 'function') return global.CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, function (ch) { return '\\' + ch; });
  }

  function getById(rootNode, id) {
    if (!id) return null;
    try {
      if (rootNode && typeof rootNode.getElementById === 'function') return rootNode.getElementById(id);
    } catch (_) { /* ignore */ }
    return null;
  }

  function ariaBool(v) {
    if (v == null) return null;
    v = String(v).toLowerCase();
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v === 'mixed') return 'mixed';
    return null;
  }

  function slug(s) {
    return normText(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  }

  function isUnstableId(id) {
    // React useId(:r1:), 숫자가 길게 섞인 자동 생성 id 등은 key 근거로 쓰지 않는다.
    return /^:.*:$/.test(id) || /\d{4,}/.test(id) || /^[a-f0-9]{8,}$/i.test(id) || /^(?:react-)?aria-?\d+/i.test(id)
      || /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(id) || /[-_][0-9a-f]{8,}(?:[-_]|$)/i.test(id);
  }

  // ---------------------------------------------------------------------------
  // 일반 DOM + 열린 Shadow DOM 탐색
  // ---------------------------------------------------------------------------

  /** root 아래의 탐색 범위(scope): root 자신 + root 아래에서 발견되는 모든 "열린" shadowRoot. */
  function collectScopes(root) {
    var scopes = [];
    var seen = new Set();
    var stack = [root];
    while (stack.length) {
      var scope = stack.pop();
      if (!scope || seen.has(scope)) continue;
      seen.add(scope);
      scopes.push(scope);
      if (isElement(scope) && scope.shadowRoot) stack.push(scope.shadowRoot);
      var all;
      try { all = scope.querySelectorAll('*'); } catch (_) { continue; }
      for (var i = 0; i < all.length; i++) {
        var sr = all[i].shadowRoot; // 닫힌 shadow root 는 null 이다. 우회하지 않는다.
        if (sr) stack.push(sr);
      }
    }
    return scopes;
  }

  /**
   * root subtree 안(열린 shadow root 포함)에서 selector 에 맞는 모든 요소.
   * root 자신이 일치하는 경우도 포함한다. selector 오류는 throw 하지 않고 opts.onError 로 알린다.
   */
  function deepQuerySelectorAll(root, selector, opts) {
    var onError = opts && opts.onError;
    var out = [];
    var seen = new Set();
    var scopes = collectScopes(root);
    for (var s = 0; s < scopes.length; s++) {
      var scope = scopes[s];
      try {
        if (isElement(scope) && scope.matches(selector) && !seen.has(scope)) { seen.add(scope); out.push(scope); }
        var list = scope.querySelectorAll(selector);
        for (var i = 0; i < list.length; i++) {
          if (!seen.has(list[i])) { seen.add(list[i]); out.push(list[i]); }
        }
      } catch (e) {
        if (onError) onError(selector, e);
        return out;
      }
    }
    return out;
  }

  function deepQuerySelector(root, selector, opts) {
    var onError = opts && opts.onError;
    var scopes = collectScopes(root);
    for (var s = 0; s < scopes.length; s++) {
      var scope = scopes[s];
      try {
        if (isElement(scope) && scope.matches(selector)) return scope;
        var el = scope.querySelector(selector);
        if (el) return el;
      } catch (e) {
        if (onError) onError(selector, e);
        return null;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // 가시성
  // ---------------------------------------------------------------------------
  function isRendered(el) {
    if (el.hidden) return false;
    var view = el.ownerDocument && el.ownerDocument.defaultView;
    if (typeof el.checkVisibility === 'function') {
      try {
        if (el.checkVisibility({ checkVisibilityCSS: true })) return true;
        // display: contents 요소는 박스가 없어 checkVisibility() 가 false 를 주지만 자식은 화면에 보인다.
        // (이런 래퍼를 숨김으로 오판하면 하위 설정이 통째로 누락된다) 자식은 각자 다시 검사한다.
        var cs0 = view && view.getComputedStyle(el);
        return !!cs0 && cs0.display === 'contents' && cs0.visibility !== 'hidden';
      } catch (_) { /* fallthrough */ }
    }
    try {
      if (!view) return true;
      var cs = view.getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    } catch (_) { return true; }
  }

  function compilePatterns(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (p) {
      try { out.push(new RegExp(p, 'i')); } catch (_) { /* 잘못된 패턴은 무시 */ }
    });
    return out;
  }

  /** 텍스트 노드 전체가 ignoreTextPatterns 에 일치하면 버린다(예: 스피너의 "Loading"). */
  function isIgnoredText(ctx, raw) {
    var res = ctx && ctx.opts && ctx.opts.ignoreTextRes;
    if (!res || !res.length) return false;
    var t = normText(raw);
    if (!t) return false;
    for (var i = 0; i < res.length; i++) if (res[i].test(t)) return true;
    return false;
  }

  // ---------------------------------------------------------------------------
  // 보이는 텍스트
  // ---------------------------------------------------------------------------
  /**
   * node 하위의 사용자에게 보이는 텍스트(정규화). script/style, 컨트롤 값(select option 등), skipSet 요소는 제외.
   * opts.includeRootHidden: aria-labelledby 대상처럼 숨겨진 요소도 루트로 허용.
   */
  function visibleText(node, ctx, skipSet, includeRootHidden) {
    var parts = [];
    var includeHidden = ctx && ctx.opts.includeHiddenElements;
    function rec(n, isRoot) {
      if (n.nodeType === 3) { if (!isIgnoredText(ctx, n.nodeValue)) parts.push(n.nodeValue); return; }
      if (n.nodeType !== 1) return;
      var t = n.localName;
      if (SKIP_TAGS.has(t)) return;
      if (!isRoot && (n.getAttribute('role') || '').toLowerCase() === 'status') return; // 상태 안내(live region)는 설정 값이 아니다
      if (skipSet && skipSet.has(n)) return;
      if (ctx && ctx.opts.ignoreTags.has(t)) return;
      if (ctx && ctx.ignored.has(n)) return;
      if (!isRoot || !includeRootHidden) {
        if (!includeHidden && !isRendered(n)) return;
        if (n.getAttribute('aria-hidden') === 'true' && !isRoot) return;
      }
      if (!isRoot && (t === 'select' || t === 'textarea' || t === 'input' || t === 'option')) return;
      var inline = INLINE_TAGS.has(t);
      if (!inline) parts.push(' ');
      for (var c = n.firstChild; c; c = c.nextSibling) rec(c, false);
      if (n.shadowRoot) for (var d = n.shadowRoot.firstChild; d; d = d.nextSibling) rec(d, false);
      if (!inline) parts.push(' ');
    }
    rec(node, true);
    return normText(parts.join(''));
  }

  // ---------------------------------------------------------------------------
  // 분류
  // ---------------------------------------------------------------------------
  function classify(el, opts) {
    var tag = el.localName;
    var role = (el.getAttribute('role') || '').toLowerCase();

    if (tag === 'input') {
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'hidden') return opts.skipHiddenInputs ? null : { kind: 'hidden-input', type: 'hidden' };
      if (INPUT_NON_VALUE_TYPES.has(type)) return null;
      if (type === 'checkbox' && role === 'switch') return { kind: 'switch', type: 'switch' };
      if (type === 'checkbox' || type === 'radio') return { kind: type, type: type };
      if (role === 'combobox') return { kind: 'text', type: 'combobox' };
      return { kind: 'text', type: type };
    }
    if (tag === 'select') return { kind: 'select', type: 'select' };
    if (tag === 'textarea') return { kind: 'textarea', type: 'textarea' };

    var popup = el.getAttribute('aria-haspopup');
    var hasPopup = !!popup && popup !== 'false';
    var isButtonish = tag === 'button' || tag === 'summary' || role === 'button';

    if (el.hasAttribute('aria-checked')) {
      if (TOGGLE_ROLES.has(role)) return { kind: 'aria-checked', type: role };
      if (CHECKED_SELECTION_ROLES.has(role)) {
        return el.getAttribute('aria-checked') === 'true' ? { kind: 'selected-option', type: 'selected-option' } : null;
      }
    }
    if (role === 'combobox' || role === 'listbox') return { kind: 'dropdown', type: role };
    if (hasPopup && isButtonish) return { kind: 'dropdown-trigger', type: 'dropdown-trigger' };
    if (el.hasAttribute('aria-pressed') && isButtonish) return { kind: 'toggle-button', type: 'toggle-button' };
    if (tag === 'summary') {
      var p = el.parentElement;
      return p && p.localName === 'details' ? { kind: 'disclosure', type: 'details' } : null;
    }
    if (el.hasAttribute('aria-expanded') && isButtonish) return { kind: 'disclosure', type: 'disclosure' };
    if (el.getAttribute('aria-selected') === 'true') return { kind: 'selected-option', type: 'selected-option' };
    return null;
  }

  // 설명 블록 계산에서 "주요 control" 로 세는 kind (disclosure / selected-option 은 세지 않음)
  var PRIMARY_KINDS = new Set(['text', 'textarea', 'select', 'checkbox', 'radio', 'switch', 'aria-checked',
    'dropdown', 'dropdown-trigger', 'toggle-button', 'hidden-input']);

  // ---------------------------------------------------------------------------
  // extract
  // ---------------------------------------------------------------------------
  function normalizeOptions(o) {
    o = o || {};
    return {
      includeHiddenElements: !!o.includeHiddenElements,
      skipHiddenInputs: o.skipHiddenInputs !== false,
      redactSensitiveValues: o.redactSensitiveValues !== false,
      ignoreSelectors: Array.isArray(o.ignoreSelectors) ? o.ignoreSelectors.filter(function (s) { return typeof s === 'string' && s.trim(); }) : [],
      ignoreTextRes: compilePatterns(o.ignoreTextPatterns),
      ignoreTags: new Set((Array.isArray(o.ignoreTags) ? o.ignoreTags : []).map(function (t) { return String(t).toLowerCase(); })),
      maxItems: posInt(o.maxItemsPerSection, 3000),
      maxTextBlocks: posInt(o.maxTextBlocks, 800),
      maxStringLength: posInt(o.maxStringLength, 4000),
      maxDescriptionLength: posInt(o.maxDescriptionLength, 400),
      maxLabelLength: posInt(o.maxLabelLength, 300),
      maxTextBlockLength: posInt(o.maxTextBlockLength, 800)
    };
  }

  /**
   * root 요소 하위에서 설정 정보를 추출한다.
   * @returns {{headings:Array, items:Array, textBlocks:Array, meta:Object}}
   */
  function extract(root, options) {
    var opts = normalizeOptions(options);
    var ctx = {
      root: root,
      opts: opts,
      ignored: new Set(),
      consumedEls: new Set(),     // 라벨/설명으로 이미 사용된 요소 (text block 중복 방지)
      consumedBlocks: new Set(),  // 설명으로 사용된 block 요소
      consumedSelected: new Set(),
      displayCache: new WeakMap(),
      errors: [],
      warnings: [],
      stats: { hiddenSkipped: 0, ignoredElements: 0, duplicatesRemoved: 0, redactedItems: 0, openShadowRoots: 0, iframesSkipped: 0 },
      truncated: { items: false, textBlocks: false, strings: false }
    };
    var flags = ctx.truncated;

    function onSelectorError(sel, e) {
      ctx.errors.push({ type: 'selector_error', selector: sel, message: String(e && e.message || e) });
    }

    // 1) ignore 집합
    for (var i = 0; i < opts.ignoreSelectors.length; i++) {
      var found = deepQuerySelectorAll(root, opts.ignoreSelectors[i], { onError: onSelectorError });
      for (var j = 0; j < found.length; j++) {
        if (found[j] === root) { ctx.warnings.push('root_matches_ignore_selector'); continue; }
        ctx.ignored.add(found[j]);
      }
    }
    ctx.stats.ignoredElements = ctx.ignored.size;

    // 2) DOM 순서 전체 순회: heading / control entry 수집
    var headings = [];
    var entries = [];
    var tracker = [];                  // [{level, text}]
    var headingEvents = [];            // DOM 순서의 heading 이벤트 [{level, text}] (section context 계산용)
    var visited = new Set();
    var lastHeadingKey = '';

    function currentContext() {
      return tracker.length ? tracker[tracker.length - 1].text : '';
    }
    function pushTracker(level, text) {
      while (tracker.length && tracker[tracker.length - 1].level >= level) tracker.pop();
      tracker.push({ level: level, text: text });
    }

    var stack = [root];
    while (stack.length) {
      var node = stack.pop();
      if (!node || visited.has(node)) continue;
      visited.add(node);

      if (isElement(node)) {
        var tag = node.localName;
        if (tag === 'iframe') { ctx.stats.iframesSkipped++; continue; }
        if (SKIP_TAGS.has(tag)) continue;
        if (ctx.ignored.has(node)) continue;
        if (node !== root && opts.ignoreTags.has(tag)) { ctx.stats.ignoredElements++; continue; }

        var isHiddenInput = tag === 'input' && (node.getAttribute('type') || '').toLowerCase() === 'hidden';
        if (!isHiddenInput && !opts.includeHiddenElements && !isRendered(node)) { ctx.stats.hiddenSkipped++; continue; }

        // heading / legend
        var level = HEADING_LEVEL[tag];
        var isRoleHeading = (node.getAttribute('role') || '').toLowerCase() === 'heading';
        if (level || isRoleHeading || tag === 'legend') {
          var ht = visibleText(node, ctx);
          if (ht) {
            var hl = level || (isRoleHeading ? posInt(node.getAttribute('aria-level'), 2) : null);
            var hk = (hl || 'legend') + '|' + ht;
            if (hk !== lastHeadingKey) {
              headings.push({ level: hl, tag: tag === 'legend' ? 'legend' : (level ? tag : 'role=heading'), text: clip(ht, opts.maxLabelLength) });
              lastHeadingKey = hk;
            }
            if (hl) { pushTracker(hl, clip(ht, opts.maxLabelLength)); headingEvents.push({ level: hl, text: clip(ht, opts.maxLabelLength) }); }
          }
          ctx.consumedEls.add(node);
        }

        var cls = classify(node, opts);
        if (cls) entries.push({ el: node, kind: cls.kind, type: cls.type, context: currentContext(), hseq: headingEvents.length });

        // 닫힌 <details>: summary 만 계속 탐색(내용은 화면에 보이지 않으므로 제외)
        var children = [];
        if (tag === 'details' && !node.open && !opts.includeHiddenElements) {
          for (var c0 = node.firstElementChild; c0; c0 = c0.nextElementSibling) {
            if (c0.localName === 'summary') children.push(c0);
          }
        } else {
          if (node.shadowRoot) { ctx.stats.openShadowRoots++; children.push(node.shadowRoot); }
          for (var c1 = node.firstElementChild; c1; c1 = c1.nextElementSibling) children.push(c1);
        }
        for (var k = children.length - 1; k >= 0; k--) stack.push(children[k]);
      } else if (isShadowRoot(node)) {
        var kids = [];
        for (var c2 = node.firstElementChild; c2; c2 = c2.nextElementSibling) kids.push(c2);
        for (var k2 = kids.length - 1; k2 >= 0; k2--) stack.push(kids[k2]);
      } else {
        // root 가 Element 가 아닌 예외적인 경우(Document 등)
        var kids2 = [];
        for (var c3 = node.firstElementChild; c3; c3 = c3.nextElementSibling) kids2.push(c3);
        for (var k3 = kids2.length - 1; k3 >= 0; k3--) stack.push(kids2[k3]);
      }
    }

    // 2.5) context 결정. "가장 가까운 앞선 heading" 은 카드/안내 블록의 소제목에 끌려가 엉뚱한 항목 아래로 묶이므로,
    //      페이지에서 2번 이상 나타나는 가장 얕은 heading 수준(>=2)을 "section 수준"으로 보고 그 수준 이하의 heading 만 context 로 쓴다.
    //      가장 가까운 heading 은 nearest 로 따로 유지한다(라벨 fallback, nearestHeading).
    var sectionLevel = (function () {
      var counts = {};
      headingEvents.forEach(function (h) { if (h.level >= 2) counts[h.level] = (counts[h.level] || 0) + 1; });
      var levels = Object.keys(counts).map(Number).sort(function (a, b) { return a - b; });
      for (var i = 0; i < levels.length; i++) if (counts[levels[i]] >= 2) return levels[i];
      return levels.length ? levels[0] : 1;
    })();
    var sectionAt = [''];
    headingEvents.forEach(function (h, i) { sectionAt[i + 1] = h.level <= sectionLevel ? h.text : sectionAt[i]; });
    entries.forEach(function (e) { e.nearest = e.context; e.context = sectionAt[e.hseq] || ''; });

    // 3) 설명 블록 계산용: 각 요소 아래의 주요 control 수
    var controlCount = new Map();
    for (var e0 = 0; e0 < entries.length; e0++) {
      if (!PRIMARY_KINDS.has(entries[e0].kind)) continue;
      var anc = entries[e0].el;
      var guard = 0;
      while (anc && guard++ < 60) {
        controlCount.set(anc, (controlCount.get(anc) || 0) + 1);
        if (anc === root) break;
        anc = getParentEl(anc);
      }
    }

    // 4) 라벨/값/설명 -> item
    var items = [];
    var usedKeys = new Set();
    var seenSig = new Set();

    for (var e1 = 0; e1 < entries.length; e1++) {
      if (items.length >= opts.maxItems) { flags.items = true; break; }
      var entry = entries[e1];
      if (entry.kind === 'selected-option' && ctx.consumedSelected.has(entry.el)) continue;
      var item;
      try {
        item = buildItem(entry);
      } catch (err) {
        ctx.errors.push({ type: 'item_error', tag: entry.el.localName, message: String(err && err.message || err) });
        continue;
      }
      if (!item) continue;
      var sig = [item.type, item.key || '', item.label || '', JSON.stringify(item.value), item.context || ''].join('|');
      if (seenSig.has(sig) && item.type !== 'radio') { ctx.stats.duplicatesRemoved++; continue; }
      seenSig.add(sig);
      item.key = uniqueKey(item.key, usedKeys);
      if (item.redacted) ctx.stats.redactedItems++;
      items.push(item);
    }

    // 5) 남은 텍스트 -> textBlocks
    var textBlocks = collectTextBlocks();

    // 6) 결과 조립 + 최종 scrub
    var data = {
      headings: headings,
      items: items,
      textBlocks: textBlocks,
      meta: {
        counts: {
          headings: headings.length,
          items: items.length,
          textBlocks: textBlocks.length,
          hiddenSkipped: ctx.stats.hiddenSkipped,
          ignoredElements: ctx.stats.ignoredElements,
          redactedItems: ctx.stats.redactedItems,
          duplicatesRemoved: ctx.stats.duplicatesRemoved,
          openShadowRoots: ctx.stats.openShadowRoots,
          iframesSkipped: ctx.stats.iframesSkipped
        },
        truncated: flags,
        warnings: ctx.warnings,
        errors: ctx.errors,
        root: { tag: root.localName || null, id: root.id || null }
      }
    };
    if (!items.length) ctx.warnings.push('no_controls_found');
    if (!headings.length) ctx.warnings.push('no_headings_found');
    if (ctx.stats.iframesSkipped) ctx.warnings.push('iframes_not_traversed');

    var scrubbed = Sec.scrubDeep(data);
    scrubbed.value.meta.counts.redactedStrings = scrubbed.count;
    return scrubbed.value;

    // ------------------------------------------------------------------
    // 내부 함수들 (ctx 를 공유하기 위해 extract 안에 둔다)
    // ------------------------------------------------------------------
    function clip(s, max) {
      if (typeof s !== 'string') return s;
      if (max > 0 && s.length > max) { flags.strings = true; return s.slice(0, max) + '…'; }
      return s;
    }

    function displayOf(el) {
      var d = ctx.displayCache.get(el);
      if (d) return d;
      try {
        var view = el.ownerDocument.defaultView;
        d = view ? view.getComputedStyle(el).display : 'block';
      } catch (_) { d = 'block'; }
      ctx.displayCache.set(el, d);
      return d;
    }

    function uniqueKey(key, used) {
      var base = key;
      var n = 1;
      while (used.has(key)) { n++; key = base + '#' + n; }
      used.add(key);
      return key;
    }

    function labelTextOf(labelEl, controlEl) {
      var skip = new Set();
      if (controlEl) skip.add(controlEl);
      return visibleText(labelEl, ctx, skip, true);
    }

    function getLabelElements(el) {
      var list = [];
      try { if (el.labels && el.labels.length) list = Array.prototype.slice.call(el.labels); } catch (_) { /* ignore */ }
      if (!list.length && el.id) {
        try {
          var rn = el.getRootNode();
          if (rn && rn.querySelectorAll) list = Array.prototype.slice.call(rn.querySelectorAll('label[for="' + cssEscape(el.id) + '"]'));
        } catch (_) { /* ignore */ }
      }
      if (!list.length) {
        try { var pl = el.closest('label'); if (pl) list = [pl]; } catch (_) { /* ignore */ }
      }
      return list;
    }

    function groupLabelOf(el) {
      var cur = getParentEl(el);
      var guard = 0;
      while (cur && guard++ < 30) {
        var t = cur.localName;
        var role = (cur.getAttribute('role') || '').toLowerCase();
        if (t === 'fieldset') {
          var lg = null;
          for (var c = cur.firstElementChild; c; c = c.nextElementSibling) { if (c.localName === 'legend') { lg = c; break; } }
          if (lg) { var lt = visibleText(lg, ctx, null, true); if (lt) { ctx.consumedEls.add(lg); return lt; } }
        }
        if (role === 'group' || role === 'radiogroup') {
          var al = normText(cur.getAttribute('aria-label'));
          if (al) return al;
          var lb = cur.getAttribute('aria-labelledby');
          if (lb) {
            var rn2 = cur.getRootNode();
            var texts = lb.split(/\s+/).map(function (id) { var n = getById(rn2, id); return n ? visibleText(n, ctx, null, true) : ''; }).filter(Boolean);
            if (texts.length) return texts.join(' ');
          }
        }
        if (cur === root) break;
        cur = getParentEl(cur);
      }
      return '';
    }

    // 라벨 우선순위: aria-label > aria-labelledby > label > 부모 label > legend/group > 주변 제목 > placeholder > DOM 텍스트
    // (button 류는 접근 가능한 이름이 본문 텍스트이므로 label 단계 바로 뒤에 본문 텍스트를 둔다)
    function resolveLabel(el, entry) {
      var al = normText(el.getAttribute('aria-label'));
      if (al) return { text: al, source: 'aria-label' };

      var lb = el.getAttribute('aria-labelledby');
      if (lb) {
        var rn = el.getRootNode();
        var texts = [];
        lb.split(/\s+/).forEach(function (id) {
          var n = getById(rn, id);
          if (n) { var t = labelTextOf(n, el); if (t) { texts.push(t); ctx.consumedEls.add(n); } }
        });
        if (texts.length) return { text: texts.join(' '), source: 'aria-labelledby' };
      }

      var labels = getLabelElements(el);
      if (labels.length) {
        var lts = [];
        labels.forEach(function (l) { var t = labelTextOf(l, el); if (t) { lts.push(t); ctx.consumedEls.add(l); } });
        if (lts.length) return { text: lts.join(' '), source: labels[0].contains(el) ? 'parent-label' : 'label' };
      }

      var buttonLike = entry.kind === 'toggle-button' || entry.kind === 'disclosure' || entry.kind === 'selected-option';
      if (buttonLike) {
        var own = visibleText(el, ctx);
        if (own) { ctx.consumedEls.add(el); return { text: own, source: 'text' }; }
      }

      var group = groupLabelOf(el);
      if (group) return { text: group, source: 'legend' };

      if (entry.nearest) return { text: entry.nearest, source: 'heading' };

      var ph = normText(el.getAttribute('placeholder'));
      if (ph) return { text: ph, source: 'placeholder' };

      if (entry.kind !== 'dropdown-trigger') {
        var own2 = visibleText(el, ctx);
        if (own2) return { text: own2, source: 'text' };
      }
      return { text: '', source: 'none' };
    }

    function pickSource(el) {
      var s = { tagName: el.tagName };
      var role = el.getAttribute('role'); if (role) s.role = role;
      if (el.localName === 'input') s.inputType = (el.getAttribute('type') || 'text').toLowerCase();
      if (el.id) s.id = el.id;
      var name = el.getAttribute('name'); if (name) s.name = name;
      var dts = el.getAttribute('data-test-selector'); if (dts) s.dataTestSelector = dts;
      var dti = el.getAttribute('data-testid'); if (dti) s.dataTestId = dti;
      return s;
    }

    function deriveKey(el, entry, label, index) {
      var name = el.getAttribute('name');
      var dti = el.getAttribute('data-testid');
      var dts = el.getAttribute('data-test-selector');
      var basis = null;
      var key = null;
      if (name) { basis = 'name'; key = name; }
      else if (dti) { basis = 'data-testid'; key = dti; }
      else if (dts) { basis = 'data-test-selector'; key = dts; }
      else if (el.id && !isUnstableId(el.id)) { basis = 'id'; key = el.id; }
      if (key && (entry.kind === 'checkbox' || entry.kind === 'radio') && el.getAttribute('value')) {
        key = key + '=' + el.getAttribute('value');
      }
      if (!key) {
        var ls = slug(label);
        if (ls) { basis = 'label'; key = 'label:' + ls; }
        else { basis = 'position'; key = (slug(entry.context) || 'root') + '/' + entry.type + '@' + index; }
      }
      return { key: key, basis: basis };
    }

    function sensitiveReason(el, entry, labelText) {
      if (entry.kind === 'hidden-input') return 'hidden_input';
      if (entry.type === 'password' || Sec.isSensitiveInputType(el.getAttribute('type'))) return 'password_field';
      if (Sec.isSensitiveAutocomplete(el.getAttribute('autocomplete'))) return 'sensitive_autocomplete';
      if (opts.redactSensitiveValues) {
        var ids = [el.getAttribute('name'), el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder'),
          el.getAttribute('data-testid'), el.getAttribute('data-test-selector'), el.getAttribute('autocomplete'), labelText];
        for (var i = 0; i < ids.length; i++) if (Sec.isSensitiveIdentifier(ids[i])) return 'sensitive_identifier';
      }
      return null;
    }

    function blockContainerOf(el) {
      // el 만 주요 control 인 가장 큰 조상(위로 MAX_DESCRIPTION_CLIMB 단계까지, 텍스트 양 제한)
      var cur = el;
      for (var i = 0; i < MAX_DESCRIPTION_CLIMB; i++) {
        if (cur === root) break;
        var parent = getParentEl(cur);
        if (!parent) break;
        if ((controlCount.get(parent) || 0) !== 1) break;
        if ((parent.textContent || '').length > MAX_DESCRIPTION_CONTAINER_TEXT) break;
        cur = parent;
      }
      return cur === el ? getParentEl(el) : cur;
    }

    function describe(el) {
      var parts = [];
      var did = el.getAttribute('aria-describedby');
      if (did) {
        var rn = el.getRootNode();
        did.split(/\s+/).forEach(function (id) {
          var n = getById(rn, id);
          if (n) { var t = visibleText(n, ctx, null, true); if (t) parts.push(t); ctx.consumedEls.add(n); }
        });
      }
      var container = blockContainerOf(el);
      if (container && container !== root) {
        var skip = new Set([el]);
        var blocks = gatherBlocks(container, skip, false);
        blocks.forEach(function (b) {
          if (b.text) parts.push(b.text);
          ctx.consumedBlocks.add(b.el);
        });
      }
      var seen = new Set();
      var uniq = parts.filter(function (p) { if (seen.has(p)) return false; seen.add(p); return true; });
      var text = uniq.join(' ');
      return text ? clip(text, opts.maxDescriptionLength) : '';
    }

    function ownerListContainer(el) {
      var cur = getParentEl(el);
      var guard = 0;
      while (cur && guard++ < 30) {
        var role = (cur.getAttribute('role') || '').toLowerCase();
        if (DROPDOWN_CONTAINER_ROLES.has(role)) {
          var l = normText(cur.getAttribute('aria-label'));
          return { role: role, label: l || undefined };
        }
        if (cur === root) break;
        cur = getParentEl(cur);
      }
      return null;
    }

    function buildItem(entry) {
      var el = entry.el;
      var kind = entry.kind;
      function addButtonText(node, lbl) {
        if (node.localName === 'input') return;
        var bt = visibleText(node, ctx);
        if (bt && bt !== lbl) item.state.text = clip(bt, 80); // 예: 버튼에 보이는 "Enable"/"Disable" 같은 글자
      }
      var li = resolveLabel(el, entry);
      var label = clip(li.text, opts.maxLabelLength);
      var item = {
        key: null, keyBasis: null,
        type: entry.type,
        label: label || null,
        labelSource: li.source,
        value: null,
        state: {}
      };
      var disabled = !!el.disabled || el.getAttribute('aria-disabled') === 'true';
      var required = !!el.required || el.getAttribute('aria-required') === 'true';

      switch (kind) {
        case 'checkbox':
        case 'radio':
          item.value = !!el.checked;
          item.state = { checked: !!el.checked, disabled: disabled, required: required };
          if (kind === 'checkbox' && el.indeterminate) item.state.indeterminate = true;
          if (kind === 'radio') {
            var gl = groupLabelOf(el);
            item.group = { key: el.getAttribute('name') || ('radio-group@' + (entry.context || 'root')), label: gl || entry.nearest || entry.context || null };
          }
          break;
        case 'switch':
          item.value = el.localName === 'input' ? !!el.checked : ariaBool(el.getAttribute('aria-checked'));
          item.state = { checked: item.value, disabled: disabled, required: required };
          break;
        case 'aria-checked':
          item.value = ariaBool(el.getAttribute('aria-checked'));
          item.state = { checked: item.value, disabled: disabled, required: required };
          addButtonText(el, label);
          break;
        case 'select': {
          var selected = [];
          var opt;
          if (el.multiple) {
            for (var i = 0; i < el.options.length; i++) { opt = el.options[i]; if (opt.selected) selected.push(opt); }
          } else if (el.selectedIndex >= 0) {
            selected.push(el.options[el.selectedIndex]);
          }
          var texts = selected.map(function (o) { return clip(normText(o.label || o.textContent), opts.maxStringLength); });
          var vals = selected.map(function (o) { return clip(String(o.value), opts.maxStringLength); });
          item.value = el.multiple ? texts : (texts.length ? texts[0] : null);
          item.state = { disabled: disabled, required: required };
          if (el.multiple) { item.state.multiple = true; item.state.selectedValues = vals; }
          else if (vals.length) item.state.selectedValue = vals[0];
          break;
        }
        case 'text':
        case 'textarea':
        case 'hidden-input':
        case 'dropdown': {
          var isFormValueEl = el.localName === 'input' || el.localName === 'textarea';
          var reason = isFormValueEl || kind === 'hidden-input' ? sensitiveReason(el, entry, label) : null;
          item.state = { disabled: disabled, required: required };
          if (isFormValueEl && (el.readOnly)) item.state.readOnly = true;
          if (reason) {
            item.redacted = true;
            item.redactReason = reason;
            item.value = null;
          } else if (isFormValueEl) {
            var raw = String(el.value == null ? '' : el.value);
            if (entry.type === 'number' || entry.type === 'range') {
              var num = raw.trim() === '' ? NaN : Number(raw);
              item.value = isFinite(num) ? num : clip(raw, opts.maxStringLength);
            } else {
              item.value = clip(raw, opts.maxStringLength);
            }
          } else {
            // role=combobox / listbox 인 비-input 요소: 선택된 하위 option 텍스트, 없으면 표시 텍스트
            var selOpts = [];
            try { selOpts = Array.prototype.slice.call(el.querySelectorAll('[aria-selected="true"], [aria-checked="true"]')); } catch (_) { /* ignore */ }
            if (selOpts.length) {
              item.value = clip(selOpts.map(function (n) { ctx.consumedSelected.add(n); return visibleText(n, ctx); }).filter(Boolean).join(', '), opts.maxStringLength);
            } else {
              item.value = clip(visibleText(el, ctx), opts.maxStringLength);
            }
            if (el.hasAttribute('aria-expanded')) item.state.expanded = ariaBool(el.getAttribute('aria-expanded'));
          }
          break;
        }
        case 'dropdown-trigger':
          item.value = clip(visibleText(el, ctx), opts.maxStringLength);
          item.state = { expanded: ariaBool(el.getAttribute('aria-expanded')), disabled: disabled, haspopup: el.getAttribute('aria-haspopup') };
          break;
        case 'toggle-button':
          item.value = ariaBool(el.getAttribute('aria-pressed'));
          item.state = { pressed: item.value, disabled: disabled };
          addButtonText(el, label);
          break;
        case 'disclosure':
          if (el.localName === 'summary') {
            item.value = !!(el.parentElement && el.parentElement.open);
          } else {
            item.value = ariaBool(el.getAttribute('aria-expanded'));
          }
          item.state = { expanded: item.value, disabled: disabled };
          break;
        case 'selected-option':
          item.value = true;
          item.state = { selected: true, disabled: disabled };
          item.selection = { role: (el.getAttribute('role') || '').toLowerCase() || null, container: ownerListContainer(el) };
          if (!item.selection.container) delete item.selection.container;
          break;
        default:
          return null;
      }

      if (kind !== 'selected-option' && kind !== 'disclosure') {
        var desc = describe(el);
        if (desc) item.description = desc;
      }
      if (entry.context) item.context = entry.context;
      if (entry.nearest && entry.nearest !== entry.context) item.nearestHeading = entry.nearest;
      if (kind !== 'radio' && kind !== 'selected-option') {
        var grp = groupLabelOf(el); // fieldset legend / role=group 이름
        if (grp && grp !== label) item.groupLabel = clip(grp, opts.maxLabelLength);
      }
      Object.keys(item.state).forEach(function (k) { if (item.state[k] === null || item.state[k] === undefined) delete item.state[k]; });
      item.source = pickSource(el);
      var dk = deriveKey(el, entry, label, e1);
      item.key = dk.key;
      item.keyBasis = dk.basis;
      return item;
    }

    /**
     * container 하위의 "블록 단위" 텍스트. inline 요소의 텍스트는 가장 가까운 block 조상에 합쳐진다.
     * 헤딩, 라벨(소비됨), 버튼/컨트롤, 숨김, 무시 요소는 제외한다.
     * trackHeadings=true 면 순회하며 만나는 heading 을 context 로 기록한다(text block 용).
     */
    function gatherBlocks(container, skipSet, trackHeadings) {
      var byBlock = new Map();
      var order = [];
      var localTracker = trackHeadings ? [] : null;

      function ctxOfTracker() { return localTracker && localTracker.length ? localTracker[localTracker.length - 1].text : ''; }

      function shouldSkip(el) {
        var t = el.localName;
        if (SKIP_TAGS.has(t)) return true;
        if (skipSet && skipSet.has(el)) return true;
        if (ctx.ignored.has(el) || ctx.consumedEls.has(el)) return true;
        if (el !== container && opts.ignoreTags.has(t)) return true;
        if (t === 'input' || t === 'select' || t === 'textarea' || t === 'option' || t === 'button' || t === 'label' || t === 'summary') return true;
        var role = (el.getAttribute('role') || '').toLowerCase();
        if (role === 'button' || role === 'switch' || role === 'checkbox' || role === 'radio' || role === 'combobox' || role === 'listbox' || role === 'tab' || role === 'status') return true;
        if (el.getAttribute('aria-hidden') === 'true') return true;
        if (!opts.includeHiddenElements && !isRendered(el)) return true;
        return false;
      }

      function add(blockEl, text) {
        var rec = byBlock.get(blockEl);
        if (!rec) {
          rec = { el: blockEl, parts: [], context: ctxOfTracker() };
          byBlock.set(blockEl, rec);
          order.push(rec);
        }
        rec.parts.push(text);
      }

      var visitedLocal = new Set();
      function visit(n, blockEl) {
        if (n.nodeType === 3) {
          var t = normText(n.nodeValue);
          if (t && !isIgnoredText(ctx, t)) add(blockEl, t);
          return;
        }
        if (n.nodeType === 11) { // shadow root
          for (var s = n.firstChild; s; s = s.nextSibling) visit(s, blockEl);
          return;
        }
        if (n.nodeType !== 1) return;
        if (visitedLocal.has(n)) return;
        visitedLocal.add(n);
        var tag = n.localName;
        if (trackHeadings && (HEADING_LEVEL[tag])) {
          var htx = visibleText(n, ctx);
          if (htx) { var lv = HEADING_LEVEL[tag]; while (localTracker.length && localTracker[localTracker.length - 1].level >= lv) localTracker.pop(); localTracker.push({ level: lv, text: clip(htx, opts.maxLabelLength) }); }
          return;
        }
        if (tag === 'legend' || (n.getAttribute('role') || '').toLowerCase() === 'heading') return;
        if (shouldSkip(n)) return;
        if (tag === 'details' && !n.open && !opts.includeHiddenElements) {
          // 닫힌 details 는 summary 외 내용 제외 (summary 는 disclosure item 이 소비)
          return;
        }
        var disp = displayOf(n);
        var inline = disp === 'inline' || disp === 'contents' || disp.indexOf('inline') === 0;
        var nextBlock = inline ? blockEl : n;
        for (var c = n.firstChild; c; c = c.nextSibling) visit(c, nextBlock);
        if (n.shadowRoot) visit(n.shadowRoot, nextBlock);
      }

      visit(container, container);
      return order.map(function (r) { return { el: r.el, text: normText(r.parts.join(' ')), context: r.context }; })
        .filter(function (b) { return b.text; });
    }

    function closestRow(el) {
      var cur = el;
      var guard = 0;
      while (cur && guard++ < 40) {
        if (cur !== root) {
          try { if (cur.matches(ROW_SELECTOR)) return cur; } catch (_) { /* ignore */ }
        }
        if (cur === root) break;
        cur = getParentEl(cur);
      }
      return null;
    }

    function collectTextBlocks() {
      var blocks = gatherBlocks(root, null, true);
      var rows = new Map();   // rowEl -> {texts, context, tag}
      var seq = [];           // 출력 순서
      blocks.forEach(function (b) {
        if (ctx.consumedBlocks.has(b.el)) return;
        var row = b.el === root ? null : closestRow(b.el);
        if (row) {
          var r = rows.get(row);
          if (!r) { r = { texts: [], context: b.context, tag: row.localName }; rows.set(row, r); seq.push(r); }
          r.texts.push(b.text);
        } else {
          seq.push({ texts: [b.text], context: b.context, tag: b.el.localName });
        }
      });
      var out = [];
      var seen = new Set();
      for (var i = 0; i < seq.length; i++) {
        var text = normText(seq[i].texts.join(' | '));
        if (text.length < 2 || !/[\p{L}\p{N}]/u.test(text)) continue;
        var sg = (seq[i].context || '') + '|' + text;
        if (seen.has(sg)) { ctx.stats.duplicatesRemoved++; continue; }
        seen.add(sg);
        if (out.length >= opts.maxTextBlocks) { flags.textBlocks = true; break; }
        var tb = { text: clip(text, opts.maxTextBlockLength), tag: seq[i].tag };
        if (seq[i].context) tb.context = seq[i].context;
        out.push(tb);
      }
      return out;
    }
  }

  // ---------------------------------------------------------------------------
  // expand action 안전성 검사 (content.js 가 사용)
  // ---------------------------------------------------------------------------
  var DANGEROUS_ASCII_RE = /\b(delete|remove|save|apply|confirm|transfer|revoke|disable|enable|archive|unarchive|rename|reset|regenerate|rotate|leave|detach|disconnect|unlink|sign\s*out|submit|update|create|add|invite|cancel|approve|deny|block|unblock|publish|unpublish|merge|restore)\b/i;
  var DANGEROUS_KO_RE = /삭제|제거|저장|적용|확인|이전|양도|취소|비활성|활성화|철회|폐기|보관|이름\s*변경|초기화|재생성|추가|초대|생성|제출|업데이트|승인|거부|차단|게시|병합|복원/;
  var STATE_ROLES = /^(switch|checkbox|radio|menuitemcheckbox|menuitemradio|option|tab)$/;

  /**
   * expand action 이 이 요소를 건드려도 되는지 판단한다.
   * 허용: <details>(닫혀 있는 것), aria-expanded="false" 인 펼침 컨트롤(버튼/summary/role=button).
   * 거부: 폼 제출 가능 버튼, 상태 토글 컨트롤, 링크 이동, 위험한 단어/스타일/rails-ujs 속성이 있는 컨트롤 등.
   */
  function checkExpandSafety(el, action) {
    var tag = el.localName;
    if (tag === 'details') return el.open ? { ok: false, reason: 'already_open' } : { ok: true };
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return { ok: false, reason: 'disabled' };

    var exp = el.getAttribute('aria-expanded');
    if (tag === 'summary' && exp == null) {
      var d = el.parentElement;
      if (!d || d.localName !== 'details') return { ok: false, reason: 'summary_without_details' };
      if (d.open) return { ok: false, reason: 'already_open' };
    } else if (exp !== 'false') {
      return { ok: false, reason: exp === 'true' ? 'already_expanded' : 'no_aria_expanded' };
    }
    var role = (el.getAttribute('role') || '').toLowerCase();
    var popup = el.getAttribute('aria-haspopup');
    if (popup && popup !== 'false' && !(action && action.includePopupControls)) return { ok: false, reason: 'popup_control_skipped' };
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return { ok: false, reason: 'form_value_control' };
    if (el.hasAttribute('aria-checked') || el.hasAttribute('aria-pressed') || STATE_ROLES.test(role)) return { ok: false, reason: 'state_toggle_control' };
    if (tag === 'a') {
      var href = el.getAttribute('href');
      if (href && href.charAt(0) !== '#') return { ok: false, reason: 'navigation_link' };
    }
    if (tag === 'button') {
      var type = (el.getAttribute('type') || '').toLowerCase();
      if (el.form && type !== 'button') return { ok: false, reason: 'may_submit_form' };
    }
    var attrs = ['data-confirm', 'data-method', 'data-disable-with', 'data-turbo-method', 'data-turbo-confirm', 'data-remote', 'formaction'];
    for (var i = 0; i < attrs.length; i++) if (el.hasAttribute(attrs[i])) return { ok: false, reason: 'action_attribute:' + attrs[i] };
    var cls = typeof el.className === 'string' ? el.className : '';
    if (/danger/i.test(cls)) return { ok: false, reason: 'danger_style' };
    var hay = [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('name'), el.id,
      el.getAttribute('data-testid'), el.getAttribute('data-test-selector'), normText(el.textContent).slice(0, 200)].join(' ');
    if (DANGEROUS_ASCII_RE.test(hay) || DANGEROUS_KO_RE.test(hay)) return { ok: false, reason: 'dangerous_label' };
    return { ok: true };
  }

  global.GSE_Extractor = {
    extract: extract,
    deepQuerySelector: deepQuerySelector,
    deepQuerySelectorAll: deepQuerySelectorAll,
    checkExpandSafety: checkExpandSafety,
    isRendered: isRendered,
    visibleText: function (node) { return visibleText(node, { opts: normalizeOptions({}), ignored: new Set() }); }
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
