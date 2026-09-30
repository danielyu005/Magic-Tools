// 把一份 JSON 文章清單逐篇送進「每週美術技術精選」（shareNews，直接上架不經審核）。
//
//   ACD_API_KEY=acd_… node examples/push-news.mjs news.json
//
// JSON 是陣列，每篇：{ url, topic?, title?, source?, publishedAt?, excerpt?, note?, image? }
// 只有 url 必填；其他欄位省略時後端會讀網頁的 og 資訊補上。已在清單裡的文章會回 duplicate，直接略過。
// ACD_API_URL 沒設時讀 web/config.js 的 API_URL。
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const apiKey = process.env.ACD_API_KEY;
if (!file || !apiKey) {
  console.error('用法：ACD_API_KEY=acd_… node examples/push-news.mjs <news.json>');
  process.exit(1);
}
const apiUrl = process.env.ACD_API_URL
  || readFileSync(new URL('../web/config.js', import.meta.url), 'utf8').match(/API_URL:\s*'([^']+)'/)[1];

const items = JSON.parse(readFileSync(file, 'utf8'));
let added = 0, skipped = 0, failed = 0;
for (const data of items) {
  try {
    // Apps Script 會 302 轉址，fetch 預設就會跟過去
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'shareNews', apiKey, data })
    }).then(r => r.json());
    if (res.ok) { added++; console.log('✓', String(res.data?.topic || data.topic || '').padEnd(6), data.title || data.url); }
    else if (res.error?.code === 'duplicate') { skipped++; console.log('·', '略過（已存在）', data.url); }
    else { failed++; console.log('✗', res.error?.message, data.url); }
  } catch (e) {
    failed++; console.log('✗', e.message, data.url);
  }
}
console.log(`\n新增 ${added} 篇、略過 ${skipped} 篇、失敗 ${failed} 篇`);
process.exit(failed ? 1 : 0);
