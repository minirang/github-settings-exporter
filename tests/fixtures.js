'use strict';
/*
 * 주의: 이 HTML 은 "GitHub 의 실제 DOM" 이 아니라 extractor 동작을 점검하기 위한 가짜 페이지다.
 */
const state = { loggedIn: true, blockInjectFirstLoadOf: null, neverInject: false, slowMs: 600, dangerClicks: 0, moreClicks: 0 };

const page = (body, extra) => `<!doctype html><html><head><title>${(extra && extra.title) || 'Test'}</title></head><body>${body}</body></html>`;

const GENERAL = page(`
<header><nav><a href="/">Home</a><a href="/pulls">Pull requests</a></nav></header>
<main id="main">
  <nav class="inner-nav"><a href="/o/r/settings/access">Inner nav link</a></nav>
  <div class="Subhead"><h2>General</h2></div>
  <form action="/o/r/settings" method="post">
    <input type="hidden" name="authenticity_token" value="CSRF_SECRET_VALUE_abcdef123456">
    <div class="form-group"><label for="repo-name">Repository name</label><input id="repo-name" name="repository[name]" value="my-repo"></div>
    <div class="form-group"><label for="repo-desc">Description</label><textarea id="repo-desc" name="repository[description]">An example repository</textarea><p class="note">Short description shown on the repository page.</p></div>
    <div class="form-group"><label for="pw">Deploy password</label><input id="pw" type="password" name="deploy_password" value="hunter2-super-secret"></div>
    <div class="form-group"><label for="tok">Deploy key</label><input id="tok" type="text" name="deploy_key_value" value="ghp_abcdefghijklmnopqrstuvwxyz0123456789"></div>
    <div class="form-group"><label for="tok2">API token</label><input id="tok2" type="text" name="api_token" value="not-a-pattern-just-plain"></div>
    <div class="form-group"><label for="plain">Homepage</label><input id="plain" type="url" name="repository[homepage]" value="https://example.com"></div>
    <h3>Features</h3>
    <div class="form-checkbox"><label><input type="checkbox" name="repository[has_issues]" checked> Issues</label><p class="note">Track bugs and tasks.</p></div>
    <div class="form-checkbox"><label><input type="checkbox" name="repository[has_wiki]"> Wikis</label><p class="note">Host documentation.</p></div>
    <div class="form-checkbox"><label><input type="checkbox" name="locked_opt" checked disabled> Locked option</label></div>
    <fieldset><legend>Visibility</legend>
      <div><label><input type="radio" name="visibility" value="public"> Public</label><p>Anyone on the internet can see this repository.</p></div>
      <div><label><input type="radio" name="visibility" value="private" checked> Private</label><p>Only people you choose can see it.</p></div>
    </fieldset>
    <div class="form-group"><label for="branch">Default branch</label><select id="branch" name="repository[default_branch]"><option value="main" selected>main</option><option value="develop">develop</option></select></div>
    <div role="group" aria-label="Merge options"><button type="button" role="switch" aria-checked="true" aria-label="Allow squash merging"><span>toggle</span></button></div>
    <button type="button" aria-haspopup="true" aria-expanded="false" aria-label="Pull request default branch"><span>Branch:</span> <strong>main</strong></button>
    <details><summary>Advanced</summary><div><label><input type="checkbox" name="adv_flag"> Hidden advanced flag</label></div></details>
    <button type="submit" class="btn-danger">Delete this repository</button>
  </form>
  <div id="shadow-host"></div>
  <div id="closed-host"></div>
  <p>Repository-wide notice outside any form control.</p>
  <aside class="promo">Promotional banner to ignore</aside>
</main>
<footer>Footer links</footer>`);

const ACCESS = page(`<main><div class="Subhead"><h2>Collaborators</h2></div>
<p>Manage who has access to this repository.</p>
<ul><li><a href="/alice">alice</a> <span>Admin</span></li><li><a href="/bob">bob</a> <span>Write</span></li></ul></main>`);

const BRANCHES = page(`<main><h2>Branch protection</h2>
<div role="listbox" aria-label="Rules"><div role="option" aria-selected="true">main rule</div><div role="option" aria-selected="false">other rule</div></div>
<div role="tablist" aria-label="View"><button type="button" role="tab" aria-selected="true">Active</button><button type="button" role="tab" aria-selected="false">Archived</button></div>
</main>`);

const ACTIONS = page(`<main><h2>Actions permissions</h2>
<details id="d1"><summary>Advanced options</summary><div><label><input type="checkbox" name="actions_hidden_flag" checked> Hidden by details</label></div></details>
<button type="button" id="more-btn" aria-expanded="false" aria-controls="more"><span>Show more settings</span></button>
<div id="more" hidden><label><input type="checkbox" name="more_flag"> More flag</label></div>
<form action="/x" method="post"><button id="danger1" aria-expanded="false">Disable Actions</button></form>
<button type="button" id="danger2" aria-expanded="false" class="btn-danger">Delete workflow runs</button>
<button type="button" id="danger3" aria-expanded="false" aria-haspopup="menu">Menu trigger</button>
</main>`);

const SECRETS = page(`<main><h2>Repository secrets</h2>
<ul><li><span>DEPLOY_TOKEN</span> <span>Updated 3 days ago</span></li><li><span>NPM_PUBLISH</span> <span>Updated last week</span></li></ul>
<form><label for="sname">Name</label><input id="sname" name="secret_name" value="NEW_SECRET_NAME"><label for="sval">Secret</label><textarea id="sval" name="secret_value">ghs_0123456789abcdefghijklmnopqrstuvwxyz</textarea></form>
</main>`);

const ENVIRONMENTS = page(`<main><h2>Environments</h2><p>No environments configured.</p></main>`);
const SECURITY = page(`<main id="sec"><h2>Code security</h2><label><input type="checkbox" name="dependabot" checked> Dependabot alerts</label></main>`);
const LOGIN = page(`<main><form action="/session" method="post"><label for="login">Username</label><input id="login" name="login"><label for="password">Password</label><input id="password" type="password" name="password" autocomplete="current-password"></form></main>`, { title: 'Sign in' });
const REPO_HOME = page(`<main><strong itemprop="name">r</strong><span class="Label">Public</span><a href="/o/r/stargazers">12</a><a href="/o/r/forks">3</a><a href="/topics/js">js</a><a href="/topics/web">web</a></main>`);

function makeFixtures() {
  return function fixtures(url, tab, browser) {
    const u = new URL(url);
    const p = u.pathname.replace(/\/+$/, '');
    const loads = browser.stats.loads[url] || 1;
    let fx;
    switch (p) {
      case '/o/r':
        fx = { html: REPO_HOME }; break;
      case '/o/r/settings':
        fx = {
          html: GENERAL,
          setup(win) {
            const d = win.document;
            const sr = d.getElementById('shadow-host').attachShadow({ mode: 'open' });
            sr.innerHTML = '<div><h3>Shadow section</h3><label><input type="checkbox" name="shadow_flag" checked> Shadow flag</label></div>';
            const csr = d.getElementById('closed-host').attachShadow({ mode: 'closed' });
            csr.innerHTML = '<label><input type="checkbox" name="closed_flag" checked> Closed flag</label>';
          }
        };
        break;
      case '/o/r/settings/access': fx = { html: ACCESS }; break;
      case '/o/r/settings/branches': fx = { html: BRANCHES }; break;
      case '/o/r/settings/actions':
        fx = {
          html: ACTIONS,
          setup(win) {
            const d = win.document;
            ['danger1', 'danger2', 'danger3'].forEach((id) => d.getElementById(id).addEventListener('click', () => { state.dangerClicks++; }));
            d.getElementById('more-btn').addEventListener('click', (e) => {
              state.moreClicks++;
              e.currentTarget.setAttribute('aria-expanded', 'true');
              d.getElementById('more').removeAttribute('hidden');
            });
          }
        };
        break;
      case '/o/r/settings/hooks': fx = { status: 404, html: page('<main><h1>Page not found</h1></main>', { title: 'Page not found' }) }; break;
      case '/o/r/settings/secrets/actions': fx = { html: SECRETS }; break;
      case '/o/r/settings/environments':
        fx = state.loggedIn ? { html: ENVIRONMENTS } : { redirectTo: 'https://github.com/login?return_to=%2Fo%2Fr%2Fsettings%2Fenvironments' };
        break;
      case '/login': fx = { html: LOGIN }; break;
      case '/o/r/settings/security_analysis': fx = { html: SECURITY }; break;
      case '/o/r/settings/captcha':
        fx = { html: page('<main><h2>Verify</h2><iframe src="https://client-api.arkoselabs.com/fc/gt2/"></iframe></main>') }; break;
      case '/o/r/settings/hiddencaptcha':
        fx = { html: page('<main><h2>Normal</h2><div class="js-captcha-field" style="display:none"><input name="captcha_response"></div><label><input type="checkbox" name="ok" checked> OK</label></main>') }; break;
      case '/o/r/settings/ratelimit': fx = { status: 429, html: page('<main><h1>Too many requests</h1></main>') }; break;
      case '/o/r/settings/slow':
        fx = {
          html: page('<div id="shell"></div>'),
          setup(win) {
            win.setTimeout(() => {
              const m = win.document.createElement('main');
              m.innerHTML = '<h2>Slow</h2><label><input type="checkbox" name="slow_flag" checked> Slow flag</label>';
              win.document.body.appendChild(m);
            }, state.slowMs);
          }
        };
        break;
      case '/o/r/settings/noisy':
        fx = {
          html: page('<main><h2>Noisy</h2><div id="ticker"></div><label><input type="checkbox" name="noisy_flag" checked> Noisy flag</label></main>'),
          setup(win) {
            let n = 0;
            win.setInterval(() => { const t = win.document.getElementById('ticker'); if (t) t.textContent = 'tick ' + (n++); }, 30);
          }
        };
        break;
      default:
        fx = { status: 404, html: page('<main><h1>Not found</h1></main>') };
    }
    if (state.blockInjectFirstLoadOf && url === state.blockInjectFirstLoadOf.url && loads <= state.blockInjectFirstLoadOf.untilLoad) {
      fx = Object.assign({}, fx, { noAutoInject: true, injectBlocked: state.blockInjectFirstLoadOf.blockScripting !== false });
    }
    if (state.neverInject && /\/settings\/security_analysis$/.test(p)) fx = Object.assign({}, fx, { noAutoInject: true, injectBlocked: true });
    return fx;
  };
}

module.exports = { makeFixtures, state };
