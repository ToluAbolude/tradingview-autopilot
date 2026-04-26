// Test what Twitter data sources work from this VM

// Test 1: Nitter
const nitterHosts = ['https://nitter.poast.org', 'https://nitter.privacydev.net', 'https://nitter.1d4.us'];
for (const host of nitterHosts) {
  try {
    const r = await fetch(`${host}/muroCrypto`, { signal: AbortSignal.timeout(6000), headers: {'User-Agent':'Mozilla/5.0'} });
    const text = await r.text();
    const hasTweets = text.includes('tweet-content') || text.includes('timeline-item');
    console.log(`Nitter ${host}: HTTP ${r.status}, hasTweets=${hasTweets}`);
    if (hasTweets) { console.log('  WORKING!'); break; }
  } catch(e) { console.log(`Nitter ${host}: FAIL ${e.message}`); }
}

// Test 2: Twitter syndication (used by embedded timelines, no auth needed)
try {
  const r = await fetch('https://syndication.twitter.com/srv/timeline-profile/screen-name/muroCrypto', {
    signal: AbortSignal.timeout(8000),
    headers: {'User-Agent':'Mozilla/5.0', 'Accept':'application/json'}
  });
  const text = await r.text();
  console.log(`Syndication: HTTP ${r.status}, length=${text.length}`);
  if (r.ok) console.log('  Sample:', text.slice(0,300));
} catch(e) { console.log(`Syndication: FAIL ${e.message}`); }

// Test 3: Twitter guest token flow
try {
  const bearerToken = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I%2FeLDgiU%3DEUifiRBkKG5E2XzMDjRfl76ZoRhejosmNoes5Ice2Xl';
  const gtRes = await fetch('https://api.twitter.com/1.1/guest/activate.json', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${decodeURIComponent(bearerToken)}`, 'Content-Length': '0' },
    signal: AbortSignal.timeout(8000),
  });
  const gt = await gtRes.json();
  console.log(`Guest token: HTTP ${gtRes.status}, token=${JSON.stringify(gt).slice(0,80)}`);
  if (gt.guest_token) {
    const tlRes = await fetch('https://api.twitter.com/1.1/statuses/user_timeline.json?screen_name=muroCrypto&count=5&tweet_mode=extended', {
      headers: {
        'Authorization': `Bearer ${decodeURIComponent(bearerToken)}`,
        'x-guest-token': gt.guest_token,
      },
      signal: AbortSignal.timeout(8000),
    });
    const tl = await tlRes.json();
    console.log(`Timeline: HTTP ${tlRes.status}, tweets=${Array.isArray(tl)?tl.length:'not array'}`);
    if (Array.isArray(tl) && tl.length > 0) console.log('  First tweet:', tl[0].full_text?.slice(0,100));
  }
} catch(e) { console.log(`Guest token flow: FAIL ${e.message}`); }

// Test 4: Google search
try {
  const r = await fetch('https://www.google.com/search?q=site:x.com+%40muroCrypto&tbs=qdr:d&num=5', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(8000),
  });
  const t = await r.text();
  const hasResults = t.includes('x.com') && t.length > 5000;
  console.log(`Google: HTTP ${r.status}, hasResults=${hasResults}, len=${t.length}`);
} catch(e) { console.log(`Google: FAIL ${e.message}`); }
