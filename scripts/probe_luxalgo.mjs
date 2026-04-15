import CDP from 'chrome-remote-interface';

const LUXALGO_CHAT_ID = '6D2EB603F5BAF17F7C2CFA8BB8BBD80D';
const LUXALGO_QUANT_ID = '56835E4F56F263DE3C40D6552A7B1CEB';

async function probeTab(targetId, label) {
  const client = await CDP({ host: 'localhost', port: 9222, target: targetId });
  await client.Runtime.enable();

  const result = await client.Runtime.evaluate({
    expression: `(function() {
      return {
        title: document.title,
        url: window.location.href,
        inputs: Array.from(document.querySelectorAll('input, textarea')).map(e => ({
          tag: e.tagName, type: e.type, placeholder: e.placeholder, id: e.id, name: e.name
        })).slice(0, 10),
        buttons: Array.from(document.querySelectorAll('button')).slice(0,15).map(e => e.innerText.trim()).filter(Boolean),
        mainText: document.body ? document.body.innerText.substring(0, 1200) : 'none',
        hasApi: typeof window.fetch !== 'undefined',
        networkCalls: typeof window.__lux !== 'undefined' ? JSON.stringify(Object.keys(window.__lux || {})) : 'none',
        windowKeys: Object.keys(window).filter(k => k.toLowerCase().includes('lux') || k.toLowerCase().includes('api') || k.toLowerCase().includes('back')).join(', ')
      };
    })()`,
    returnByValue: true
  });

  await client.close();
  console.log(`\n=== ${label} ===`);
  const v = result.result.value;
  console.log('URL:', v.url);
  console.log('Inputs:', JSON.stringify(v.inputs, null, 2));
  console.log('Buttons:', v.buttons.join(' | '));
  console.log('Window API keys:', v.windowKeys);
  console.log('Page text preview:\n', v.mainText);
}

async function main() {
  await probeTab(LUXALGO_CHAT_ID, 'LuxAlgo AI Backtesting Assistant');
  await probeTab(LUXALGO_QUANT_ID, 'LuxAlgo Quant');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
