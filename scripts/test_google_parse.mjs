// Probe Google HTML structure to find tweet snippet content
const r = await fetch('https://www.google.com/search?q=site:x.com+%40muroCrypto&tbs=qdr:d&num=5', {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    'Accept': 'text/html',
    'Accept-Language': 'en-US,en;q=0.9',
  },
  signal: AbortSignal.timeout(10000),
});
const html = await r.text();

// Try to find x.com links with surrounding text
const xLinks = [...html.matchAll(/x\.com\/@?muroCrypto[^"<]*/g)].slice(0,5);
console.log('X.com links found:', xLinks.map(m => m[0]));

// Look for text chunks of 50-300 chars (potential tweet snippets)
// Strategy: find all text nodes between tags, filter by length
const textBlocks = [];
const textRx = />([^<]{50,400})</g;
let m;
while ((m = textRx.exec(html)) !== null && textBlocks.length < 20) {
  const t = m[1]
    .replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&quot;/g,'"')
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s+/g,' ').trim();
  if (t.length > 50 && !t.includes('{') && !t.includes('function') && !t.includes('window.')) {
    textBlocks.push(t);
  }
}

console.log(`\nText blocks (${textBlocks.length}):`);
for (const t of textBlocks.slice(0, 15)) console.log(' -', t.substring(0, 150));
