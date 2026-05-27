/**
 * ctrader_oauth_helper.mjs — One-shot OAuth flow to obtain access + refresh
 * tokens for cTrader Open API.
 *
 * Usage (run on a machine with a browser — i.e. local PC, NOT the VM):
 *   $env:CTRADER_CLIENT_ID = "..."
 *   $env:CTRADER_CLIENT_SECRET = "..."
 *   node scripts/trading/ctrader_oauth_helper.mjs
 *
 * What it does:
 *   1. Starts a tiny localhost:8080 HTTP server (the redirect target)
 *   2. Opens your browser to id.ctrader.com OAuth grant page
 *   3. After you click "Allow" in the browser, captures the ?code= back
 *   4. Exchanges code → access_token + refresh_token via POST to openapi.ctrader.com
 *   5. Prints the tokens. You then put them in /home/ubuntu/.ctrader.env on the VM.
 *
 * The redirect URI you registered at openapi.ctrader.com/apps MUST be exactly
 * http://localhost:8080/  (with the trailing slash).
 */
import http from 'http';
import { exec } from 'child_process';

const CLIENT_ID     = process.env.CTRADER_CLIENT_ID;
const CLIENT_SECRET = process.env.CTRADER_CLIENT_SECRET;
const REDIRECT_URI  = 'http://localhost:8080/';
const SCOPE         = 'trading';   // full trading access

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing CTRADER_CLIENT_ID or CTRADER_CLIENT_SECRET env vars.');
  console.error('Get them from https://openapi.ctrader.com/apps after registering an app.');
  process.exit(1);
}

const authUrl =
  'https://id.ctrader.com/my/settings/openapi/grantingaccess/' +
  `?client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&scope=${SCOPE}` +
  `&product=web`;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost:8080');
  const code = u.searchParams.get('code');
  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('No ?code= in URL. Bad redirect.');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Got code. Check your terminal — exchanging for tokens now. You can close this tab.');

  // Exchange code → tokens
  const tokenUrl =
    'https://openapi.ctrader.com/apps/token' +
    `?grant_type=authorization_code` +
    `&code=${encodeURIComponent(code)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&client_id=${encodeURIComponent(CLIENT_ID)}` +
    `&client_secret=${encodeURIComponent(CLIENT_SECRET)}`;

  try {
    const r = await fetch(tokenUrl, { method: 'GET' });
    const body = await r.json();
    if (body.errorCode) {
      console.error('Token exchange failed:', body);
      process.exit(2);
    }
    console.log('\n=== TOKENS ===');
    console.log('CTRADER_ACCESS_TOKEN=' + body.accessToken);
    console.log('CTRADER_REFRESH_TOKEN=' + body.refreshToken);
    console.log(`Expires in ${body.expiresIn}s (~${Math.round(body.expiresIn/86400)} days)`);
    console.log('\nPaste those two lines into /home/ubuntu/.ctrader.env on the VM (along with CTRADER_CLIENT_ID, CTRADER_CLIENT_SECRET, CTRADER_ACCOUNT_ID, CTRADER_ENV).');
    process.exit(0);
  } catch (e) {
    console.error('Token exchange error:', e);
    process.exit(3);
  }
});

server.listen(8080, () => {
  console.log(`Listening on ${REDIRECT_URI}`);
  console.log('\nOpen this URL in a browser if it doesn\'t open automatically:');
  console.log(authUrl);

  // Auto-open browser
  const opener = process.platform === 'win32' ? 'start' :
                 process.platform === 'darwin' ? 'open' : 'xdg-open';
  exec(`${opener} "${authUrl}"`, () => {});
});
