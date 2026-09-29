// 把一份 JSON 工具清單逐筆提交上架（submit kind:new，進審核佇列，由管理者核准）。
//
//   ACD_API_KEY=acd_… node examples/push-tools.mjs tools.json
//
// JSON 是陣列，每筆：{ tab, category, name, owner, desc, clientUrl, repoUrl?, docUrl?, tags?, authors?, version?, date?, summary? }
// authors 是作者 Email 陣列，列在裡面的人登入後可以編輯這個工具。
// 陳列窗上已有同名工具的會直接略過（審核中的提交 Agent 看不到，重跑前先確認佇列）。
// ACD_API_URL 沒設時讀 web/config.js 的 API_URL。
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const apiKey = process.env.ACD_API_KEY;
if (!file || !apiKey) {
  console.error('用法：ACD_API_KEY=acd_… node examples/push-tools.mjs <tools.json>');
  process.exit(1);
}
const apiUrl = process.env.ACD_API_URL
  || readFileSync(new URL('../web/config.js', import.meta.url), 'utf8').match(/API_URL:\s*'([^']+)'/)[1];

// Apps Script 會 302 轉址，fetch 預設就會跟過去
const call = body => fetch(apiUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain;charset=utf-8' },
  body: JSON.stringify({ apiKey, ...body })
}).then(r => r.json());

// 查不到現有工具（後端逾時等）時照樣送出，重複的交給審核擋下
const norm = s => String(s || '').trim().toLowerCase();
const existing = new Set();
try {
  const list = await call({ action: 'list' });
  if (!list.ok) throw new Error(list.error?.message);
  (list.data.tools || []).forEach(t => existing.add(norm(t.name)));
} catch (e) {
  console.warn('⚠ 讀不到現有工具清單，不檢查重複：', e.message);
}

const items = JSON.parse(readFileSync(file, 'utf8'));
let added = 0, skipped = 0, failed = 0;
for (const item of items) {
  if (existing.has(norm(item.name))) { skipped++; console.log('·', '略過（已上架）', item.name); continue; }
  try {
    const res = await call({ action: 'submit', data: { kind: 'new', summary: '首次上架', ...item } });
    if (res.ok) { added++; console.log('✓', item.tab.padEnd(5), item.name); }
    else { failed++; console.log('✗', res.error?.message, item.name); }
  } catch (e) {
    failed++; console.log('✗', e.message, item.name);
  }
}
console.log(`\n送出 ${added} 筆（待審核）、略過 ${skipped} 筆、失敗 ${failed} 筆`);
process.exit(failed ? 1 : 0);
