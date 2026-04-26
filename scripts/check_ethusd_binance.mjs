// Fetch ETHUSDT 5M candles from Binance for Apr 16-17 2026
// Entry: 2309.7, SL: 2304.4486, TP: 2320.2029 at 2026-04-16T15:01:27Z

const entryTs  = new Date('2026-04-16T15:01:27Z').getTime();
const windowEnd = new Date('2026-04-17T14:00:00Z').getTime();
const entry = 2309.7, sl = 2304.4486, tp = 2320.2029;

const url = `https://api.binance.com/api/v3/klines?symbol=ETHUSDT&interval=5m&startTime=${entryTs - 60000}&endTime=${windowEnd}&limit=500`;

console.log('Fetching:', url.replace(/\?.*/, '?...'));
const resp = await fetch(url);
if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);

const candles = await resp.json();
console.log(`Got ${candles.length} candles from ${new Date(candles[0][0]).toISOString().slice(0,16)} to ${new Date(candles[candles.length-1][0]).toISOString().slice(0,16)}`);

// Each candle: [openTime, open, high, low, close, volume, ...]
let result = '?';
for (const c of candles) {
  const t = c[0]; // ms
  const h = parseFloat(c[2]);
  const l = parseFloat(c[3]);
  const dt = new Date(t).toISOString().slice(11, 19);

  if (l <= sl && h >= tp) { console.log(`AMBIGUOUS at ${dt}: low=${l} high=${h}`); break; }
  if (l <= sl) { console.log(`>>> LOSS — SL=${sl} hit at ${dt}, candle low=${l}`); result = 'L'; break; }
  if (h >= tp) { console.log(`>>> WIN  — TP=${tp} hit at ${dt}, candle high=${h}`); result = 'W'; break; }
}
if (result === '?') console.log(`INCONCLUSIVE — checked ${candles.length} candles, neither SL nor TP hit`);
console.log('ETHUSD result (from Binance ETHUSDT):', result);
