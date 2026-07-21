#!/usr/bin/env node
/**
 * ctrader_refresh.mjs — refresh the cTrader Open API access token using the
 * stored refresh token, then persist BOTH new tokens back into the env file.
 *
 * Usage:  node scripts/trading/ctrader_refresh.mjs <env-file> [more-env-files...]
 *
 * The refresh uses the FIRST file's refresh token; the new token pair is then
 * persisted into EVERY listed file. Both trading envs (.ctrader.env scanner +
 * .ctrader_confirm.env experiment) share one client app and one grant, so they
 * MUST be rotated together — a file left holding the consumed refresh token
 * dies with ACCESS_DENIED at its next refresh (how the confirm env broke).
 *
 * cTrader access tokens live ~30 days; when one expires every consumer
 * (confirm_runner, naked guards, notion sync, EOD report...) dies with
 * CH_ACCESS_TOKEN_INVALID (2026-07-19..21 outage). Refresh tokens are
 * SINGLE-USE: this call consumes the old one, so the new pair MUST be written
 * back atomically — if the write is lost, recovery is the full browser OAuth
 * flow (ctrader_oauth_helper.mjs on the local PC).
 */
import fs from 'fs';

const envPaths = process.argv.slice(2);
if (!envPaths.length || envPaths.some((p) => !fs.existsSync(p))) {
  console.error('usage: ctrader_refresh.mjs <env-file> [more-env-files...] (all must exist)');
  process.exit(1);
}

const envPath = envPaths[0];
const txt = fs.readFileSync(envPath, 'utf8');
const get = (k) => (txt.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1]?.trim();
const clientId = get('CTRADER_CLIENT_ID');
const clientSecret = get('CTRADER_CLIENT_SECRET');
const refresh = get('CTRADER_REFRESH_TOKEN');
if (!clientId || !clientSecret || !refresh) {
  console.error(`[ctrader_refresh] ${envPath}: missing CTRADER_CLIENT_ID / CTRADER_CLIENT_SECRET / CTRADER_REFRESH_TOKEN`);
  process.exit(1);
}

const url =
  'https://openapi.ctrader.com/apps/token' +
  '?grant_type=refresh_token' +
  `&refresh_token=${encodeURIComponent(refresh)}` +
  `&client_id=${encodeURIComponent(clientId)}` +
  `&client_secret=${encodeURIComponent(clientSecret)}`;

const r = await fetch(url);
const body = await r.json().catch(() => ({}));
if (!body.accessToken || !body.refreshToken) {
  console.error(`[ctrader_refresh] ${envPath}: refresh FAILED — ${JSON.stringify(body)}`);
  console.error('[ctrader_refresh] if the refresh token is dead, redo the browser flow: ctrader_oauth_helper.mjs on the local PC');
  process.exit(2);
}

const days = Math.round((body.expiresIn || 0) / 86400);
for (const p of envPaths) {
  const src = fs.readFileSync(p, 'utf8');
  const out = src
    .replace(/^CTRADER_ACCESS_TOKEN=.*$/m, 'CTRADER_ACCESS_TOKEN=' + body.accessToken)
    .replace(/^CTRADER_REFRESH_TOKEN=.*$/m, 'CTRADER_REFRESH_TOKEN=' + body.refreshToken);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, out, { mode: 0o600 });
  fs.renameSync(tmp, p);
  console.log(`[ctrader_refresh] ${new Date().toISOString()} ${p}: tokens rotated, access token expires in ~${days} days`);
}
