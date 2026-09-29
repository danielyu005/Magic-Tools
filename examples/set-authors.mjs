// 幫已上架的工具補上作者 Email（updateTool），作者登入後就能編輯自己的工具。
//
//   ACD_API_KEY=acd_… node examples/set-authors.mjs examples/notion-authors.json
//
// JSON 是「開發成員名稱 → Email」對照表，多位作者用逗號分隔：{ "RD4_小明": "a@gmail.com, b@gmail.com" }
// 依工具的「開發成員」欄位（多位以頓號分隔）對照；Email 空白的略過。
// Agent 金鑰只能改記在它擁有者名下的工具，還在審核中的提交要等核准後再跑。
// ACD_API_URL 沒設時讀 web/config.js 的 API_URL。
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const apiKey = process.env.ACD_API_KEY;
if (!file || !apiKey) {
  console.error('用法：ACD_API_KEY=acd_… node examples/set-authors.mjs <authors.json>');
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

const map = JSON.parse(readFileSync(file, 'utf8'));
const emailsOf = owner => [...new Set(String(owner || '').split(/[、,，]/).map(s => s.trim())
  .flatMap(n => String(map[n] || '').split(/[,，\s]+/)).map(s => s.trim().toLowerCase()).filter(Boolean))];

const list = await call({ action: 'list' });
if (!list.ok) { console.error('✗ 讀取工具清單失敗：', list.error?.message); process.exit(1); }

let done = 0, skipped = 0, failed = 0;
for (const t of list.data.tools || []) {
  if (!t.canEdit) continue;
  const authors = emailsOf(t.owner);
  if (!authors.length) { skipped++; console.log('·', '略過（對照表沒有 Email）', t.owner, t.name); continue; }
  const res = await call({ action: 'updateTool', id: t.id, data: { authors } }).catch(e => ({ error: { message: e.message } }));
  if (res.ok) { done++; console.log('✓', t.name, '→', authors.join(', ')); }
  else { failed++; console.log('✗', res.error?.message, t.name); }
}
console.log(`\n更新 ${done} 筆、略過 ${skipped} 筆、失敗 ${failed} 筆`);
process.exit(failed ? 1 : 0);
