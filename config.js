/*
 * GitHub Settings Exporter - config.js
 *
 * 사용자가 직접 수정하는 설정은 이 파일 한 곳에만 둔다.
 * - service worker(background.js)가 importScripts()로 읽는다. 값을 바꾼 뒤에는
 *   chrome://extensions 에서 확장프로그램을 "새로고침"해야 반영된다.
 * - 세션을 시작(또는 이어받기)하는 시점의 설정이 세션에 스냅샷으로 저장된다.
 *   content script / popup은 이 파일을 직접 읽지 않고 background 메시지로 전달받는다.
 * - var 로 선언한 이유: 같은 컨텍스트에서 파일이 다시 평가되어도 "already declared" 오류가 나지 않게 하기 위함.
 *
 * 주의: 아래 path / selector 는 "수정 가능한 기본 예시"이며 실제 로그인된 GitHub 계정에서 검증된 값이 아니다.
 * 계정 권한, Repository 종류(개인/조직), GitHub UI 변경에 따라 다른 화면이 나올 수 있다.
 * root: "main" 은 초기 테스트용 넓은 fallback 이므로 결과에 UI 노이즈가 섞인다.
 * README.md 의 "root selector 정하기" 절차대로 더 좁은 selector 로 바꾸는 것을 권장한다.
 */
var GSE_CONFIG = {
  version: 1,

  navigation: {
    // "normal-with-hard-reload-fallback": 평소엔 한 번만 이동하고, 문제가 생길 때만 제한된 횟수로 hard reload
    // "always-reload": 각 Section 로딩 후 1회 hard reload 를 추가로 수행
    mode: "normal-with-hard-reload-fallback",
    navigationTimeoutMs: 30000,   // 탭 이동 후 로딩 완료까지 최대 대기
    handshakeTimeoutMs: 10000,    // content script 응답(handshake) 최대 대기
    reloadRetryCount: 1           // 복구용 reload/재이동 횟수(Section 1개당)
  },

  extraction: {
    sectionTimeoutMs: 30000,      // 페이지 안에서의 추출 단계(root 탐색 + 안정화 + 추출) 전체 예산. Section별 options.timeoutMs 가 우선
    rootTimeoutMs: 15000,         // root selector 가 나타날 때까지 최대 대기
    domStableTimeMs: 1000,        // root 하위에서 이 시간 동안 변경이 없으면 "안정"
    domStableTimeoutMs: 15000,    // 안정화를 기다리는 최대 시간
    onDomStabilityTimeout: "proceed", // "proceed": 경고를 남기고 현재 DOM 으로 추출 / "fail": timeout 으로 기록
    includeHiddenElements: false, // true 면 display:none 등 보이지 않는 요소도 탐색(닫힌 <details> 내부 포함)
    maxItemsPerSection: 3000,     // Section 당 최대 control 수 (초과 시 잘리고 meta.truncated 에 표시)
    maxTextBlocks: 800,           // Section 당 최대 text block 수
    maxStringLength: 4000,        // 값 하나의 최대 길이
    maxSectionBytes: 1500000,     // Section 결과(JSON) 최대 크기. 초과 시 text block -> item 순서로 잘림
    ignoreTags: ["nav", "footer"],// 탐색에서 제외할 태그(내비게이션 소음 감소). 비워도 된다.
    // 텍스트 노드 "전체"가 이 정규식(대소문자 무시)에 일치하면 버린다. 스피너의 "Loading" 같은 잡음용.
    // GitHub 화면 언어가 한국어면 "로딩", "불러오는 중" 등을 추가하세요.
    ignoreTextPatterns: ["^Loading(\\.\\.\\.|…)?$"],
    maxExpandPerAction: 25        // expand action 1개가 한 번에 펼칠 수 있는 최대 요소 수
  },

  resume: {
    skipSuccessfulSections: true, // 이어받기 때 성공한 Section 은 다시 추출하지 않음
    retryFailedSections: true     // 이어받기 때 failed / timeout Section 을 다시 시도
  },

  metadata: {
    enabled: false,               // Repository 메인 페이지의 "화면에 보이는" 정보만 수집(새로 시작할 때만 적용)
    mode: "visible-dom-only"
  },

  security: {
    redactSensitiveValues: true,       // name/id/label 등에 token, password 같은 패턴이 있는 텍스트 값은 저장하지 않음
    skipHiddenInputs: true,            // input[type=hidden] 제외(false 여도 hidden 값은 항상 REDACTED)
    neverExtractSecretValues: true     // 코드에서 항상 true 로 강제된다(끌 수 없음)
  },

  /*
   * sections 배열의 "순서"가 곧 실행 순서다.
   * 필드: id(고유), name, path(/settings...), selectors.root / selectors.ignore, actions, options.enabled / options.timeoutMs
   *
   * actions 예시(기본은 빈 배열 = 아무것도 클릭하지 않음):
   *   { type: "expand", selector: "details.js-my-advanced", waitAfterMs: 700 }
   *   - 지원하는 type 은 "expand" 뿐이다. <details> 를 열거나, aria-expanded="false" 인 펼침 컨트롤만 누른다.
   *   - Delete / Save / Enable 처럼 설정을 바꿀 수 있는 컨트롤은 거부된다(README 참고).
   *
   * 검증되지 않은 추가 후보 path (필요하면 아래 sections 에 직접 추가):
   *   Pages: /settings/pages, Rulesets: /settings/rules, Deploy keys: /settings/keys
   */
  sections: [
    {
      id: 1,
      name: "General",
      path: "/settings",
      selectors: { root: "main", ignore: [] },
      actions: [],
      options: { enabled: true, timeoutMs: 30000 }
    },
    {
      id: 2,
      name: "Collaborators",
      path: "/settings/access",
      selectors: { root: "main", ignore: [] },
      actions: [],
      options: { enabled: true, timeoutMs: 30000 }
    },
    {
      id: 3,
      name: "Branches",
      path: "/settings/branches",
      selectors: { root: "main", ignore: [] },
      actions: [],
      options: { enabled: true, timeoutMs: 30000 }
    },
    {
      id: 4,
      name: "Actions",
      path: "/settings/actions",
      selectors: { root: "main", ignore: [] },
      actions: [],
      options: { enabled: true, timeoutMs: 30000 }
    },
    {
      id: 5,
      name: "Webhooks",
      path: "/settings/hooks",
      selectors: { root: "main", ignore: [] },
      actions: [],
      options: { enabled: true, timeoutMs: 30000 }
    },
    {
      id: 6,
      name: "Secrets and variables",
      path: "/settings/secrets/actions",
      selectors: { root: "main", ignore: [] },
      actions: [],
      options: { enabled: true, timeoutMs: 30000 }
    },
    {
      id: 7,
      name: "Environments",
      path: "/settings/environments",
      selectors: { root: "main", ignore: [] },
      actions: [],
      options: { enabled: true, timeoutMs: 30000 }
    },
    {
      id: 8,
      name: "Security",
      path: "/settings/security_analysis",
      selectors: { root: "main", ignore: [] },
      actions: [],
      options: { enabled: true, timeoutMs: 30000 }
    }
  ]
};
