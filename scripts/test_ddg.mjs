const r = await fetch('https://html.duckduckgo.com/html/?q=site:x.com+%40muroCrypto+crypto&df=d', {
  headers: {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'},
  signal: AbortSignal.timeout(10000),
});
const t = await r.text();
const blocks = [];
const rx = />([^<]{60,400})</g;
let m;
while ((m = rx.exec(t)) !== null && blocks.length < 10) {
  const s = m[1].replace(/&amp;/g,'&').replace(/&#x27;/g,"'").replace(/\s+/g,' ').trim();
  if (!s.includes('function') && !s.includes('{ ') && s.length > 60) blocks.push(s);
}
console.log('HTTP:', r.status, 'len:', t.length);
for (const b of blocks) console.log(' -', b.substring(0, 130));
