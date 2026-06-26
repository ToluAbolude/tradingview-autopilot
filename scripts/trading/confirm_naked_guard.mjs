/**
 * confirm_naked_guard.mjs — cTrader-only never-naked guard for the confirm daemon.
 *
 * Enforces the hard rule "no open position without BOTH stop-loss and take-profit"
 * on the isolated confirm demo account. Every run: any position missing SL or TP
 * is closed immediately (the account holds only confirm trades, so close is the
 * safe, unambiguous action). Pure cTrader Open API — NO Chrome/CDP, runs headless.
 *
 * Cron: every ~5 min (staggered from confirm_runner). Demo-only by env.
 */
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import os from 'os';

const DATA_ROOT = os.platform() === 'linux'
  ? '/home/ubuntu/trading-data'
  : 'C:/Users/Tda-d/tradingview-mcp-jackson/data';
const LOG = join(DATA_ROOT, 'confirm_naked_guard.jsonl');

function log(obj) {
  const line = `[${new Date().toISOString()}] ${typeof obj === 'string' ? obj : JSON.stringify(obj)}`;
  process.stdout.write(line + '\n');
  if (!existsSync(DATA_ROOT)) mkdirSync(DATA_ROOT, { recursive: true });
  appendFileSync(LOG, line + '\n');
}

async function main() {
  const env = (process.env.CTRADER_ENV || 'demo').toLowerCase();
  if (env !== 'demo') { log(`refusing: CTRADER_ENV=${env} (demo-only guard)`); process.exit(0); }

  const b = await import('./broker_ctrader.mjs');
  await b.connect();
  const naked = await b.getNakedPositions();
  if (!naked.length) { log('OK — no naked positions'); process.exit(0); }

  for (const p of naked) {
    log(`⚠ NAKED ${p.symbolName} pos=${p.positionId} dir=${p.direction} SL=${p.stopLoss} TP=${p.takeProfit} — closing`);
    try { await b.closePosition(p.positionId); log(`closed ${p.positionId}`); }
    catch (e) { log(`✗ close ${p.positionId} failed: ${e.message}`); }
  }
  process.exit(0);
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
