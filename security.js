/*
 * GitHub Settings Exporter - security.js
 *
 * 민감정보 판별/제거 로직. DOM에 의존하지 않으므로 content script(추출 시점)와
 * service worker(저장·출력 시점) 양쪽에서 같은 규칙을 사용한다. (다층 방어)
 *
 * 규칙 요약
 *  1) password / hidden input 의 값은 읽지 않는다(extractor.js 가 값 접근 전에 이 모듈로 판별).
 *  2) name / id / label / placeholder 등 "식별자"에 token, password, cookie ... 패턴이 있으면 값은 저장하지 않는다.
 *  3) 값 자체가 토큰/키 모양이면(예: ghp_..., AKIA..., PRIVATE KEY 블록, JWT) 어디에 있든 [REDACTED] 로 치환한다.
 */
(function (global) {
  'use strict';
  if (global.GSE_Security) return;

  var REDACTED = '[REDACTED]';

  // 식별자(속성/라벨 텍스트)에 이 패턴이 있으면 "텍스트 값"을 저장하지 않는다. 대소문자 구분 없음.
  var SENSITIVE_IDENTIFIER_RE = new RegExp([
    'pass(?:word|wd|phrase|code)',
    '(?:^|[^a-z0-9])pwd(?:[^a-z0-9]|$)',
    'token',
    'secret',
    'cookie',
    'session',
    'authori[sz]ation',
    'auth[-_ ]?header',
    'bearer',
    'api[-_ ]?key',
    'apikey',
    'private[-_ ]?key',
    'client[-_ ]?secret',
    'access[-_ ]?key',
    'secret[-_ ]?key',
    'signing[-_ ]?key',
    'ssh[-_ ]?key',
    'csrf',
    'xsrf',
    'authenticity',
    'credential',
    'one[-_ ]?time',
    '(?:^|[^a-z])otp(?:[^a-z]|$)',
    '(?:^|[^a-z])pat(?:[^a-z]|$)',
    // 한국어 UI 대응
    '비밀번호', '패스워드', '암호', '토큰', '시크릿', '쿠키', '인증\\s?키', '개인\\s?키', 'API\\s?키'
  ].join('|'), 'i');

  // autocomplete 토큰 중 민감한 것
  var SENSITIVE_AUTOCOMPLETE_RE = /(?:^|\s)(?:current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp)(?:\s|$)/i;

  // 값 자체가 비밀처럼 보이는 패턴(전역 치환용). String.replace 와만 사용하므로 lastIndex 문제는 없다.
  var SECRET_VALUE_PATTERNS = [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    /\bAIza[0-9A-Za-z_-]{30,}\b/g,
    /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{16,}/g,
    // key=value / key: value 형태(값에 숫자가 하나 이상 섞인 8자 이상 문자열)
    /\b(?:token|secret|password|passwd|pwd|api[_-]?key|access[_-]?key|authorization)\b\s*[:=]\s*(?=\S*\d)\S{8,}/gi
  ];

  function isSensitiveIdentifier(text) {
    return typeof text === 'string' && text.length > 0 && SENSITIVE_IDENTIFIER_RE.test(text);
  }

  function isSensitiveAutocomplete(value) {
    return typeof value === 'string' && SENSITIVE_AUTOCOMPLETE_RE.test(value);
  }

  function isSensitiveInputType(type) {
    return String(type || '').toLowerCase() === 'password';
  }

  function scrubString(str) {
    if (typeof str !== 'string' || str.length === 0) return { text: str, redacted: false };
    var out = str;
    var redacted = false;
    for (var i = 0; i < SECRET_VALUE_PATTERNS.length; i++) {
      out = out.replace(SECRET_VALUE_PATTERNS[i], function () {
        redacted = true;
        return REDACTED;
      });
    }
    return { text: out, redacted: redacted };
  }

  // 객체/배열 안의 모든 문자열 값을 scrub 한다(키는 건드리지 않음). 원본은 변경하지 않는다.
  function scrubDeep(value) {
    var count = 0;
    function walk(v) {
      if (typeof v === 'string') {
        var r = scrubString(v);
        if (r.redacted) count++;
        return r.text;
      }
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') {
        var o = {};
        var keys = Object.keys(v);
        for (var i = 0; i < keys.length; i++) o[keys[i]] = walk(v[keys[i]]);
        return o;
      }
      return v;
    }
    var result = walk(value);
    return { value: result, count: count };
  }

  global.GSE_Security = {
    REDACTED: REDACTED,
    isSensitiveIdentifier: isSensitiveIdentifier,
    isSensitiveAutocomplete: isSensitiveAutocomplete,
    isSensitiveInputType: isSensitiveInputType,
    scrubString: scrubString,
    scrubDeep: scrubDeep
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
