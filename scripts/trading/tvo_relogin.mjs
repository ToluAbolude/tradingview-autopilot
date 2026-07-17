/**
 * tvo_relogin.mjs — self-healing login for the Tradeify/Tradovate web session.
 *
 * Tradovate keeps its auth token in sessionStorage (api_authenticator_state),
 * which dies with the tab — unlike TradingView's cookie login, nothing survives
 * a Chrome restart. This script restores the session without a human:
 *   1. Find (or create + navigate) the topstep.tradovate.com tab in VM Chrome.
 *   2. If a live token is already in sessionStorage → exit 0, touch nothing.
 *   3. Otherwise fill the login form from TVO_USERNAME / TVO_PASSWORD
 *      (provision via chmod-600 ~/.tvo_creds.env, sourced by the caller —
 *      same pattern as ~/.ctrader.env) and submit.
 *   4. Poll for the token; on failure screenshot to trading-data/ and exit 1.
 *
 * Called by scripts/cloud/tvo_session_check.sh before it falls back to the
 * alert email. Exit codes: 0 = session live, 2 = no credentials provisioned,
 * 1 = login attempted but failed (captcha / MFA / bad creds — see screenshot).
 *
 * CAVEAT: if Tradovate ever adds a captcha or device-verification step this
 * will fail cleanly to the email path — check tvo_relogin_fail.png first.
 */
import { writeFileSync } from 'fs';
import os from 'os';
import CDP from 'chrome-remote-interface';

const PORT = +(process.env.TV_CDP_PORT || 9222);
const URL_HOME = 'https://topstep.tradovate.com/';
const DATA_ROOT = os.platform() === 'linux'
  ? '/home/ubuntu/trading-data'
  : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = m => console.log(`[tvo_relogin] ${m}`);

// Main app tab only — the app also spawns page-type targets for its jailed
// iframe (/scripts/lib/jailed/_frame) and Stripe frames; those have no
// sessionStorage token and no login form.
function isMainTab(t) {
  return t.type === 'page'
    && t.url.startsWith('https://topstep.tradovate.com')
    && !t.url.includes('/scripts/');
}

async function findOrCreateTab() {
  let targets = await CDP.List({ port: PORT });
  let tab = targets.find(isMainTab);
  if (tab) return { tab, created: false };
  log('no Tradovate tab — creating one');
  // PUT /json/new?url=… lands on about:blank on this Chrome build, so create
  // blank and navigate explicitly over the protocol.
  const fresh = await CDP.New({ port: PORT });
  const c = await CDP({ target: fresh, port: PORT });
  try {
    await c.Page.enable();
    await c.Page.navigate({ url: URL_HOME });
    await sleep(15000);
  } finally {
    await c.close().catch(() => {});
  }
  targets = await CDP.List({ port: PORT });
  tab = targets.find(isMainTab);
  if (!tab) throw new Error('created a tab but it never reached topstep.tradovate.com');
  return { tab, created: true };
}

async function evalIn(c, expression) {
  const { result, exceptionDetails } = await c.Runtime.evaluate({ expression, returnByValue: true });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || 'page eval failed');
  return result.value;
}

const TOKEN_EXPR = `(() => {
  try {
    const raw = sessionStorage.getItem('api_authenticator_state');
    if (!raw) return null;
    const st = JSON.parse(raw);
    if (!st.token) return null;
    return { expiration: st.expiration, userId: st.userId };
  } catch (_) { return null; }
})()`;

// After credentials Tradovate parks on /trading-mode ("Select a Trading Mode").
// The API token already exists there, but the trading app — and its automatic
// token renewal — only start once the environment is entered, so a session left
// on that screen silently expires ~80 min later. Click through to the
// Simulated Environment and wait for the app to leave /trading-mode.
async function enterSimEnvironment(c) {
  for (let i = 0; i < 10; i++) {
    const state = await evalIn(c, `(() => {
      if (!location.pathname.startsWith('/trading-mode')) return 'in-app';
      const btn = [...document.querySelectorAll('button')].find(b => /simulated environment/i.test(b.innerText));
      if (!btn) return 'no-button-yet';
      btn.click();
      return 'clicked';
    })()`);
    if (state === 'in-app') return true;
    if (state === 'clicked') {
      log('clicked "Login to the Simulated Environment"');
      for (let j = 0; j < 15; j++) {
        await sleep(2000);
        const left = await evalIn(c, `!location.pathname.startsWith('/trading-mode')`);
        if (left) return true;
      }
      log('WARNING: still on /trading-mode after click');
      return false;
    }
    await sleep(2000);
  }
  log('WARNING: trading-mode screen never showed its button');
  return false;
}

async function main() {
  const { tab } = await findOrCreateTab();
  const c = await CDP({ target: tab, port: PORT });
  try {
    await c.Page.enable();

    let tok = await evalIn(c, TOKEN_EXPR);
    if (tok && new Date(tok.expiration).getTime() > Date.now() + 60_000) {
      // Token live — but if the tab is parked on the trading-mode picker the
      // renewal loop isn't running; click through before declaring victory.
      const onPicker = await evalIn(c, `location.pathname.startsWith('/trading-mode')`);
      if (onPicker) await enterSimEnvironment(c);
      log(`session already live (userId ${tok.userId}, expires ${tok.expiration})`);
      return 0;
    }

    // Token dead. Make sure we're on the app origin (a stale/errored tab may
    // sit anywhere), then wait for the login form to render.
    log('no live token — attempting login');
    await c.Page.navigate({ url: URL_HOME });
    let hasForm = false;
    for (let i = 0; i < 15; i++) {
      await sleep(2000);
      hasForm = await evalIn(c, `!!document.querySelector('input[type=password]')`);
      if (hasForm) break;
      // The app can also auto-restore straight past the form (rare) — re-check.
      tok = await evalIn(c, TOKEN_EXPR);
      if (tok) { log('session restored by the app itself'); return 0; }
    }
    if (!hasForm) throw new Error('no login form and no token after 30s — unknown page state');

    const user = process.env.TVO_USERNAME;
    const pass = process.env.TVO_PASSWORD;
    if (!user || !pass) {
      log('login form is up but TVO_USERNAME/TVO_PASSWORD are not set — provision ~/.tvo_creds.env (chmod 600) to enable auto-relogin');
      return 2;
    }

    // React-controlled inputs ignore plain .value writes — go through the
    // native setter and fire an input event so the app state updates.
    const filled = await evalIn(c, `(() => {
      const setVal = (el, v) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const userEl = document.querySelector('input[type=text]');
      const passEl = document.querySelector('input[type=password]');
      if (!userEl || !passEl) return 'inputs not found';
      setVal(userEl, ${JSON.stringify(user)});
      setVal(passEl, ${JSON.stringify(pass)});
      const btn = [...document.querySelectorAll('button')].find(b => /log\\s*in/i.test(b.innerText));
      if (!btn) return 'Log In button not found';
      btn.click();
      return 'submitted';
    })()`);
    if (filled !== 'submitted') throw new Error(`form fill failed: ${filled}`);
    log('credentials submitted — waiting for token');

    for (let i = 0; i < 23; i++) {
      await sleep(2000);
      tok = await evalIn(c, TOKEN_EXPR);
      if (tok) {
        log(`login OK (userId ${tok.userId}, expires ${tok.expiration})`);
        await enterSimEnvironment(c);
        return 0;
      }
    }
    throw new Error('token never appeared after submit (bad creds / captcha / device verification?)');
  } catch (e) {
    log(`FAILED: ${e.message}`);
    try {
      const shot = await c.Page.captureScreenshot({ format: 'png' });
      const file = `${DATA_ROOT}/tvo_relogin_fail.png`;
      writeFileSync(file, Buffer.from(shot.data, 'base64'));
      log(`screenshot → ${file}`);
    } catch (_) {}
    return 1;
  } finally {
    await c.close().catch(() => {});
  }
}

main().then(code => process.exit(code)).catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
