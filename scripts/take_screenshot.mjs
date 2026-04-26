import { getClient } from '../src/connection.js';
import { writeFileSync } from 'fs';

const client = await getClient();
const { data } = await client.Page.captureScreenshot({ format: 'png', quality: 80 });
const path = '/home/ubuntu/tradingview-mcp-jackson/screenshots/state_' + Date.now() + '.png';
writeFileSync(path, Buffer.from(data, 'base64'));
console.log('Screenshot:', path);
