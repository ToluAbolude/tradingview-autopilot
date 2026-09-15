/**
 * strategies.mjs — the strategy registry. Every plugged-in strategy is a folder
 * scripts/trading/strategies/<id>/ holding manifest.json (see the README there).
 * manifestErrors() is pure; loadStrategies() reads the folders and imports the logic.
 */
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const TRADING = join(dirname(fileURLToPath(import.meta.url)), '..');
export const STRATEGIES_DIR = join(TRADING, 'strategies');
const MODULES_DIR = join(TRADING, 'confirm', 'strategies');   // shared logic modules ("module": "<name>")

// Timeframes a manifest may use: cTrader trendbar period + bar length.
export const TIMEFRAMES = {
  '5':   { period: 'M5',  ms: 3e5 },
  '15':  { period: 'M15', ms: 9e5 },
  '30':  { period: 'M30', ms: 18e5 },
  '60':  { period: 'H1',  ms: 36e5 },
  '240': { period: 'H4',  ms: 144e5 },
  'D':   { period: 'D1',  ms: 864e5 },
};

// Runner-level filters a manifest may switch on (implemented in strategy_runner.mjs).
export const FILTERS = ['prior_day_range', 'news_recent'];

const KEYS = new Set(['id', 'description', 'enabled', 'mode', 'account', 'logic', 'instruments',
  'timeframe', 'history_days', 'params', 'filters', 'target', 'risk']);
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

/** Everything wrong with a manifest, or []. `folder` is the folder it was read from. */
export function manifestErrors(m, folder) {
  if (!isObj(m)) return ['manifest is not a JSON object'];
  const e = [];
  for (const k of Object.keys(m)) if (!KEYS.has(k)) e.push(`unknown field "${k}"`);
  if (typeof m.id !== 'string' || !/^[a-z0-9_]{1,40}$/.test(m.id)) e.push('id must be 1-40 characters of a-z, 0-9 and _');
  else if (folder !== undefined && m.id !== folder) e.push(`id "${m.id}" must match its folder name "${folder}"`);
  if (typeof m.enabled !== 'boolean') e.push('enabled must be true or false');
  if (m.mode !== 'paper' && m.mode !== 'live') e.push('mode must be "paper" or "live"');
  if (typeof m.account !== 'string' || !/^\d+$/.test(m.account)) e.push('account must be the cTrader account number, as a string');
  const mod = m.logic?.module, file = m.logic?.file;
  if (!isObj(m.logic) || (mod === undefined) === (file === undefined)) e.push('logic must have exactly one of "module" or "file"');
  else if (mod !== undefined && !(typeof mod === 'string' && /^[a-z0-9_]+$/.test(mod))) e.push('logic.module must be a module name like "orb"');
  else if (file !== undefined && !(typeof file === 'string' && /^[\w-]+\.mjs$/.test(file))) e.push('logic.file must be a .mjs file name in the strategy folder');
  if (!Array.isArray(m.instruments) || !m.instruments.length || !m.instruments.every(s => typeof s === 'string' && /^[A-Z0-9]+$/.test(s))) {
    e.push('instruments must be a non-empty list of symbols like "EURUSD"');
  } else if (new Set(m.instruments).size !== m.instruments.length) e.push('instruments has duplicates');
  if (typeof m.timeframe !== 'string' || !(m.timeframe in TIMEFRAMES)) e.push(`timeframe must be one of ${Object.keys(TIMEFRAMES).join(', ')}`);
  if (m.history_days !== undefined && !(Number.isFinite(m.history_days) && m.history_days > 0)) e.push('history_days must be a positive number');
  if (m.params !== undefined && !isObj(m.params)) e.push('params must be an object');
  if (m.filters !== undefined && !(Array.isArray(m.filters) && m.filters.every(f => FILTERS.includes(f)))) e.push(`filters may only contain ${FILTERS.join(', ')}`);
  if (!isObj(m.target) || !(Number.isFinite(m.target.r) && m.target.r >= 1)) e.push('target.r must be a number >= 1');
  if (!isObj(m.risk) || !(Number.isFinite(m.risk.per_trade_pct) && m.risk.per_trade_pct > 0 && m.risk.per_trade_pct <= 2)) {
    e.push('risk.per_trade_pct must be above 0 and at most 2');
  }
  return e;
}

/**
 * Read every strategies/<id>/manifest.json, validate it and import its logic.
 * Returns { strategies: [{ manifest, logic, dir }], errors: [{ id, errors }] } — a
 * broken strategy lands in errors and never stops the others from loading.
 */
export async function loadStrategies(dir = STRATEGIES_DIR) {
  const strategies = [], errors = [];
  const folders = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()
    : [];
  for (const folder of folders) {
    const file = join(dir, folder, 'manifest.json');
    if (!existsSync(file)) continue;   // a folder without a manifest is not a strategy
    let m;
    try { m = JSON.parse(readFileSync(file, 'utf8')); }
    catch (err) { errors.push({ id: folder, errors: [`manifest.json is not valid JSON: ${err.message}`] }); continue; }
    const problems = manifestErrors(m, folder);
    if (!problems.length) {
      const path = m.logic.module ? join(MODULES_DIR, `${m.logic.module}.mjs`) : join(dir, folder, m.logic.file);
      try {
        const logic = (await import(pathToFileURL(path).href)).default;
        if (typeof logic?.generateSignals !== 'function') problems.push(`logic "${m.logic.module ?? m.logic.file}" has no default export with generateSignals()`);
        else strategies.push({ manifest: { history_days: 20, params: {}, filters: [], ...m }, logic, dir: join(dir, folder) });
      } catch (err) {
        problems.push(`cannot load logic: ${err.message}`);
      }
    }
    if (problems.length) errors.push({ id: folder, errors: problems });
  }
  return { strategies, errors };
}
