/**
 * twitter_feed.mjs
 * Scrape recent posts from key trading accounts via Nitter (X/Twitter proxy).
 * Accounts: @muroCrypto, @i_am_jackis, @eliz883, @CryptoBullet
 *
 * Returns sentiment signals and any mentioned symbols/price levels.
 */

const ACCOUNTS = ['muroCrypto', 'i_am_jackis', 'eliz883', 'CryptoBullet'];

// Nitter instances (public, no auth needed) — ordered by reliability
const NITTER_HOSTS = [
  'https://nitter.privacydev.net',
  'https://nitter.poast.org',
  'https://nitter.1d4.us',
  'https://nitter.cz',
  'https://nitter.unixfox.eu',
  'https://nitter.it',
  'https://nitter.nl',
  'https://nitter.fdn.fr',
  'https://nitter.42l.fr',
  'https://nitter.d420.de',
  'https://nitter.moomoo.me',
];

// Keywords that signal a trade call
const BULLISH_WORDS = ['long', 'buy', 'bull', 'breakout', 'support', 'bounce', 'pump', 'upside', 'targets', 'load'];
const BEARISH_WORDS = ['short', 'sell', 'bear', 'breakdown', 'resistance', 'dump', 'downside', 'drop', 'reject'];
const CAUTION_WORDS = ['careful', 'wait', 'neutral', 'chop', 'range', 'unclear', 'avoid', 'news', 'fomc', 'cpi', 'nfp'];

// Symbols mentioned in tweets
const SYMBOL_MAP = {
  'btc': 'BTCUSD', 'bitcoin': 'BTCUSD',
  'eth': 'ETHUSD', 'ethereum': 'ETHUSD',
  'gold': 'XAUUSD', 'xau': 'XAUUSD',
  'eur': 'EURUSD', 'gbp': 'GBPUSD',
  'spy': 'SPY', 'qqq': 'NAS100', 'nas': 'NAS100',
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

  // Extract price levels e.g. "$2,300" or "2300"
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

async function fetchNitter(account, host) {
  const url = `${host}/${account}`;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();

    // Extract tweet texts from Nitter HTML
    const tweets = [];
    const tweetRegex = /<div class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
    let match;
    while ((match = tweetRegex.exec(html)) !== null && tweets.length < 5) {
      const text = match[1]
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
      if (text.length > 20) tweets.push(text);
    }
    return tweets;
  } catch(e) {
    return null; // try next host
  }
}

// Fallback: scrape Google search snippets for recent tweets
async function fetchViaSearch(account) {
  try {
    const url = `https://www.google.com/search?q=site:x.com+%40${account}&tbs=qdr:d&num=5`;
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    // Extract text from search result snippets
    const snippets = [];
    const spanRx = /<span[^>]*>([^<]{30,300})<\/span>/g;
    let m;
    while ((m = spanRx.exec(html)) !== null && snippets.length < 5) {
      const t = m[1].replace(/&#\d+;/g, ' ').replace(/&[a-z]+;/g, ' ').trim();
      if (t.length > 30 && !t.includes('cached') && !t.includes('translate')) snippets.push(t);
    }
    return snippets.length > 0 ? snippets : null;
  } catch(e) {
    return null;
  }
}

export async function fetchTwitterSignals() {
  const signals = [];

  for (const account of ACCOUNTS) {
    let tweets = null;

    // Try each nitter host
    for (const host of NITTER_HOSTS) {
      tweets = await fetchNitter(account, host);
      if (tweets && tweets.length > 0) break;
    }

    // Fallback: Google search snippets
    if (!tweets || tweets.length === 0) {
      tweets = await fetchViaSearch(account);
      if (tweets && tweets.length > 0) {
        console.log(`  @${account}: ${tweets.length} results via search fallback`);
      }
    }

    if (!tweets || tweets.length === 0) {
      console.log(`  @${account}: unreachable (nitter + search down)`);
      continue;
    }

    for (const tweet of tweets.slice(0, 3)) {
      const parsed = parseSentiment(tweet);
      if (parsed.sentiment !== 'neutral' || parsed.symbols.length > 0) {
        signals.push({
          account,
          tweet: tweet.substring(0, 200),
          ...parsed,
        });
      }
    }
    console.log(`  @${account}: ${tweets.length} tweets, sentiment=${parseSentiment(tweets[0] || '').sentiment}`);
  }

  return signals;
}

// Aggregate to a single market bias
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
  console.log('\nFetching X/Twitter signals...\n');
  const signals = await fetchTwitterSignals();
  const agg = aggregateSignals(signals);

  console.log('\nRaw signals:', signals.length);
  for (const s of signals) {
    console.log(`  @${s.account} [${s.sentiment}] ${s.symbols.join(',')} — "${s.tweet.substring(0,80)}"`);
  }

  console.log('\nAggregated bias:');
  for (const [sym, data] of Object.entries(agg)) {
    console.log(`  ${sym}: ${data.bias} (bull=${data.counts.bull} bear=${data.counts.bear})`);
  }
}
