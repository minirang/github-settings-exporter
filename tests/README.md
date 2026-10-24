# 오프라인 테스트

실제 확장프로그램 소스(저장소 루트의 `*.js`)를 그대로 실행하고, `chrome.*` API 와 GitHub 페이지만 가짜로 대체합니다.

- `harness.js`  가짜 Chrome(tabs/storage/alarms/scripting) + service worker 종료/재시작 시뮬레이션 + jsdom 페이지에 content script 주입
- `fixtures.js` GitHub 설정 페이지를 **흉내 낸** HTML (실제 GitHub DOM 이 아님)
- `tests.js`    시나리오 27개

    npm install
    npm test            # 전체(약 70초)
    node tests.js T6    # 이름에 T6 이 들어간 테스트만

한계: 실제 Chrome 의 탭/서비스 워커 동작, 실제 GitHub DOM, 로그인/SSO/CAPTCHA 화면은 검증하지 못합니다.
