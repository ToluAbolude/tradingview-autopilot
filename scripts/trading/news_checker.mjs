/**
 * news_checker.mjs
 * Fetch high-impact economic news from Forex Factory JSON API.
 * Returns true if it's safe to trade (no news within ±30 min).
 */

const FF_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const BUFFER_MIN = 30; // minutes to avoid before/after news

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
  const bufferMs = BUFFER_MIN * 60 * 1000;

  for (const ev of events) {
    // Parse event datetime (FF format: "Apr 15, 2026 13:30:00")
    const evTime = new Date(ev.date + (ev.time ? ' ' + ev.time : ''));
    if (isNaN(evTime.getTime())) continue;

    const diff = evTime.getTime() - nowUTC.getTime();
    // Block if news is within ±buffer
    if (Math.abs(diff) < bufferMs) {
      return {
        safe: false,
        reason: `News in ${Math.round(diff / 60000)} min: ${ev.currency} ${ev.title}`,
        event: ev,
        resumeAt: new Date(evTime.getTime() + bufferMs),
      };
    }
  }
  return { safe: true };
}

export function filterForSymbol(events, symbol) {
  const currencyMap = {
    'EURUSD': ['EUR', 'USD'], 'GBPUSD': ['GBP', 'USD'], 'USDJPY': ['USD', 'JPY'],
    'AUDUSD': ['AUD', 'USD'], 'USDCAD': ['USD', 'CAD'], 'XAUUSD': ['USD', 'XAU'],
    'BTCUSD': ['USD', 'BTC'], 'ETHUSD': ['USD', 'ETH'], 'NAS100': ['USD'],
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
