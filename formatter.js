/*
 * GitHub Settings Exporter - formatter.js  (service worker 전용: importScripts 로 로드)
 *
 * 저장된 세션 + Section 데이터를 (1) 정규화된 최종 JSON, (2) 사람이 읽기 쉬운 TXT 로 만든다.
 * 출력 직전에 scrubDeep 을 한 번 더 적용한다(저장 이후에 규칙이 강화되었거나 저장 단계에서 놓친 값 대비).
 * summary 는 항상 실제 Section 상태에서 계산한다.
 */
(function (global) {
  'use strict';
  if (global.GSE_Formatter) return;

  var Sec = global.GSE_Security;
  var St = global.GSE_Storage;

  function slimError(e) {
    if (!e) return null;
    var o = { type: e.type, message: e.message, phase: e.phase || null, url: e.url || null, attempts: e.attempts == null ? null : e.attempts, at: e.at || null };
    if (e.finalUrl) o.finalUrl = e.finalUrl;
    if (e.details) o.details = e.details;
    return o;
  }

  // ---------------------------------------------------------------------------
  // JSON
  // ---------------------------------------------------------------------------
  function buildExport(session, dataMap) {
    dataMap = dataMap || {};
    var sections = [];
    var metadata = {};
    session.plan.forEach(function (entry, i) {
      var r = session.results[i];
      var raw = r.status === 'success' ? dataMap[St.dataKeyFor(entry)] : null;
      if (entry.kind === 'metadata') {
        metadata = raw ? raw : { status: r.status, error: slimError(r.error) };
        return;
      }
      var data = raw
        ? { headings: raw.headings || [], items: raw.items || [], textBlocks: raw.textBlocks || [], meta: raw.meta || null }
        : { headings: [], items: [], textBlocks: [] };
      var sec = {
        id: entry.id, name: entry.name, path: entry.path, url: entry.url,
        status: r.status, attempts: r.attempts, startedAt: r.startedAt, finishedAt: r.finishedAt,
        data: data, error: slimError(r.error)
      };
      if (r.skipReason) sec.skipReason = r.skipReason;
      if (r.warnings && r.warnings.length) sec.warnings = r.warnings;
      if (r.history && r.history.length) {
        sec.history = r.history.map(function (h) { return { status: h.status, attempts: h.attempts, finishedAt: h.finishedAt, error: slimError(h.error) }; });
      }
      sections.push(sec);
    });

    var exp = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      repository: { owner: session.repository.owner, name: session.repository.name, url: session.repository.url, metadata: metadata },
      session: {
        sessionId: session.sessionId, status: session.status, pauseReason: session.pauseReason || null,
        startedAt: session.startedAt, finishedAt: session.finishedAt
      },
      summary: St.computeSummary(session),
      sections: sections
    };
    return Sec.scrubDeep(exp).value;
  }

  function toJson(exp) { return JSON.stringify(exp, null, 2); }

  // ---------------------------------------------------------------------------
  // TXT
  // ---------------------------------------------------------------------------
  function oneLine(s) { return String(s).replace(/\r?\n/g, ' ⏎ ').replace(/\s+/g, ' ').trim(); }

  function valueText(it) {
    if (it.redacted) return '[REDACTED' + (it.redactReason ? ': ' + it.redactReason : '') + ']';
    var v = it.value;
    var st = it.state || {};
    switch (it.type) {
      case 'checkbox':
        if (v === 'mixed' || st.indeterminate) return 'indeterminate';
        return v ? 'checked' : 'unchecked';
      case 'radio':
        return v ? 'selected' : 'not selected';
      case 'switch':
        return v === 'mixed' ? 'mixed' : (v ? 'on' : 'off');
      case 'toggle-button':
        return v === 'mixed' ? 'mixed' : (v ? 'pressed' : 'not pressed');
      case 'details':
      case 'disclosure':
        return v ? 'expanded' : 'collapsed';
      case 'selected-option':
        return 'selected';
      case 'select': {
        if (Array.isArray(v)) return v.length ? v.map(oneLine).join(', ') : '(none)';
        if (v == null) return '(none)';
        var raw = st.selectedValue;
        return oneLine(v) + (raw != null && raw !== v ? ' (value: ' + oneLine(raw) + ')' : '');
      }
      case 'dropdown-trigger':
        return (v ? oneLine(v) : '(empty)') + ' [dropdown]';
      default:
        if (v === null || v === undefined) return '(none)';
        if (typeof v === 'boolean') return v ? 'true' : 'false';
        if (v === '') return '(empty)';
        return oneLine(v);
    }
  }

  function flagText(it) {
    var st = it.state || {};
    var f = [];
    if (st.disabled) f.push('disabled');
    if (st.required) f.push('required');
    if (st.readOnly) f.push('read-only');
    return f.length ? ' [' + f.join(', ') + ']' : '';
  }

  function itemLine(it) {
    if (it.type === 'selected-option') {
      var sel = it.selection || {};
      var where = [];
      if (sel.role) where.push('role: ' + sel.role);
      if (sel.container && sel.container.role) where.push('in: ' + sel.container.role + (sel.container.label ? ' "' + oneLine(sel.container.label) + '"' : ''));
      return '- Selected option: ' + oneLine(it.label || it.key || '') + (where.length ? ' (' + where.join(', ') + ')' : '') + flagText(it);
    }
    var btn = it.state && it.state.text ? ' (button text: "' + oneLine(it.state.text) + '")' : '';
    return '- ' + oneLine(it.label || it.key || '(unlabeled)') + ': ' + valueText(it) + btn + flagText(it);
  }

  function radioGroupLines(radios) {
    var g = radios[0].group || {};
    var label = g.label || radios[0].context || g.key || 'Radio group';
    var selected = radios.filter(function (r) { return r.value === true; }).map(function (r) { return oneLine(r.label || r.key); });
    var options = radios.map(function (r) { return oneLine(r.label || r.key) + (r.value === true ? '*' : ''); }).join(' | ');
    var anyDisabled = radios.some(function (r) { return r.state && r.state.disabled; });
    var lines = ['- ' + oneLine(label) + ': ' + (selected.length ? selected.join(', ') : '(none selected)') + (anyDisabled ? ' [some options disabled]' : '') + '  (options: ' + options + ')'];
    radios.forEach(function (r) {
      if (r.description) lines.push('    option "' + oneLine(r.label || r.key) + '": ' + oneLine(r.description));
    });
    return lines;
  }

  function itemLines(items) {
    var lines = [];
    var lastCtx = '';
    var groups = {};
    items.forEach(function (it) {
      if (it.type === 'radio' && it.group) (groups[it.group.key] = groups[it.group.key] || []).push(it);
    });
    var emitted = {};
    function ctxHeader(ctx) {
      if (ctx && ctx !== lastCtx) lines.push('  ## ' + oneLine(ctx));
      if (ctx) lastCtx = ctx;
    }
    items.forEach(function (it) {
      if (it.type === 'radio' && it.group) {
        if (emitted[it.group.key]) return;
        emitted[it.group.key] = true;
        ctxHeader(it.context || '');
        radioGroupLines(groups[it.group.key]).forEach(function (l) { lines.push(l); });
        return;
      }
      ctxHeader(it.context || '');
      lines.push(itemLine(it));
      if (it.groupLabel) lines.push('    group: ' + oneLine(it.groupLabel));
      if (it.description) lines.push('    note: ' + oneLine(it.description));
    });
    return lines;
  }

  function notesFor(meta) {
    var n = [];
    if (!meta) return n;
    var tr = meta.truncated || {};
    if (tr.items) n.push('items truncated (limit reached)');
    if (tr.textBlocks) n.push('text blocks truncated (limit reached)');
    if (tr.strings) n.push('some long strings were clipped');
    (meta.warnings || []).forEach(function (w) { n.push('warning: ' + w); });
    if (meta.errors && meta.errors.length) {
      var types = {};
      meta.errors.forEach(function (e) { types[e.type] = true; });
      n.push(meta.errors.length + ' extraction issue(s): ' + Object.keys(types).join(', '));
    }
    var c = meta.counts || {};
    if (c.redactedItems) n.push(c.redactedItems + ' item value(s) redacted');
    if (c.redactedStrings) n.push(c.redactedStrings + ' secret-like string(s) redacted');
    (meta.actions || []).forEach(function (a) {
      var sk = a.skipped && Object.keys(a.skipped).length ? ', skipped: ' + Object.keys(a.skipped).map(function (k) { return k + '=' + a.skipped[k]; }).join(' ') : '';
      n.push('action ' + a.type + ' "' + a.selector + '": performed ' + a.performed + '/' + a.matched + sk);
    });
    return n;
  }

  function sectionLines(sec, L) {
    L.push('[' + sec.id + '] ' + sec.name);
    L.push('URL: ' + sec.url);
    L.push('Status: ' + sec.status + (sec.skipReason ? ' (' + sec.skipReason + ')' : ''));
    if (sec.error) {
      L.push('Error: ' + sec.error.type + ' - ' + oneLine(sec.error.message) +
        (sec.error.phase ? ' (phase: ' + sec.error.phase + ', attempts: ' + sec.error.attempts + ')' : ''));
      if (sec.error.finalUrl) L.push('Final URL: ' + sec.error.finalUrl);
    }
    if (sec.history && sec.history.length) {
      L.push('Earlier attempts: ' + sec.history.map(function (h) { return h.status + (h.error ? ' (' + h.error.type + ')' : ''); }).join(', '));
    }
    if (sec.status !== 'success') return;
    var d = sec.data;
    if (d.headings && d.headings.length) L.push('Headings: ' + d.headings.map(function (h) { return oneLine(h.text); }).join(' | '));
    if (d.items && d.items.length) {
      L.push('Section:');
      itemLines(d.items).forEach(function (l) { L.push(l); });
    } else {
      L.push('Section: (no controls found)');
    }
    if (d.textBlocks && d.textBlocks.length) {
      L.push('Text:');
      var last = '';
      d.textBlocks.forEach(function (tb) {
        if (tb.context && tb.context !== last) { L.push('  ## ' + oneLine(tb.context)); last = tb.context; }
        L.push('- ' + oneLine(tb.text));
      });
    }
    var notes = notesFor(d.meta);
    if (notes.length) {
      L.push('Notes:');
      notes.forEach(function (x) { L.push('- ' + x); });
    }
  }

  function metadataLines(md, L) {
    if (!md || !Object.keys(md).length) return;
    L.push('Metadata (' + (md.mode || 'visible-dom-only') + '): ' + (md.status || 'unknown'));
    if (md.fields) {
      Object.keys(md.fields).forEach(function (k) {
        var v = md.fields[k];
        var text;
        if (v === null || v === undefined) text = 'not_collected' + (md.notCollected && md.notCollected[k] ? ' (' + md.notCollected[k] + ')' : '');
        else if (Array.isArray(v)) text = v.map(function (x) { return typeof x === 'object' ? JSON.stringify(x) : String(x); }).join(', ') || '(none)';
        else text = String(v);
        L.push('- ' + k + ': ' + oneLine(text));
      });
    }
    if (md.error) L.push('- error: ' + md.error.type + ' - ' + oneLine(md.error.message));
  }

  function toTxt(exp) {
    var L = [];
    var s = exp.summary;
    L.push('GitHub Repository Settings Export');
    L.push('Schema: ' + exp.schemaVersion);
    L.push('Repository: ' + exp.repository.owner + '/' + exp.repository.name);
    L.push('URL: ' + exp.repository.url);
    L.push('Session: ' + exp.session.status + (exp.session.pauseReason ? ' (' + exp.session.pauseReason + ')' : ''));
    L.push('Generated: ' + exp.generatedAt);
    L.push('Summary:');
    L.push('- Total: ' + s.total);
    L.push('- Success: ' + s.success);
    L.push('- Failed: ' + s.failed);
    L.push('- Timeout: ' + s.timeout);
    L.push('- Skipped: ' + s.skipped);
    if (s.interrupted) L.push('- Interrupted: ' + s.interrupted);
    if (s.pending) L.push('- Pending: ' + s.pending);
    metadataLines(exp.repository.metadata, L);
    exp.sections.forEach(function (sec) { L.push(''); sectionLines(sec, L); });
    var text = L.join('\n') + '\n';
    return Sec.scrubString(text).text;
  }

  global.GSE_Formatter = { buildExport: buildExport, toJson: toJson, toTxt: toTxt };
})(typeof globalThis !== 'undefined' ? globalThis : self);
