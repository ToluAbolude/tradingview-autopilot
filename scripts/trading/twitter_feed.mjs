/**
 * market_sentiment.mjs (exported as twitter_feed.mjs for compatibility)
 *
 * Sources (all free, no auth):
 *   1. Crypto Fear & Greed Index  — api.alternative.me/fng
 *   2. CNN Fear & Greed Index     — production.dataviz.cnn.io
 *   3. Reddit r/Forex             — hot posts (forex pairs)
 *   4. Reddit r/wallstreetbets    — hot posts (equities/indices)
 *   5. Reddit r/investing         — hot posts (general bias)
 */

const BULLISH_WORDS = ['long', 'buy', 'bull', 'breakout', 'support', 'bounce', 'pump', 'upside', 'targets', 'load', 'calls', 'green', 'rally', 'ath'];
const BEARISH_WORDS = ['short', 'sell', 'bear', 'breakdown', 'resistance', 'dump', 'downside', 'drop', 'reject', 'puts', 'red', 'crash', 'correction'];
const CAUTION_WORDS = ['careful', 'wait', 'neutral', 'chop', 'range', 'unclear', 'avoid', 'news', 'fomc', 'cpi', 'nfp', 'gdp', 'inflation', 'fed', 'tariff', 'war', 'uncertainty'];

const SYMBOL_MAP = {
  'btc': 'BTCUSD', 'bitcoin': 'BTCUSD',
  'eth': 'ETHUSD', 'ethereum': 'ETHUSD',
  'gold': 'XAUUSD', 'xau': 'XAUUSD',
  'eur': 'EURUSD', 'gbp': 'GBPUSD',
  'spy': 'SPX500', 'qqq': 'NAS100', 'nas': 'NAS100', 'nasdaq': 'NAS100',
  'dow': 'US30', 'dji': 'US30',
  'sol': 'SOLUSD', 'solana': 'SOLUSD',
  'xrp': 'XRPUSD', 'bnb': 'BNBUSD',
  'oil': 'WTI', 'crude': 'WTI',
};

function parseSentiment(text) {
  const lower = text.toLowerCase();
  let bull = 0, bear = 0, caution = 0;
  for (const w of BULLISH_WORDS) if (lower.includes(w)) bull++;
  for (const w of BEARISH_WORDS) if (lower.includes(w)) bear++;
  for (const w of CAUTION_WORDS) if (lower.includes(w)) caution++;

  const symbols = [];
  for (const [kw, sym] of Object.entries(SYMBOL_MAP)) {
    if (lower.includes(kw) && !symbols.includes(sym)) symbols.push(sym);
  }

  const prices = [];
  const priceMatches = text.matchAll(/\$?([\d,]+(?:\.\d+)?)[kK]?(?:\s*(?:target|support|resistance|tp|sl|stop))?/g);
  for (const m of priceMatches) {
    const val = parseFloat(m[1].replace(/,/g, ''));
    if (val > 100 && val < 200000) prices.push(val);
  }

  let sentiment = 'neutral';
  if (caution > 0) sentiment = 'caution';
  else if (bull > bear + 1) sentiment = 'bullish';
  else if (bear > bull + 1) sentiment = 'bearish';

  return { sentiment, bull, bear, caution, symbols, prices };
}

// ── Source 1: Crypto Fear & Greed Index ──────────────────────────────────────

async function fetchCryptoFG() {
  try {
    const resp = await fetch('https://api.alternative.me/fng/?limit=1', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(4000),
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    const entry = json?.data?.[0];
    if (!entry) return null;

    const score = parseInt(entry.value, 10);
    const label = entry.value_classification; // e.g. "Greed", "Fear"
    const text  = `Crypto Fear & Greed: ${score} (${label})`;

    // Map score → bull/bear counts
    let bull = 0, bear = 0, caution = 0;
    if      (score <= 25) { bear    = 3; }
    else if (score <= 44) { bear    = 2; }
    else if (score <= 55) { bull = 1; bear = 1; }
    else if (score <= 74) { bull    = 2; }
    else                  { bull = 2; caution = 1; } // extreme greed = overbought

    const sentiment = caution > 0 ? 'caution' : bull > bear ? 'bullish' : bear > bull ? 'bearish' : 'neutral';
    console.log(`  Crypto F&G: ${score} ${label} → ${sentiment}`);
    return { account: 'crypto_fg', tweet: text, sentiment, bull, bear, caution, symbols: ['BTCUSD', 'ETHUSD'], prices: [] };
  } catch(e) {
    return null;
  }
}

// ── Source 2: CNN Fear & Greed Index ─────────────────────────────────────────

async function fetchCNNFG() {
  try {
    const resp = await fetch('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://edition.cnn.com/',
      },
      signal: AbortSignal.timeout(4000),
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    const score = json?.fear_and_greed?.score;
    const rating = json?.fear_and_greed?.rating;
    if (score == null) return null;

    const s = Math.round(score);
    const text = `CNN Fear & Greed: ${s} (${rating})`;

    let bull = 0, bear = 0, caution = 0;
    if      (s <= 25) { bear    = 3; }
    else if (s <= 44) { bear    = 2; }
    else if (s <= 55) { bull = 1; bear = 1; }
    else if (s <= 74) { bull    = 2; }
    else              { bull = 2; caution = 1; }

    const sentiment = caution > 0 ? 'caution' : bull > bear ? 'bullish' : bear > bull ? 'bearish' : 'neutral';
    console.log(`  CNN F&G: ${s} ${rating} → ${sentiment}`);
    return { account: 'cnn_fg', tweet: text, sentiment, bull, bear, caution, symbols: ['NAS100', 'SPX500', 'US30'], prices: [] };
  } catch(e) {
    return null;
  }
}

// ── Source 3: Reddit ──────────────────────────────────────────────────────────

async function fetchReddit(subreddit, limit = 10) {
  try {
    const url = `https://www.reddit.com/r/${subreddit}/hot.json?limit=${limit}&t=day`;
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'trading-sentiment-bot/1.0',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(4000),
    });
    if (!resp.ok) return [];
    const json = await resp.json();
    return (json?.data?.children || [])
      .map(c => c?.data?.title || '')
      .filter(t => t.length > 10);
  } catch(e) {
    return [];
  }
}

async function fetchRedditSignals(subreddit, defaultSymbols = []) {
  const posts = await fetchReddit(subreddit);
  if (posts.length === 0) return null;

  let totalBull = 0, totalBear = 0, totalCaution = 0;
  const symbolCounts = {};

  for (const post of posts) {
    const p = parseSentiment(post);
    totalBull    += p.bull;
    totalBear    += p.bear;
    totalCaution += p.caution;
    for (const sym of p.symbols) symbolCounts[sym] = (symbolCounts[sym] || 0) + 1;
  }

  // Top mentioned symbols + defaults
  const topSymbols = [
    ...Object.entries(symbolCounts).sort((a,b) => b[1]-a[1]).slice(0,3).map(e => e[0]),
    ...defaultSymbols,
  ].filter((v, i, a) => a.indexOf(v) === i);

  const sentiment = totalCaution > 2 ? 'caution'
    : totalBull > totalBear + 2  ? 'bullish'
    : totalBear > totalBull + 2  ? 'bearish'
    : 'neutral';

  const summary = `r/${subreddit} (${posts.length} posts): bull=${totalBull} bear=${totalBear} caution=${totalCaution}`;
  console.log(`  ${summary} → ${sentiment}`);

  return {
    account: `r/${subreddit}`,
    tweet: summary,
    sentiment,
    bull: totalBull,
    bear: totalBear,
    caution: totalCaution,
    symbols: topSymbols,
    prices: [],
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function fetchTwitterSignals() {
  const [cryptoFG, cnnFG, redditForex, redditWSB, redditInvesting] = await Promise.all([
    fetchCryptoFG(),
    fetchCNNFG(),
    fetchRedditSignals('Forex',           ['EURUSD', 'GBPUSD']),
    fetchRedditSignals('wallstreetbets',  ['NAS100', 'SPX500']),
    fetchRedditSignals('investing',       []),
  ]);

  const signals = [cryptoFG, cnnFG, redditForex, redditWSB, redditInvesting].filter(Boolean);

  if (signals.length === 0) {
    console.log('  Sentiment: all sources down — skipping');
  }

  return signals;
}

// aggregateSignals unchanged — same interface for session_runner.mjs
export function aggregateSignals(signals) {
  const bySymbol = {};

  for (const s of signals) {
    for (const sym of (s.symbols.length ? s.symbols : ['GENERAL'])) {
      if (!bySymbol[sym]) bySymbol[sym] = { bull: 0, bear: 0, caution: 0, mentions: 0 };
      bySymbol[sym].bull    += s.bull;
      bySymbol[sym].bear    += s.bear;
      bySymbol[sym].caution += s.caution;
      bySymbol[sym].mentions++;
    }
  }

  const result = {};
  for (const [sym, counts] of Object.entries(bySymbol)) {
    result[sym] = {
      bias: counts.caution > 1 ? 'caution' :
            counts.bull > counts.bear + 1 ? 'bullish' :
            counts.bear > counts.bull + 1 ? 'bearish' : 'neutral',
      counts,
    };
  }
  return result;
}

// ── CLI usage ──
if (process.argv[1].endsWith('twitter_feed.mjs')) {
  console.log('\nFetching market sentiment signals...\n');
  const signals = await fetchTwitterSignals();
  const agg = aggregateSignals(signals);

  console.log('\nRaw signals:', signals.length);
  for (const s of signals) {
    console.log(`  [${s.account}] ${s.sentiment} ${s.symbols.join(',')} — "${s.tweet.substring(0, 80)}"`);
  }

  console.log('\nAggregated bias:');
  for (const [sym, data] of Object.entries(agg)) {
    console.log(`  ${sym}: ${data.bias} (bull=${data.counts.bull} bear=${data.counts.bear})`);
  }
}
