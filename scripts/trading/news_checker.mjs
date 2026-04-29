/**
 * news_checker.mjs
 * Fetch high-impact economic news from Forex Factory (via faireconomy.media JSON mirror).
 * Blocks trading 15 min BEFORE and 30 min AFTER any high-impact event for the instrument's currencies.
 * This filter supersedes any trade setup — no exceptions.
 */

const FF_URL    = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const PRE_MIN   = 15; // block this many minutes BEFORE news
const POST_MIN  = 30; // block this many minutes AFTER news

export async function fetchHighImpactNews() {
  try {
    const resp = await fetch(FF_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const events = await resp.json();

    const highImpact = events.filter(e => e.impact === 'High');
    return highImpact.map(e => ({
      date:     e.date,
      time:     e.time,
      currency: e.currency,
      title:    e.title,
      forecast: e.forecast,
      previous: e.previous,
    }));
  } catch (err) {
    console.error('  [news] Forex Factory fetch failed:', err.message);
    return [];
  }
}

export function isSafeToTrade(events, nowUTC = new Date()) {
  const preMs  = PRE_MIN  * 60 * 1000;
  const postMs = POST_MIN * 60 * 1000;

  for (const ev of events) {
    // Parse event datetime (FF format: "Apr 15, 2026 13:30:00")
    const evTime = new Date(ev.date + (ev.time ? ' ' + ev.time : ''));
    if (isNaN(evTime.getTime())) continue;

    // diff > 0 → news is in the future, diff < 0 → news already happened
    const diff = evTime.getTime() - nowUTC.getTime();
    const blocked = (diff >= 0 && diff < preMs)      // within PRE_MIN before news
                 || (diff <  0 && -diff < postMs);   // within POST_MIN after news

    if (blocked) {
      const minLabel = diff >= 0
        ? `in ${Math.round(diff / 60000)} min`
        : `${Math.round(-diff / 60000)} min ago`;
      return {
        safe: false,
        reason: `News ${minLabel}: ${ev.currency} ${ev.title}`,
        event: ev,
        resumeAt: new Date(evTime.getTime() + postMs),
      };
    }
  }
  return { safe: true };
}

export function filterForSymbol(events, symbol) {
  // Maps each instrument to the currencies whose FF news events should block it.
  // For indices/commodities the dominant currency (USD) plus any regional driver is listed.
  const currencyMap = {
    // Forex majors / minors
    'EURUSD': ['EUR', 'USD'],  'GBPUSD': ['GBP', 'USD'],  'USDJPY': ['USD', 'JPY'],
    'AUDUSD': ['AUD', 'USD'],  'USDCAD': ['USD', 'CAD'],  'USDCHF': ['USD', 'CHF'],
    'NZDUSD': ['NZD', 'USD'],  'EURJPY': ['EUR', 'JPY'],  'GBPJPY': ['GBP', 'JPY'],
    'AUDJPY': ['AUD', 'JPY'],
    // Metals
    'XAUUSD': ['USD', 'XAU'], 'XAGUSD': ['USD', 'XAG'],
    // Crypto (USD liquidity events matter)
    'BTCUSD': ['USD'], 'ETHUSD': ['USD'], 'LTCUSD': ['USD'], 'XRPUSD': ['USD'],
    // US indices & energy — driven by USD macro events
    'NAS100': ['USD'], 'SPX500': ['USD'], 'US30': ['USD'], 'WTI': ['USD'],
    // European indices — driven by EUR/GBP events
    'GER40': ['EUR', 'USD'], 'UK100': ['GBP', 'USD'],
  };
  const currencies = currencyMap[symbol] || ['USD'];
  return events.filter(e => currencies.includes(e.currency));
}

// ── CLI usage ──
if (process.argv[1].endsWith('news_checker.mjs')) {
  const events = await fetchHighImpactNews();
  console.log(`\nHigh-impact events this week: ${events.length}`);

  const now = new Date();
  const todayEvents = events.filter(e => {
    const d = new Date(e.date);
    return d.toDateString() === now.toDateString();
  });

  console.log(`\nToday's high-impact events (${now.toDateString()}):`);
  if (todayEvents.length === 0) {
    console.log('  None today — safe to trade all sessions.');
  } else {
    for (const e of todayEvents) {
      console.log(`  ${e.time || 'TBD'} UTC | ${e.currency} | ${e.title} | Forecast: ${e.forecast || '—'} | Prev: ${e.previous || '—'}`);
    }
  }

  const safeCheck = isSafeToTrade(todayEvents);
  console.log(`\nSafe to trade NOW: ${safeCheck.safe ? '✓ YES' : '✗ NO — ' + safeCheck.reason}`);
}
