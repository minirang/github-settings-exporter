# GitHub Settings Exporter

GitHub 저장소의 설정 페이지를 순서대로 확인하고, 화면에 표시된 설정을 TXT 또는 JSON으로 내보내는 Chrome 확장 프로그램입니다. 설정값을 변경하지 않으며, 작업은 사용자가 시작하고 결과는 브라우저에 로컬 저장됩니다.

Manifest V3 기반으로 동작하며, 로그인 정보나 Secret 값은 읽지 않습니다. 민감한 값으로 보이는 데이터는 결과에서 제외하거나 가립니다.

> **검증 범위:** 오프라인 테스트는 가짜 Chrome API와 jsdom을 사용합니다. 실제 Chrome에서는 공개 저장소 하나의 8개 설정 섹션을 확인했습니다. 다른 계정, 권한, 조직 정책과 GitHub UI는 검증되지 않았으며, 기본 경로와 selector는 예시입니다.

## 주요 기능

- 설정 섹션을 순서대로 추출하고 진행 상태를 저장합니다.
- TXT 및 구조화된 JSON 결과를 미리 보고 복사할 수 있습니다.
- 작업을 중지하고 이어받을 수 있으며 성공한 섹션은 건너뜁니다.
- 별도의 백그라운드 탭에서 작업해 현재 보고 있는 탭을 유지합니다.
- 민감한 값은 여러 단계에서 검사하고, 결과를 외부 서버로 전송하지 않습니다.

## 목차

- [설치](#1-설치)
- [사용법](#2-사용법-팝업)
- [첫 테스트](#3-첫-테스트-general-하나만)
- [설정](#4-configjs-에서-수정하는-항목)
- [개인정보와 보안](#8-보안개인정보)
- [테스트](#10-테스트-현황)
- [알려진 한계](#12-알려진-한계)
- [문제 해결](#11-문제-해결)
- [기여하기](#기여하기)
- [라이선스](#라이선스)

## 요구 사항

- Google Chrome 114 이상
- GitHub 저장소 설정을 볼 수 있는 권한
- `https://github.com/*` 페이지 (GitHub Enterprise Server 등 다른 호스트는 지원하지 않습니다)

## 1. 설치

1. 이 폴더(`github-settings-exporter/`)를 원하는 위치에 둡니다. (zip 이면 압축을 풉니다)
2. Chrome 에서 `chrome://extensions` 를 엽니다.
3. 오른쪽 위 **개발자 모드**를 켭니다.
4. **압축해제된 확장 프로그램을 로드합니다** 를 누릅니다.
5. `manifest.json` 이 들어 있는 이 폴더를 선택합니다.
6. 확인할 Repository 페이지(`https://github.com/<owner>/<repo>` 아래 아무 페이지)를 열고 툴바의 확장프로그램 아이콘을 눌러 팝업을 엽니다.
7. 팝업의 Repository 표시가 맞는지 확인하고 **새로 시작**을 누릅니다.

- Chrome 114 이상이 필요합니다. `https://github.com/*` 만 지원하며 GitHub Enterprise Server 같은 다른 도메인은 지원하지 않습니다.
- `config.js` 를 수정한 뒤에는 `chrome://extensions` 에서 이 확장프로그램의 **새로고침(↻)** 을 눌러야 반영됩니다.
- `config.js` 에 문법 오류가 있으면 service worker 가 등록되지 않습니다(확장 프로그램 카드에 "서비스 워커(비활성)" 오류 표시). 오류 메시지를 보고 고치세요.

## 2. 사용법 (팝업)

| 버튼                 | 동작                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 새로 시작            | 현재 탭의 Repository 를 대상으로 새 세션을 시작합니다. 기존 결과가 있으면 한 번 더 눌러 확인해야 하며, 기존 결과는 삭제됩니다. |
| 이어받기             | 중지/중단된 세션을 이어갑니다. 성공한 Section 은 다시 추출하지 않고, 실패·timeout·중단·미처리 Section 만 처리합니다.           |
| 중지                 | 현재 상태를 저장하고 Shadow Tab 을 닫습니다. 이미 저장된 결과는 유지됩니다.                                                    |
| Shadow Tab 열기      | (로그인/인증 때문에 일시 중지됐을 때) 작업용 탭을 앞으로 가져옵니다. 거기서 직접 인증을 마친 뒤 이어받기를 누릅니다.           |
| 세션 초기화          | 세션과 저장된 결과를 모두 삭제합니다(실행 중에는 불가).                                                                        |
| TXT 복사 / JSON 복사 | **버튼을 눌렀을 때만** 클립보드에 복사합니다.                                                                                  |

- 사용자가 보고 있는 탭은 이동하지 않습니다. 작업은 `active: false` 인 **Shadow Tab** 하나에서 이루어지고, 끝나면(또는 중지하면) 닫힙니다.
- 팝업을 닫아도 작업은 계속되며, 다시 열면 저장된 세션에서 화면이 복구됩니다.
- 진행 막대의 칸 하나가 Section 하나입니다(초록=성공, 빨강=실패, 노랑=timeout, 보라=중단, 점선=건너뜀, 파랑 깜빡임=진행 중).

## 3. 첫 테스트 (General 하나만)

1. `config.js` 에서 `General` 을 제외한 모든 Section 의 `options.enabled` 를 `false` 로 바꿉니다.
   ```js
   options: { enabled: false, timeoutMs: 30000 }
   ```
2. 확장프로그램을 새로고침하고, 테스트할 Repository(설정 권한이 있는 것)의 아무 페이지에서 팝업을 열어 **새로 시작**을 누릅니다.
3. 아래를 하나씩 확인합니다.

- [ ] 팝업의 Repository 이름이 맞다.
- [ ] 원래 보던 탭이 그대로 유지된다(다른 페이지로 이동하지 않는다).
- [ ] 탭 막대에 새 탭(Shadow Tab)이 백그라운드로 생겼다.
- [ ] 그 탭이 `/settings` 로 이동한다.
- [ ] 진행 상태가 handshake → root 탐색 → 추출 순으로 바뀌고 Section 이 `success` 가 된다(실패하면 팝업의 Section 상태 목록에서 오류 유형과 메시지를 본다).
- [ ] 미리보기에 root 안의 컨트롤만 추출되었다(너무 많은 잡음이 보이면 5절대로 root 를 좁힌다).
- [ ] 결과가 저장되었다(팝업을 닫았다 다시 열어도 결과가 남아 있다).
- [ ] TXT / JSON 복사가 된다.
- [ ] 작업이 끝나면 Shadow Tab 이 닫힌다.

비활성(`enabled: false`) Section 은 이동하지 않고 `skipped` 로 기록됩니다.

## 4. config.js 에서 수정하는 항목

| 위치                                        | 의미                                                                                                                                           |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `sections[]` 배열 **순서**                  | 곧 실행 순서입니다. 순서를 바꾸면 실행 순서도 바뀝니다(새로 시작할 때 적용).                                                                   |
| `sections[].path`                           | `https://github.com/<owner>/<repo>` 뒤에 붙는 경로. 계정 권한/GitHub 변경에 따라 달라질 수 있어 예시로만 제공됩니다.                           |
| `selectors.root`                            | 추출 범위가 되는 컨테이너. **실제 DOM 에서 확인한 값으로 바꾸세요**(5절).                                                                      |
| `selectors.ignore`                          | root 안에서 추출에서 제외할 하위 요소 selector 목록.                                                                                           |
| `actions`                                   | 기본은 빈 배열(아무것도 클릭하지 않음). 6절 참고.                                                                                              |
| `options.enabled` / `options.timeoutMs`     | Section 사용 여부 / 페이지 안 추출 단계(root 탐색+안정화+추출)의 시간 예산.                                                                    |
| `navigation.mode`                           | `normal-with-hard-reload-fallback`(기본) 또는 `always-reload`(Section 마다 로딩 후 hard reload 1회).                                           |
| `navigation.*TimeoutMs`, `reloadRetryCount` | 이동/handshake timeout, Section 당 복구 재시도 횟수.                                                                                           |
| `extraction.rootTimeoutMs`, `domStable*`    | root 대기 시간, DOM 안정(변경 없음) 판단 시간과 최대 대기.                                                                                     |
| `extraction.onDomStabilityTimeout`          | `"proceed"`(경고를 남기고 현재 DOM 추출) / `"fail"`(timeout 처리).                                                                             |
| `extraction.includeHiddenElements`          | `true` 면 보이지 않는 요소(닫힌 `<details>` 내부 포함)도 탐색.                                                                                 |
| `extraction.ignoreTags`                     | 탐색에서 제외할 태그(기본 `nav`, `footer`).                                                                                                    |
| `extraction.ignoreTextPatterns`             | 텍스트 노드 **전체**가 이 정규식(대소문자 무시)에 일치하면 버립니다. 기본은 스피너 문구 `Loading`. 한국어 UI 면 `"^로딩 중$"` 처럼 추가하세요. |
| `extraction.max*`                           | 항목/텍스트/문자열/Section 크기 제한. 제한에 걸리면 결과에 `truncated` 로 표시됩니다.                                                          |
| `resume.*`                                  | 이어받기 정책(성공 Section 건너뛰기, 실패 재시도).                                                                                             |
| `metadata.enabled`                          | Repository 메인 페이지의 "화면에 보이는" 정보 수집(새로 시작할 때만 적용).                                                                     |
| `security.*`                                | 민감값 처리 옵션. `neverExtractSecretValues` 는 코드에서 항상 `true` 로 강제됩니다.                                                            |

세션을 시작/이어받는 시점의 설정이 세션에 스냅샷으로 저장됩니다. **이어받기 때는** 같은 `id` 의 Section 정의(`path`, `selectors`, `actions`, `timeoutMs`, `enabled`)와 전역 설정이 현재 `config.js` 값으로 갱신되고, 새로 추가된 Section 은 뒤에 붙습니다(실행 순서는 세션 순서 유지). 그래서 "selector 를 고친 뒤 실패한 Section 만 다시" 흐름이 가능합니다. 이전 실패 기록은 Section 의 `history` 에 보존됩니다.

## 5. root selector 정하기 (실제 DOM 확인 절차)

`root: "main"` 은 동작 확인용 fallback 입니다. 범위가 넓어서 사이드바/배너 같은 UI 노이즈가 섞입니다(`nav`/`footer` 는 기본으로 제외하지만 그 밖의 잡음은 남습니다).

1. 대상 Settings 페이지를 열고, 설정 폼이 들어 있는 영역에서 오른쪽 클릭 → **검사**.
2. Elements 탭에서 **설정 내용 전체를 감싸지만 왼쪽 설정 메뉴/상단 헤더는 포함하지 않는** 가장 안쪽 요소를 찾습니다.
3. selector 는 **안정적인 속성을 우선**합니다: `id`, `data-*`, `aria-label`, `role`, 의미 있는 태그. 해시처럼 보이는 클래스명, `:nth-child()` 위주의 selector 는 GitHub 배포 때마다 깨질 수 있어 피하세요.
4. 콘솔에서 확인합니다. 결과가 정확히 1개여야 하고, 보이는 설정이 모두 그 안에 있어야 합니다.
   ```js
   document.querySelectorAll("여기에-selector").length;
   ```
   후보를 찾는 데 도움이 되는 스니펫:
   ```js
   [
     ...document.querySelectorAll(
       "main [id], main form, main section, main [data-testid], main [aria-label]",
     ),
   ]
     .map((e) => ({
       sel:
         e.tagName.toLowerCase() +
         (e.id ? "#" + e.id : "") +
         (e.getAttribute("data-testid")
           ? '[data-testid="' + e.getAttribute("data-testid") + '"]'
           : ""),
       controls: e.querySelectorAll(
         'input,select,textarea,[role="switch"],[role="checkbox"]',
       ).length,
       textLen: e.textContent.length,
     }))
     .filter((x) => x.controls > 0)
     .slice(0, 30);
   ```
5. 찾은 selector 를 `config.js` 의 해당 Section `selectors.root` 에 넣고, 남는 잡음은 `selectors.ignore` 에 넣습니다.
6. 확장프로그램을 새로고침하고 그 Section 만 `enabled: true` 로 테스트합니다. 실패 시 팝업에 `root_not_found`(selector 불일치) 또는 `invalid_root_selector`(문법 오류)가 표시됩니다.

root 를 못 찾으면 `rootTimeoutMs` 후 **그 Section 만** 실패로 기록되고 다음 Section 으로 넘어갑니다.

## 6. 숨겨진 세부 설정 펼치기 (`actions`)

기본값은 `actions: []` 이고 **아무것도 클릭하지 않습니다.** 일부 설정이 접혀 있어 보이지 않을 때만, 아래처럼 명시적으로 지정하세요.

```js
actions: [
  {
    type: "expand",
    selector: "details.my-advanced, button[aria-controls='my-panel']",
    waitAfterMs: 700,
  },
];
```

- 지원하는 type 은 `expand` 뿐입니다. 일반 `click` action 은 **의도적으로 제공하지 않습니다.**
- 하는 일: 닫힌 `<details>` 를 열고, `aria-expanded="false"` 인 펼침 컨트롤(button / summary / role=button)만 누릅니다.
- 거부하는 것(건너뛰고 `meta.actions[].skipped` 에 이유를 기록): 폼 제출 가능 버튼, `aria-haspopup` 드롭다운 트리거, switch/checkbox/radio/tab 같은 상태 토글, 페이지 이동 링크, `data-confirm`/`data-method` 같은 서버 동작 속성, `danger` 스타일, 그리고 Delete / Remove / Save / Apply / Confirm / Transfer / Revoke / Disable / Enable 등(한국어 포함)이 라벨·이름에 들어간 컨트롤.
- 이 안전 검사는 **휴리스틱**입니다. selector 를 최대한 좁게 지정하세요. 추출이 끝나도 펼친 UI 를 되돌리지 않습니다(되돌리다 설정이 바뀔 위험이 더 크기 때문. Shadow Tab 은 곧 닫힙니다).

## 7. 출력

### TXT

사람이 읽기 쉬운 형식입니다. 체크박스는 `checked/unchecked`, switch 는 `on/off`, 라디오는 그룹으로 묶어 `- Visibility: Private  (options: Public | Private*)` 처럼, `disabled/required/read-only` 는 `[...]` 로, 가까운 설명은 `note:` 로 표시합니다. 실패한 Section 도 `Status` 와 `Error:` 줄로 남습니다.

```
GitHub Repository Settings Export
Schema: 1
Repository: owner/name
...
[1] General
URL: https://github.com/owner/name/settings
Status: success
Section:
  ## Features
- Issues: checked
    note: Track bugs and tasks.
- Wikis: unchecked
```

### JSON

정규화된 전체 결과입니다(`schemaVersion`, `repository`, `session`, `summary`, `sections[]`). `summary` 는 실제 Section 상태에서 계산합니다. 각 항목 예:

```json
{
  "key": "repository[has_issues]",
  "keyBasis": "name",
  "type": "checkbox",
  "label": "Issues",
  "labelSource": "parent-label",
  "value": true,
  "state": { "checked": true, "disabled": false, "required": false },
  "description": "Track bugs and tasks.",
  "context": "Features",
  "source": {
    "tagName": "INPUT",
    "inputType": "checkbox",
    "name": "repository[has_issues]"
  }
}
```

- `key` 는 `name` → `data-testid` → `data-test-selector` → (불안정해 보이지 않는) `id` → 라벨 → 위치 순으로 만든 식별자이고 `keyBasis` 가 그 근거입니다. 사용자가 읽을 `label` 과 별개입니다.
- 값이 없거나 확인할 수 없으면 추측하지 않고 `null` / 누락으로 둡니다.

## 8. 보안·개인정보

- password 입력의 값은 **읽지 않습니다.** hidden input 은 기본 제외이며(`skipHiddenInputs:false` 여도 값은 항상 `[REDACTED]`), `name/id/label/placeholder/aria-label/data-*` 에 `token, password, cookie, session, authorization, api-key, private-key, client-secret, access-key` 등(한국어 포함)이 있는 텍스트 입력의 값은 저장하지 않고 `redacted: true` + 사유만 기록합니다.
- 값 자체가 토큰/키 모양(`ghp_…`, `github_pat_…`, `AKIA…`, `xox…`, JWT, `-----BEGIN … PRIVATE KEY-----` 등)이면 어느 필드에 있든 `[REDACTED]` 로 바뀝니다. 이 검사는 content script(추출 시), service worker(저장 시), formatter(출력 시) **세 번** 적용됩니다.
- Secrets 페이지에서는 화면에 표시된 이름/갱신 시각 등만 수집될 수 있고, Secret 의 실제 값은 읽지도 가져오지도 않습니다.
- 쿠키, `localStorage`, `sessionStorage`, 인증 헤더를 읽지 않으며, **외부 서버로 아무것도 전송하지 않습니다**(코드에 `fetch`/`XMLHttpRequest`/`WebSocket` 사용 없음). 결과는 `chrome.storage.local` 에만 저장됩니다.
- 로그인/2FA/sudo/SSO, CAPTCHA, HTTP 429 화면이 감지되면 **그 화면을 분석하지 않고** 일시 중지합니다. 우회하지 않습니다.
- 닫힌(closed) Shadow Root, iframe 내부는 탐색하지 않습니다.
- 민감값 필터는 휴리스틱입니다. 결과를 외부 서비스에 붙여넣기 전에 한 번 훑어보세요.

필요한 권한: `storage`(세션 저장), `alarms`(watchdog), `scripting`(handshake 실패 시 content script 재주입 복구 경로에서만 사용), `clipboardWrite`(복사 버튼), 호스트 `https://github.com/*`. 일부러 `tabs` 권한은 요청하지 않습니다(호스트 권한으로 github.com 탭의 URL/상태를 읽을 수 있음).

## 9. 동작 구조

```
Popup ──(메시지)──► Background service worker ──► Shadow Tab (active:false)
                         │  상태는 모두 chrome.storage.local          │
                         │  phase 전이는 compare-and-set(세션/요청/phase)  ▼
                         └──── GSE_PING / GSE_RUN ───────► content script
                         ◄──── GSE_PROGRESS / GSE_RESULT ──── (root 탐색, DOM 안정화, expand, 추출)
```

- Phase: `idle → preparing → navigating → waiting_for_document → handshaking → waiting_for_root → extracting → saving_result → advancing → (다음 Section) … → completed`. 각 전이는 저장된 뒤에 부수효과(탭 이동/메시지)를 수행하는 쪽만 실행하므로, 같은 이벤트가 중복으로 와도 한 Section 이 두 번 실행되지 않습니다. 결과 데이터와 `saving_result` 전이는 한 번의 `storage.set` 으로 원자적으로 저장됩니다.
- service worker 가 종료돼도 전역 변수에 의존하지 않으므로, 탭 이벤트/content 결과 메시지/알람(watchdog, 30초 주기, 경과 시간 기준)이 깨워서 저장된 phase 에서 이어갑니다. 긴 대기(root 탐색, 안정화)는 content script 가 수행하고 결과를 별도 메시지로 보냅니다.
- 복구: URL 이 틀리거나 로딩이 지연되면 목표 URL 로 재이동, handshake 실패 시 ① `chrome.scripting.executeScript` 로 content script 재주입(재주입 guard 로 listener 중복 없음) → ② `chrome.tabs.reload({bypassCache:true})` → ③ 실패 기록. `reloadRetryCount`(기본 1)만큼만 시도하고 소진되면 그 Section 을 기록하고 다음으로 넘어갑니다.
- 일시 중지(`interrupted`): 로그인/인증/CAPTCHA/429/외부 리다이렉트. Shadow Tab 은 유지됩니다. 인증을 마치고 **이어받기**.
- 브라우저/확장프로그램 재시작(`onStartup`, `onInstalled`)이면 실행 중이던 세션은 `interrupted` 로 보존됩니다(탭 ID 가 무효이므로). 이어받기 때 새 Shadow Tab 을 만듭니다.
- 저장 키: `gse:session`(세션 + Section 메타), `gse:data:s<id>` / `gse:data:meta`(Section 별 결과), `gse:log`(최소 로그). 확인: `chrome://extensions` → 이 확장프로그램의 "서비스 워커" 검사 → Application → Storage → Extension storage → Local.

### Section 오류 유형

`navigation_timeout`, `handshake_timeout`, `root_not_found`, `invalid_root_selector`, `dom_stability_timeout`, `section_timeout`, `extraction_error`, `navigation_error`, `storage_error`, `page_not_found`(HTTP 404 — GitHub 는 권한이 없는 설정 페이지에도 404 를 응답), `permission_denied`(403), `http_error`(5xx), `unexpected_redirect`, `authentication_required`, `captcha_required`, `rate_limited`, `external_redirect`, `session_interrupted`, `stopped_by_user`, `unknown_error`.

## 10. 테스트 현황

### 실제 Chrome + 실제 GitHub 실행 결과 (사용자 제공)

공개 Repository(본인 소유)에서 기본 `config.js`(root `main`)로 실행해 8개 Section 모두 `success`(약 16초)로 끝났고, 팝업/TXT/JSON 출력이 생성되었습니다. 이 결과로 확인된 것: Shadow Tab 이동·handshake·root 탐색·DOM 안정화·추출·저장·내보내기가 실제 Chrome 에서 동작함, `main#js-repo-pjax-container` 가 root 로 잡힘, 라디오 그룹/체크박스/버튼형 드롭다운/`aria-pressed` 토글이 추출됨. 이 결과에서 발견된 문제(엉뚱한 heading 아래로 묶임, `Loading` 잡음, UUID 가 든 id 로 key 생성, 토글 버튼 글자 누락)는 수정되었습니다.

### 오프라인 자동 테스트 (통과) — 가짜 Chrome API + jsdom

`tests/` 폴더에 있습니다. 실제 소스 파일을 그대로 실행하며 `chrome.*` 와 페이지만 가짜입니다. 실행: `cd tests && npm install && node tests.js` (Node 18+, 일부만: `node tests.js T6`).

| 항목                                                                                                              | 상태             |
| ----------------------------------------------------------------------------------------------------------------- | ---------------- |
| 정상 흐름, 배열 순서대로 이동, 사용자 탭 유지, Shadow Tab 생성/정리                                               | 자동 테스트 통과 |
| root 내부만 추출 / ignore selector / ignoreTags / root 자신 일치                                                  | 자동 테스트 통과 |
| 라벨 우선순위, 설명 연결, key 유일성, 라디오 그룹, select, ARIA(switch/listbox/tab)                               | 자동 테스트 통과 |
| 열린 Shadow DOM 추출 / 닫힌 Shadow DOM 우회 안 함                                                                 | 자동 테스트 통과 |
| 닫힌 `<details>` 제외, `expand` 로 펼치기, 위험/제출/팝업 컨트롤 클릭 안 함                                       | 자동 테스트 통과 |
| password / hidden / 식별자 패턴 / 토큰 모양 값 제거(저장소·TXT·JSON 모두)                                         | 자동 테스트 통과 |
| 잘못된 root selector, 404 경로, 비활성 Section 건너뛰기, 오류 격리                                                | 자동 테스트 통과 |
| handshake 실패 → 재주입 → reload → 소진 후 timeout 기록, 로딩 지연 timeout                                        | 자동 테스트 통과 |
| `always-reload` 모드, DOM 안정화 `proceed`/`fail`                                                                 | 자동 테스트 통과 |
| 중지/이어받기, 늦은·위조·중복 응답 폐기, 중복 시작 거부, 새로 시작 시 이전 data 삭제                              | 자동 테스트 통과 |
| service worker 종료 후 재개(content 결과 메시지/탭 이벤트/watchdog 알람), 브라우저 재시작 후 이어받기(시뮬레이션) | 자동 테스트 통과 |
| Shadow Tab 을 사용자가 닫음, 로그인 리다이렉트/CAPTCHA/429 일시 중지와 이어받기                                   | 자동 테스트 통과 |
| 이어받기 정책, config 수정 반영, 크기 제한(truncated 표시), metadata, popup 닫았다 열기·복사                      | 자동 테스트 통과 |

### 실제 Chrome + 실제 GitHub 에서는 **아직 검증하지 않았습니다**

아래는 직접 확인이 필요합니다(예상 결과 포함).

| 확인할 것                                                       | 방법                                                 | 예상 결과                                                                    |
| --------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| 각 Section path 가 실제로 열리는가                              | 한 Section 씩 `enabled:true`                         | 해당 설정 페이지로 이동, 권한이 없으면 `page_not_found`(404)                 |
| 실제 root selector / 추출 품질                                  | 5절 절차                                             | 설정 컨트롤이 `items` 에 올바른 label/value 로 나옴                          |
| GitHub 의 custom dropdown(버튼 형태)이 현재 선택값으로 나오는가 | General/Branches 확인                                | `dropdown-trigger` 항목의 `value` 가 화면의 선택 텍스트                      |
| 백그라운드(비활성) 탭에서 DOM 추출                              | 실제 실행                                            | 성공. 타이머가 초 단위로 throttling 될 수 있어 다소 느릴 수 있음             |
| 추출 도중 Shadow Tab 닫기 / 실제 브라우저 종료 후 이어받기      | 직접 닫기 / Chrome 종료 후 재실행                    | `interrupted` 로 저장, 이어받기 시 새 탭으로 계속                            |
| 실제 로그인 화면/SSO/2FA/sudo/CAPTCHA 리다이렉트                | 로그아웃 상태 또는 SSO 조직 Repository               | 분석 없이 일시 중지, Shadow Tab 에서 인증 후 이어받기                        |
| 닫힌 Shadow DOM 이 있는 실제 페이지                             | 해당 페이지 추출                                     | 그 부분은 누락(우회하지 않음). `Notes` 에 표시되지 않으므로 화면과 대조 필요 |
| 장시간 실행에서의 service worker 재시작                         | 실행 중 `chrome://serviceworker-internals` 에서 중지 | 다음 이벤트에서 깨어나 이어서 진행                                           |

## 11. 문제 해결

| 증상                                        | 원인 / 조치                                                                                                                                         |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| "GitHub Repository 페이지에서 열라" 고 나옴 | 활성 탭이 `https://github.com/<owner>/<repo>...` 가 아님. 팝업은 활성 탭 URL 로 대상을 정합니다.                                                    |
| 항상 `root_not_found`                       | selector 불일치. 5절로 다시 확인. 또는 `rootTimeoutMs` 증가.                                                                                        |
| 결과에 잡음이 많음                          | root 를 좁히고 `selectors.ignore` 추가, `extraction.ignoreTags` 조정.                                                                               |
| 보이는 설정이 일부 빠짐                     | 접힌 영역이면 6절 `expand`, 또는 `includeHiddenElements:true`(숨김 요소까지 포함되어 잡음 증가). 닫힌 Shadow DOM/iframe 안이면 추출 불가.           |
| `handshake_timeout`                         | 확장프로그램을 새로고침한 직후 열린 탭이거나 GitHub 가 느림. 자동으로 재주입 → reload 를 시도합니다. 반복되면 `navigation.handshakeTimeoutMs` 증가. |
| `page_not_found`(404)                       | path 가 틀렸거나 이 계정에 해당 설정 권한이 없음(GitHub 는 404 로 응답).                                                                            |
| 일시 중지 후 이어받기가 바로 다시 중지됨    | 아직 인증이 끝나지 않음. "Shadow Tab 열기"로 인증 완료 후 이어받기.                                                                                 |
| Chrome 메모리 절약(Memory Saver)            | 오래 걸리는 작업 중 비활성 탭이 폐기될 수 있음. 이 경우 timeout → 자동 재시도됩니다.                                                                |

## 12. 알려진 한계

- `aria-pressed` 토글 버튼은 `pressed` / `not pressed` 로만 기록합니다(켜짐/꺼짐으로 해석하지 않음). 버튼에 보이는 글자(예: Enable)가 있으면 `button text` 로 함께 기록합니다. 어느 쪽이 "켜짐"인지는 화면과 대조해 확인하세요.
- `context`(항목이 속한 섹션)는 "페이지에서 2번 이상 나타나는 가장 얕은 heading 수준(2 이상)"으로 정하는 휴리스틱입니다. 소제목은 `nearestHeading` 으로 따로 남깁니다.

- 실제 GitHub DOM 으로 검증된 selector/경로가 없습니다. GitHub UI 가 바뀌면 추출 품질이 달라질 수 있습니다.
- custom dropdown 은 "닫힌 상태에서 화면에 보이는 선택 텍스트"와 보이는 `aria-selected/aria-checked` 상태만 수집하며, 모든 경우에 정확하다고 보장하지 않습니다. `aria-selected` 항목은 저장된 설정값이 아니라 탭 선택 같은 UI 상태일 수 있어 `selected-option` 으로 구분해 표시합니다.
- 라벨/설명 연결은 DOM 구조 기반 휴리스틱입니다. 구조가 특이하면 설명이 다른 항목에 붙거나 누락될 수 있습니다.
- 결과 크기/개수 제한이 있어 아주 큰 페이지는 잘립니다(`truncated`, `size_limit_applied` 로 표시).
- 열린 Shadow Root 만 탐색합니다. 닫힌 Shadow Root, iframe 내부는 탐색하지 않습니다.
- 한 번에 하나의 Repository 세션만 저장합니다(여러 Repository 이력은 지원하지 않음. `storage.js` 로 분리되어 있어 확장 가능).
- 비활성 탭에서는 타이머 throttling 으로 대기 시간이 길어질 수 있습니다.
- 알람은 정확한 시각을 보장하지 않으므로 watchdog 복구가 수십 초 늦을 수 있습니다.
- Chrome 120 미만의 패키징된 확장프로그램에서는 30초 알람 주기가 1분으로 늘어날 수 있습니다(개발자 모드 로드에서는 영향 없음).
- `chrome.storage.local` 한도(Chrome 114 이상 10MB)를 넘는 극단적인 경우 해당 Section 은 `storage_error` 로 기록됩니다(성공으로 오인하지 않음). 일반적인 결과는 Section 당 수십 KB 수준입니다.
- 브라우저를 재시작하면 Chrome 의 세션 복원이 이전 Shadow Tab 을 다시 열 수 있습니다. 확장프로그램은 그 탭을 자동으로 닫지 않으므로 직접 닫아 주세요(이어받기는 새 탭을 만듭니다).

## 13. 파일 구성

```
github-settings-exporter/
├── manifest.json   Manifest V3 (권한 최소화, classic service worker)
├── config.js       Section 목록 / selector / timeout / 옵션 (사용자가 수정)
├── background.js   세션 상태 머신, Shadow Tab, 이동/handshake/복구, watchdog, popup 메시지 API
├── content.js      handshake 응답, root 탐색, DOM 안정화, expand action, 추출 요청 처리, 결과 전송
├── extractor.js    공통 DOM 탐색(열린 Shadow DOM), control 정규화, 라벨/설명, text block, expand 안전 검사
├── storage.js      세션 생성/저장/복원/갱신, 직렬화 lock, 원자적 저장, 집계
├── popup.html / popup.js / styles.css   제어 UI
├── security.js     (추가) 민감값 판별/제거 공용 모듈 — content script 와 service worker 가 같은 규칙을 씀
├── formatter.js    (추가) 최종 JSON 스키마 조립, TXT 포맷터, 출력 직전 재검사
├── metadata.js     (추가) 선택 기능: Repository 메인 페이지 메타데이터(화면에 보이는 값만)
├── README.md
└── tests/          오프라인 테스트(harness.js 가짜 chrome.* + jsdom, fixtures.js, tests.js). Chrome 에는 로드되지 않음
```

`config.js` 를 content script 목록에서 뺀 이유: 설정은 service worker 가 읽어 세션에 스냅샷으로 저장하고, content script 에는 필요한 값만 메시지로 전달합니다(설정의 단일 출처 유지).

## 기여하기

버그 제보와 개선 제안을 환영합니다. 이슈에는 재현 절차와 기대한 동작을 적어 주세요. 변경 사항을 제출하기 전에는 오프라인 테스트를 실행하고, 실제 Chrome이나 GitHub에서 확인하지 못한 동작은 그 검증 범위를 함께 밝혀 주세요.

```bash
cd tests
npm install
npm test
```

## 라이선스

이 프로젝트는 [MIT License](LICENSE)로 배포됩니다.
