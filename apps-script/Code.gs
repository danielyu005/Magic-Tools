/**
 * ACD 工具陳列窗 — Apps Script 後端
 *
 * 資料放在綁定的 Google 試算表（工作表：members / tools / updates / submissions / agents），
 * 封面圖放在 Google Drive 的一個資料夾。前端與 Agent 都用 POST 呼叫這個 Web App：
 *
 *   body（Content-Type: text/plain）= JSON {
 *     action: 'list' | 'me' | 'submit' | 'approve' | 'reject' | 'removeTool' | 'setCover' | 'fetchImage',
 *     idToken: '<Google 登入的 ID Token>'   // 人用
 *     apiKey:  '<Agent 金鑰>'               // Agent 用，二擇一
 *     ...各動作的參數
 *   }
 *   回應 = { ok:true, data } 或 { ok:false, error:{ code, message } }
 *
 * 需要的「指令碼屬性」：GOOGLE_CLIENT_ID（必填）、COVER_FOLDER_ID（setup() 會自動建立）。
 */

const SHEETS = {
  members:     ['email', 'name', 'role', 'note'],
  tools:       ['id', 'tab', 'category', 'name', 'owner', 'desc', 'clientUrl', 'repoUrl', 'docUrl', 'tags', 'version',
                'coverFileId', 'coverSeed', 'submitter', 'createdAt', 'updatedAt'],
  updates:     ['toolId', 'date', 'version', 'summary', 'by', 'createdAt'],
  submissions: ['id', 'kind', 'status', 'source', 'toolId', 'toolName', 'tab', 'category', 'name', 'owner', 'desc',
                'clientUrl', 'repoUrl', 'docUrl', 'newClientUrl', 'newDocUrl', 'tags', 'version', 'date', 'summary',
                'coverFileId', 'coverSeed', 'coverTouched', 'submitter', 'createdAt', 'reviewer', 'reviewedAt', 'reviewNote'],
  agents:      ['name', 'keyHash', 'ownerEmail', 'enabled', 'note', 'createdAt']
};
const TABS = ['rd4', 'other', 'trend'];
const CATS = ['setting', 'post'];
const MAX_UPDATES_PER_TOOL = 20;   // list 回傳的每個工具更新紀錄上限
const MAX_SUBS = 300;              // list 回傳的提交上限
const AGENT_HOURLY_LIMIT = 30;     // 每把 Agent 金鑰每小時的呼叫上限
const MAX_COVER_CHARS = 400000;    // 封面 data URI 長度上限（約 300KB）
const IMG_HOSTS = ['opengraph.githubassets.com', 'repository-images.githubusercontent.com', 'raw.githubusercontent.com',
                   'user-images.githubusercontent.com', 'private-user-images.githubusercontent.com',
                   'avatars.githubusercontent.com', 'github.com'];

/* ============================== 入口 ============================== */

function doGet() {
  return json_({ ok: true, service: 'acd-tool-shelf' });
}

function doPost(e) {
  let out;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const action = ACTIONS[req.action];
    if (!action) throw err_('invalid', '未知的動作：' + req.action);
    const who = auth_(req);
    if (!action.agent && who.kind === 'agent') throw err_('forbidden', 'Agent 金鑰不能執行這個動作');
    if (action.admin && who.role !== 'admin') throw err_('forbidden', '需要管理者權限');
    out = { ok: true, data: action.fn(req, who) };
  } catch (x) {
    if (!x || !x.code) console.error(x && x.stack || x);
    out = { ok: false, error: { code: (x && x.code) || 'server', message: String((x && x.message) || x) } };
  }
  return json_(out);
}

const ACTIONS = {
  me:         { fn: (req, who) => ({ email: who.email, name: who.name, role: who.role }), agent: true },
  list:       { fn: list_, agent: true },
  submit:     { fn: submit_, agent: true },
  approve:    { fn: approve_, admin: true },
  reject:     { fn: reject_, admin: true },
  removeTool: { fn: removeTool_, admin: true },
  setCover:   { fn: setCover_, admin: true },
  fetchImage: { fn: fetchImage_ },
  github:     { fn: github_ }
};

/* ============================== 驗證 ============================== */

function auth_(req) {
  if (req.apiKey) return agentAuth_(String(req.apiKey));
  if (!req.idToken) throw err_('auth_required', '請先登入');
  const clientId = prop_('GOOGLE_CLIENT_ID');
  if (!clientId) throw err_('server', '後端尚未設定 GOOGLE_CLIENT_ID');

  const cache = CacheService.getScriptCache();
  const key = 'tok:' + sha_(req.idToken);
  let email = cache.get(key);
  if (!email) {
    const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(req.idToken),
      { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw err_('auth_invalid', '登入已過期，請重新登入');
    const t = JSON.parse(res.getContentText());
    const now = Date.now() / 1000;
    const issOk = t.iss === 'accounts.google.com' || t.iss === 'https://accounts.google.com';
    if (t.aud !== clientId || !issOk || String(t.email_verified) !== 'true' || Number(t.exp) < now)
      throw err_('auth_invalid', '登入憑證無效，請重新登入');
    email = String(t.email).toLowerCase();
    const ttl = Math.min(600, Math.floor(Number(t.exp) - now));
    if (ttl > 30) cache.put(key, email, ttl);
  }
  const m = readTable_('members').find(x => norm_(x.email) === email);
  if (!m) throw err_('not_member', email + ' 還不在白名單，請聯絡管理者加入。');
  return { kind: 'user', email, name: m.name || email.split('@')[0], role: norm_(m.role) === 'admin' ? 'admin' : 'member' };
}

function agentAuth_(key) {
  const hash = sha_(key);
  const a = readTable_('agents').find(x => x.keyHash === hash);
  if (!a || norm_(a.enabled) === 'false') throw err_('auth_invalid', 'API Key 無效或已停用');
  const cache = CacheService.getScriptCache();
  const ck = 'rate:' + hash.slice(0, 16) + ':' + Math.floor(Date.now() / 3600000);
  const n = Number(cache.get(ck) || 0) + 1;
  if (n > AGENT_HOURLY_LIMIT) throw err_('rate_limited', '這把金鑰本小時的呼叫次數已用完');
  cache.put(ck, String(n), 3700);
  // Agent 的提交記在擁有者名下，擁有者在「提交狀態」看得到
  return { kind: 'agent', email: norm_(a.ownerEmail), name: a.name, role: 'agent', agent: a.name };
}

/* ============================== 動作 ============================== */

function list_(req, who) {
  const byTool = {};
  readTable_('updates').forEach(u => {
    (byTool[u.toolId] = byTool[u.toolId] || []).push({ date: u.date, version: u.version, summary: u.summary, createdAt: u.createdAt });
  });
  const tools = readTable_('tools').map(t => ({
    id: t.id, tab: t.tab, category: t.category, name: t.name, owner: t.owner, desc: t.desc,
    clientUrl: t.clientUrl, repoUrl: t.repoUrl, docUrl: t.docUrl, tags: splitTags_(t.tags), version: t.version,
    coverUrl: coverUrl_(t.coverFileId), coverSeed: Number(t.coverSeed) || 0, createdAt: t.createdAt, updatedAt: t.updatedAt,
    updates: (byTool[t.id] || [])
      .sort((a, b) => cmp_(b.date, a.date) || cmp_(b.createdAt, a.createdAt))
      .slice(0, MAX_UPDATES_PER_TOOL)
  }));
  const me = { email: who.email, name: who.name, role: who.role };
  if (who.kind === 'agent') return { tools, subs: [], me };

  const names = {};
  readTable_('members').forEach(m => { names[norm_(m.email)] = m.name || String(m.email).split('@')[0]; });
  const subs = readTable_('submissions')
    .filter(s => who.role === 'admin' || norm_(s.submitter) === who.email)
    .sort((a, b) => cmp_(b.createdAt, a.createdAt))
    .slice(0, MAX_SUBS)
    .map(s => ({
      id: s.id, kind: s.kind, status: s.status, source: s.source, toolId: s.toolId, toolName: s.toolName,
      tab: s.tab, category: s.category, name: s.name, owner: s.owner, desc: s.desc,
      clientUrl: s.clientUrl, repoUrl: s.repoUrl, docUrl: s.docUrl, newClientUrl: s.newClientUrl, newDocUrl: s.newDocUrl,
      tags: splitTags_(s.tags), version: s.version, date: s.date, summary: s.summary,
      coverUrl: coverUrl_(s.coverFileId), coverTouched: bool_(s.coverTouched),
      submitter: who.role === 'admin' ? s.submitter : '', submitterName: names[norm_(s.submitter)] || '成員',
      createdAt: s.createdAt, reviewedAt: s.reviewedAt, reviewNote: s.reviewNote
    }));
  return { tools, subs, me };
}

function submit_(req, who) {
  const d = validate_(req.data || {});
  const coverFileId = d.coverData ? saveCover_(d.coverData, d.name || d.toolName || 'cover') : '';
  try {
    return withLock_(() => {
      if (d.kind === 'update') {
        const tool = readTable_('tools').find(t => t.id === d.toolId);
        if (!tool) throw err_('invalid', '找不到要更新的工具（toolId 錯誤或已下架）');
        d.toolName = tool.name;
      }
      const id = newId_('s');
      appendRows_('submissions', [{
        id, kind: d.kind, status: 'pending', source: who.kind === 'agent' ? 'agent:' + who.agent : 'web',
        toolId: d.toolId, toolName: d.toolName, tab: d.tab, category: d.category, name: d.name, owner: d.owner, desc: d.desc,
        clientUrl: d.clientUrl, repoUrl: d.repoUrl, docUrl: d.docUrl, newClientUrl: d.newClientUrl, newDocUrl: d.newDocUrl,
        tags: d.tags.join(', '), version: d.version, date: d.date, summary: d.summary,
        coverFileId, coverSeed: d.coverSeed, coverTouched: d.coverTouched ? 'TRUE' : 'FALSE',
        submitter: who.email, createdAt: nowIso_()
      }]);
      return { id, status: 'pending' };
    });
  } catch (x) {
    if (coverFileId) trashFile_(coverFileId);
    throw x;
  }
}

function approve_(req, who) {
  let oldCover = '';
  const result = withLock_(() => {
    const sub = pendingSub_(req.id);
    const now = nowIso_();
    let toolId;
    if (sub.kind === 'update') {
      const tool = readTable_('tools').find(t => t.id === sub.toolId);
      if (!tool) throw err_('not_found', '這個工具已下架，無法套用更新');
      const patch = { updatedAt: now };
      if (sub.version) patch.version = sub.version;
      if (sub.newClientUrl) patch.clientUrl = sub.newClientUrl;
      if (sub.newDocUrl) patch.docUrl = sub.newDocUrl;
      if (bool_(sub.coverTouched)) {
        patch.coverSeed = sub.coverSeed;
        patch.coverFileId = sub.coverFileId;
        if (tool.coverFileId && tool.coverFileId !== sub.coverFileId) oldCover = tool.coverFileId;
      } else if (sub.coverFileId) {
        oldCover = sub.coverFileId; // 沒選要換封面卻附了圖，丟掉
      }
      updateRow_('tools', tool._row, patch);
      toolId = tool.id;
    } else {
      toolId = newId_('t');
      appendRows_('tools', [{
        id: toolId, tab: sub.tab, category: sub.category, name: sub.name, owner: sub.owner, desc: sub.desc,
        clientUrl: sub.clientUrl, repoUrl: sub.repoUrl, docUrl: sub.docUrl, tags: sub.tags, version: sub.version,
        coverFileId: sub.coverFileId, coverSeed: sub.coverSeed, submitter: sub.submitter, createdAt: now, updatedAt: now
      }]);
    }
    appendRows_('updates', [{ toolId, date: sub.date || today_(), version: sub.version, summary: sub.summary, by: sub.submitter, createdAt: now }]);
    updateRow_('submissions', sub._row, { status: 'approved', toolId, reviewer: who.email, reviewedAt: now });
    return { toolId };
  });
  if (oldCover) trashFile_(oldCover);
  return result;
}

function reject_(req, who) {
  let cover = '';
  withLock_(() => {
    const sub = pendingSub_(req.id);
    cover = sub.coverFileId;
    updateRow_('submissions', sub._row, {
      status: 'rejected', reviewNote: str_(req.note, 200), reviewer: who.email, reviewedAt: nowIso_(), coverFileId: ''
    });
  });
  if (cover) trashFile_(cover);
  return { id: req.id, status: 'rejected' };
}

function removeTool_(req) {
  let cover = '';
  withLock_(() => {
    const tool = readTable_('tools').find(t => t.id === req.id);
    if (!tool) throw err_('not_found', '找不到這個工具');
    cover = tool.coverFileId;
    deleteRows_('updates', readTable_('updates').filter(u => u.toolId === tool.id).map(u => u._row));
    deleteRows_('tools', [tool._row]);
  });
  if (cover) trashFile_(cover);
  return { id: req.id };
}

function setCover_(req) {
  const data = req.coverData ? checkCover_(req.coverData) : '';
  const fileId = data ? saveCover_(data, 'cover') : '';
  let old = '';
  try {
    withLock_(() => {
      const tool = readTable_('tools').find(t => t.id === req.id);
      if (!tool) throw err_('not_found', '找不到這個工具');
      old = tool.coverFileId;
      const patch = { coverFileId: fileId };
      if (req.coverSeed !== undefined) patch.coverSeed = int_(req.coverSeed);
      updateRow_('tools', tool._row, patch);
    });
  } catch (x) {
    if (fileId) trashFile_(fileId);
    throw x;
  }
  if (old && old !== fileId) trashFile_(old);
  return { coverUrl: coverUrl_(fileId) };
}

/** 代抓 GitHub 上的圖片（瀏覽器直接抓會被 CORS 擋，無法裁切） */
function fetchImage_(req) {
  let host = '';
  const url = String(req.url || '');
  const m = url.match(/^https:\/\/([^\/?#]+)(?:[\/?#]|$)/i);
  if (m) host = m[1].toLowerCase();
  if (!IMG_HOSTS.includes(host)) throw err_('invalid', '只能抓取 GitHub 相關網域的圖片');
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  if (res.getResponseCode() !== 200) throw err_('not_found', '圖片抓取失敗（HTTP ' + res.getResponseCode() + '）');
  const blob = res.getBlob();
  const type = String(blob.getContentType() || '').split(';')[0];
  if (!/^image\/(png|jpeg|webp|gif)$/.test(type)) throw err_('invalid', '不是支援的圖片格式：' + type);
  const bytes = blob.getBytes();
  if (bytes.length > 5 * 1024 * 1024) throw err_('invalid', '圖片超過 5MB');
  return { dataUrl: 'data:' + type + ';base64,' + Utilities.base64Encode(bytes) };
}

/**
 * 代查 GitHub repo 資訊。前端直接查詢時，同一個辦公室 IP 每小時只有 60 次，
 * 很容易用完；後端設定 GITHUB_TOKEN（不需任何權限的 fine-grained token 即可）後有 5000 次。
 */
function github_(req) {
  const gh = String(req.repo || '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(gh)) throw err_('invalid', 'repo 格式應為 owner/name');
  const cache = CacheService.getScriptCache(), ck = 'gh:' + gh.toLowerCase();
  const hit = cache.get(ck);
  if (hit) return JSON.parse(hit);

  const token = prop_('GITHUB_TOKEN');
  const base = { 'User-Agent': 'acd-tool-shelf', Accept: 'application/vnd.github+json' };
  if (token) base.Authorization = 'Bearer ' + token;
  const parse = (res, raw) => {
    const code = res.getResponseCode();
    if (code === 404) return null;
    if (code === 403 || code === 429)
      throw err_('rate', 'GitHub 查詢次數暫時用完' + (token ? '，請稍後再試' : '（請管理者在後端設定 GITHUB_TOKEN）'));
    if (code !== 200) throw err_('github', 'GitHub 回應錯誤（HTTP ' + code + '）');
    return raw ? res.getContentText() : JSON.parse(res.getContentText());
  };

  // 三個查詢同時送出，縮短執行時間（Apps Script 執行太久時，Google 可能改回錯誤頁而不是結果）
  const paths = [['/repos/' + gh, false], ['/repos/' + gh + '/releases/latest', false], ['/repos/' + gh + '/readme', true]];
  const res = UrlFetchApp.fetchAll(paths.map(([p, raw]) => ({
    url: 'https://api.github.com' + p, muteHttpExceptions: true,
    headers: raw ? Object.assign({}, base, { Accept: 'application/vnd.github.raw' }) : base
  })));
  const r = parse(res[0], false);
  if (!r) return { repo: null, release: null, readme: null };
  const rel = parse(res[1], false);
  const readme = parse(res[2], true);
  const out = {
    repo: { name: r.name, html_url: r.html_url, description: r.description, homepage: r.homepage, topics: r.topics || [],
            default_branch: r.default_branch, owner: { login: r.owner && r.owner.login } },
    release: rel && { tag_name: rel.tag_name, name: rel.name, body: String(rel.body || '').slice(0, 6000),
                      published_at: rel.published_at, html_url: rel.html_url },
    readme: readme && readme.slice(0, 20000)
  };
  try { cache.put(ck, JSON.stringify(out), 600); } catch (x) {}
  return out;
}

/* ============================== 驗證輸入 ============================== */

function validate_(d) {
  const kind = d.kind === 'update' ? 'update' : 'new';
  const bad = [];
  const out = {
    kind, toolId: '', toolName: '', tab: '', category: '', name: '', owner: '', desc: '', clientUrl: '', repoUrl: '', docUrl: '',
    newClientUrl: '', newDocUrl: '', tags: [],
    version: str_(d.version, 20),
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(d.date || '')) ? String(d.date) : today_(),
    summary: str_(d.summary, 500),
    coverData: d.coverData ? checkCover_(d.coverData) : '',
    coverSeed: int_(d.coverSeed),
    coverTouched: kind === 'new' ? true : !!d.coverTouched
  };
  const url = (key, required) => {
    const v = str_(d[key], 500);
    if (v && !/^https?:\/\/\S+$/i.test(v)) bad.push(key + ' 需以 http:// 或 https:// 開頭');
    else if (!v && required) bad.push(key + ' 必填');
    return v;
  };
  if (kind === 'new') {
    out.tab = TABS.includes(d.tab) ? d.tab : (bad.push('tab 必須是 ' + TABS.join('/')), '');
    out.category = CATS.includes(d.category) ? d.category : (bad.push('category 必須是 ' + CATS.join('/')), '');
    out.name = str_(d.name, 60) || (bad.push('name 必填'), '');
    out.owner = str_(d.owner, 60) || (bad.push('owner 必填'), '');
    out.desc = str_(d.desc, 300) || (bad.push('desc 必填'), '');
    out.clientUrl = url('clientUrl', true);
    out.repoUrl = url('repoUrl', false);
    out.docUrl = url('docUrl', false);
    const tags = Array.isArray(d.tags) ? d.tags : String(d.tags || '').split(/[,，、]/);
    out.tags = tags.map(s => str_(s, 20)).filter(Boolean).slice(0, 8);
  } else {
    out.toolId = str_(d.toolId, 40) || (bad.push('toolId 必填'), '');
    out.newClientUrl = url('newClientUrl', false);
    out.newDocUrl = url('newDocUrl', false);
  }
  if (!out.summary) bad.push('summary 必填');
  if (bad.length) throw err_('invalid', '欄位有誤：' + bad.join('；'));
  return out;
}

function checkCover_(data) {
  const s = String(data);
  if (s.length > MAX_COVER_CHARS || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(s))
    throw err_('invalid', '封面需為 300KB 以內的 JPEG／PNG／WebP data URI');
  return s;
}

/* ============================== 封面（Drive） ============================== */

function saveCover_(dataUri, label) {
  const m = dataUri.match(/^data:(image\/(jpeg|png|webp));base64,(.+)$/);
  const name = String(label).replace(/[\\\/:*?"<>|]/g, '_').slice(0, 40) + '_' + Date.now() + '.' + (m[2] === 'jpeg' ? 'jpg' : m[2]);
  const file = coverFolder_().createFile(Utilities.newBlob(Utilities.base64Decode(m[3]), m[1], name));
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getId();
}

function coverFolder_() {
  const id = prop_('COVER_FOLDER_ID');
  if (!id) throw err_('server', '尚未建立封面資料夾，請先在試算表選單執行「初始化」');
  return DriveApp.getFolderById(id);
}

function coverUrl_(id) {
  return id ? 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(id) + '&sz=w1280' : '';
}

function trashFile_(id) {
  try { DriveApp.getFileById(id).setTrashed(true); } catch (x) { console.warn('trash failed', id, x); }
}

/* ============================== 試算表存取 ============================== */

function ss_() {
  const id = prop_('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw err_('server', '找不到工作表「' + name + '」，請先在試算表選單執行「初始化」');
  return sh;
}

function readTable_(name) {
  const sh = sheet_(name), cols = SHEETS[name], n = sh.getLastRow() - 1;
  if (n <= 0) return [];
  const tz = ss_().getSpreadsheetTimeZone();
  return sh.getRange(2, 1, n, cols.length).getValues()
    .map((r, i) => {
      const o = { _row: i + 2 };
      cols.forEach((c, j) => { o[c] = fromCell_(r[j], tz); });
      return o;
    })
    .filter(o => cols.some(c => o[c] !== ''));
}

function appendRows_(name, objs) {
  if (!objs.length) return;
  const sh = sheet_(name), cols = SHEETS[name];
  sh.getRange(sh.getLastRow() + 1, 1, objs.length, cols.length)
    .setNumberFormat('@')
    .setValues(objs.map(o => cols.map(c => toCell_(o[c]))));
}

function updateRow_(name, row, patch) {
  const sh = sheet_(name), cols = SHEETS[name];
  const range = sh.getRange(row, 1, 1, cols.length);
  const vals = range.getValues()[0];
  cols.forEach((c, j) => { if (c in patch) vals[j] = toCell_(patch[c]); });
  range.setNumberFormat('@').setValues([vals]);
}

function deleteRows_(name, rows) {
  const sh = sheet_(name);
  rows.slice().sort((a, b) => b - a).forEach(r => sh.deleteRow(r));
}

function fromCell_(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, "yyyy-MM-dd'T'HH:mm:ssXXX");
  if (v === null || v === undefined) return '';
  return String(v);
}

function toCell_(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s; // 防止使用者輸入被當成公式
  return s;
}

/* ============================== 小工具 ============================== */

function pendingSub_(id) {
  const sub = readTable_('submissions').find(s => s.id === id);
  if (!sub) throw err_('not_found', '找不到這筆提交');
  if (sub.status !== 'pending') throw err_('already_reviewed', '這筆提交已經處理過了');
  return sub;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw err_('busy', '系統忙碌中，請稍後再試');
  try { return fn(); } finally { lock.releaseLock(); }
}

function err_(code, message) { const e = new Error(message); e.code = code; return e; }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k) || ''; }
function norm_(s) { return String(s || '').trim().toLowerCase(); }
function str_(v, max) { return String(v === null || v === undefined ? '' : v).trim().slice(0, max); }
function int_(v) { const n = Math.floor(Number(v)); return isFinite(n) && n >= 0 ? Math.min(n, 1e6) : 0; }
function bool_(v) { return v === true || norm_(v) === 'true'; }
function cmp_(a, b) { return String(a || '').localeCompare(String(b || '')); }
function splitTags_(s) { return String(s || '').split(/[,，、]/).map(x => x.trim()).filter(Boolean); }
function nowIso_() { return new Date().toISOString(); }
function today_() { return Utilities.formatDate(new Date(), ss_().getSpreadsheetTimeZone(), 'yyyy-MM-dd'); }
function newId_(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function sha_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

/* ============================== 管理選單（在試算表裡使用） ============================== */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('工具陳列窗')
    .addItem('初始化／修復工作表', 'setup')
    .addItem('設定 Google Client ID', 'promptClientId')
    .addSeparator()
    .addItem('建立 Agent 金鑰', 'promptAgentKey')
    .addToUi();
}

/** 建立工作表與封面資料夾，並把自己加成管理者。重複執行不會清掉資料。 */
function setup() {
  const ss = ss_();
  Object.keys(SHEETS).forEach(name => {
    const cols = SHEETS[name];
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@');
  });
  ss.getSheets().forEach(sh => {
    if (!SHEETS[sh.getName()] && sh.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sh);
  });
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('COVER_FOLDER_ID')) {
    props.setProperty('COVER_FOLDER_ID', DriveApp.createFolder('ACD 工具陳列窗 封面').getId());
  }
  const me = norm_(Session.getEffectiveUser().getEmail());
  if (me && !readTable_('members').some(m => norm_(m.email) === me)) {
    appendRows_('members', [{ email: me, name: '', role: 'admin', note: 'setup 自動加入' }]);
  }
  try { SpreadsheetApp.getUi().alert('初始化完成。\n\n下一步：選單「設定 Google Client ID」，然後部署為網頁應用程式。'); } catch (x) {}
}

function promptClientId() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('設定 Google Client ID', '貼上 Google Cloud 的 OAuth 用戶端 ID（xxx.apps.googleusercontent.com）', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const v = r.getResponseText().trim();
  if (!/\.apps\.googleusercontent\.com$/.test(v)) { ui.alert('格式不對，應該以 .apps.googleusercontent.com 結尾'); return; }
  PropertiesService.getScriptProperties().setProperty('GOOGLE_CLIENT_ID', v);
  ui.alert('已儲存。');
}

/** 產生一把 Agent 金鑰。金鑰只會顯示這一次，試算表只存雜湊值。 */
function promptAgentKey() {
  const ui = SpreadsheetApp.getUi();
  const r1 = ui.prompt('建立 Agent 金鑰 (1/2)', 'Agent 名稱（例如：GitHub Action - PSD 批次工具）', ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK || !r1.getResponseText().trim()) return;
  const r2 = ui.prompt('建立 Agent 金鑰 (2/2)', '擁有者的 Email（Agent 的提交會記在這個人名下，需在白名單內）', ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK) return;
  const owner = norm_(r2.getResponseText());
  if (!readTable_('members').some(m => norm_(m.email) === owner)) { ui.alert(owner + ' 不在 members 白名單內'); return; }
  const key = 'acd_' + Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  appendRows_('agents', [{ name: str_(r1.getResponseText(), 60), keyHash: sha_(key), ownerEmail: owner, enabled: 'TRUE', note: '', createdAt: nowIso_() }]);
  ui.alert('金鑰已建立（只會顯示這一次，請立刻複製保存）：\n\n' + key + '\n\n要停用時，把 agents 工作表的 enabled 改成 FALSE。');
}
