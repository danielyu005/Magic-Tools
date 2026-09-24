/**
 * ACD 工具陳列窗 — Apps Script 後端
 *
 * 資料放在綁定的 Google 試算表（工作表：members / tools / updates / submissions / agents / news / feeds），
 * 封面圖放在 Google Drive 的一個資料夾。前端與 Agent 都用 POST 呼叫這個 Web App：
 *
 *   body（Content-Type: text/plain）= JSON {
 *     action: 'list' | 'me' | 'submit' | 'approve' | 'reject' | 'removeTool' | 'setCover' | 'fetchImage'
 *           | 'shareNews' | 'setNews' | 'fetchNews',
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
  agents:      ['name', 'keyHash', 'ownerEmail', 'enabled', 'note', 'createdAt'],
  news:        ['id', 'url', 'title', 'titleZh', 'source', 'topic', 'excerpt', 'excerptZh', 'image', 'publishedAt',
                'kind', 'by', 'note', 'status', 'pinned', 'createdAt'],
  feeds:       ['name', 'url', 'topic', 'mode', 'enabled', 'note']
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

/* 產業趨勢「每週美術技術精選」 */
const NEWS_TOPICS = ['vfx', '3d', 'shader', 'tool', 'spine'];
const NEWS_MAX_AGE_DAYS = 120;     // 抓取時只收這麼新的文章（Spine 教學影片幾個月才一支）
const NEWS_KEEP_DAYS = 180;        // 超過就從試算表清掉（置頂的保留）；要比 NEWS_MAX_AGE_DAYS 長，清掉的才不會又被抓回來
const NEWS_PER_FEED = 12;          // 每個來源每次最多收幾篇
const NEWS_TRANSLATE_MAX = 40;     // 每次抓取最多翻譯幾篇（LanguageApp 有每日額度）
const MAX_NEWS = 150;              // list 回傳的文章上限
// 分類關鍵字，依序比對，先中先贏。標題優先，其次來源自己的分類，最後才看內文（內文只認前三類，避免誤判）
const NEWS_RULES = [
  ['spine',  /esoteric ?software|\bspine ?(2d|pro|tips|editor|runtimes?|4\.\d|animation)|skeletal animation|live2d|dragonbones|骨骼動畫|骨骼动画/i],
  ['vfx',    /\bvfx\b|visual effects?|real-?time ?fx|\bparticles?\b|niagara|shuriken|embergen|effekseer|flipbook|特效|粒子/i],
  ['shader', /shaders?\b|\bhlsl\b|\bglsl\b|\bwgsl\b|material (editor|function)s?|\bnpr\b|\btoon\b|cel[- ]?shad|ray ?trac|path ?trac|global illumination|著色器|渲染管線/i],
  ['tool',   /plug-?ins?\b|add-?ons?\b|\btools?\b|\bscripts?\b|pipeline|workflow|automat|\bbatch\b|photoshop|krita|aseprite|procedural|工具|插件|外掛|自動化/i],
  ['3d',     /blender|\bmaya\b|3ds ?max|zbrush|substance|houdini|sculpt|retopo|modell?ing|photogrammetry|gaussian splat|marvelous designer|\b3d\b|建模|雕刻/i]
];
// setup() 第一次會把這些寫進 feeds 工作表；之後直接在試算表增刪即可。topic 填 auto 表示依關鍵字分類、不相關的不收
const DEFAULT_FEEDS = [
  ['Real-Time VFX 本週熱門', 'https://realtimevfx.com/top.rss?period=weekly', 'vfx', 'rss', '特效社群本週討論度最高的主題'],
  ['Real-Time VFX 資源', 'https://realtimevfx.com/c/resources.rss', 'vfx', 'rss', '教學、工具、素材分享'],
  ['Real-Time VFX 技術', 'https://realtimevfx.com/c/technical.rss', 'vfx', 'rss', ''],
  ['Graphics Programming weekly', 'https://www.jendrikillner.com/tags/weekly/index.xml', 'shader', 'digest', '每週 Shader／渲染文章彙整，會拆成一篇一篇'],
  ['80 Level', 'https://80.lv/feed/', 'auto', 'rss', ''],
  ['Unreal Engine', 'https://www.unrealengine.com/en-US/rss', 'auto', 'rss', ''],
  ['Unity Blog', 'https://blog.unity.com/feed', 'auto', 'rss', ''],
  ['Blender Developers', 'https://code.blender.org/feed/', '3d', 'rss', ''],
  ['BlenderNation', 'https://www.blendernation.com/feed/', 'auto', 'rss', ''],
  ['Game Developer', 'https://www.gamedeveloper.com/rss.xml', 'auto', 'rss', ''],
  ['Spine（Esoteric Software）', 'https://www.youtube.com/feeds/videos.xml?channel_id=UCg95nRAEFyWzjoTRJJpVWKw', 'spine', 'rss', 'Spine 官方教學影片（Spine Tips）']
];

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
  github:     { fn: github_ },
  shareNews:  { fn: shareNews_, agent: true },
  setNews:    { fn: setNews_, admin: true },
  fetchNews:  { fn: () => fetchNews_(), admin: true }
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
    const ttl = Math.min(3600, Math.floor(Number(t.exp) - now)); // 保留到憑證到期；白名單每次都會重新比對
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
  const names = {};
  readTable_('members').forEach(m => { names[norm_(m.email)] = m.name || String(m.email).split('@')[0]; });
  const news = listNews_(who, names);
  if (who.kind === 'agent') return { tools, subs: [], news, me };

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
  return { tools, subs, news, me };
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

/* ============================== 每週美術技術精選 ============================== */

function listNews_(who, names) {
  if (!hasSheet_('news')) return []; // 更新 Code.gs 後還沒跑「初始化」時，其他功能照常
  const admin = who.role === 'admin';
  return readTable_('news')
    .filter(n => admin || n.status !== 'hidden')
    .sort((a, b) => (bool_(b.pinned) - bool_(a.pinned)) || cmp_(b.publishedAt, a.publishedAt))
    .slice(0, MAX_NEWS)
    .map(n => ({
      id: n.id, url: n.url, title: n.title, titleZh: n.titleZh, source: n.source, topic: n.topic,
      excerpt: n.excerpt, excerptZh: n.excerptZh, image: n.image, publishedAt: n.publishedAt,
      kind: String(n.kind || '').split(':')[0], via: String(n.kind || '').startsWith('agent:') ? n.kind.slice(6) : '',
      byName: n.by ? (names[norm_(n.by)] || '成員') : '', note: n.note,
      pinned: bool_(n.pinned), hidden: n.status === 'hidden'
    }));
}

/** 成員或 Agent 分享一篇文章，直接上架（管理者可隱藏）。沒給標題／摘要時由後端讀網頁的 og 資訊補上 */
function shareNews_(req, who) {
  const d = req.data || {};
  const url = str_(d.url, 500);
  if (!/^https?:\/\/\S+$/i.test(url)) throw err_('invalid', '請貼上 http:// 或 https:// 開頭的文章網址');
  let title = str_(d.title, 200), excerpt = str_(d.excerpt, 300), source = str_(d.source, 60);
  let image = /^https:\/\/\S+$/i.test(str_(d.image, 500)) ? str_(d.image, 500) : '';
  const t = Date.parse(d.publishedAt);
  let publishedAt = isNaN(t) ? '' : new Date(t).toISOString();
  if (!title || !excerpt || !image) {
    const m = pageMeta_(url);
    title = title || m.title; excerpt = excerpt || m.excerpt; image = image || m.image;
    source = source || m.source; publishedAt = publishedAt || m.publishedAt;
  }
  if (!title) throw err_('invalid', '讀不到這個網頁的標題，請手動填寫標題');
  const topic = NEWS_TOPICS.includes(d.topic) ? d.topic : (classify_(title) || classify_(excerpt) || 'tool');
  const row = {
    id: newId_('n'), url, title: clip_(title, 200), source: source || hostOf_(url), topic,
    excerpt: clip_(excerpt, 220), image, publishedAt: publishedAt || nowIso_(),
    kind: who.kind === 'agent' ? 'agent:' + who.agent : 'share',
    by: who.email, note: str_(d.note, 200), status: 'show', pinned: 'FALSE', createdAt: nowIso_()
  };
  translateRow_(row);
  return withLock_(() => {
    ensureNewsSheets_();
    const dup = readTable_('news').find(n => urlKey_(n.url) === urlKey_(url));
    if (dup) throw err_('duplicate', dup.status === 'hidden' ? '這篇文章之前被管理者隱藏了' : '這篇文章已經在清單裡了');
    appendRows_('news', [row]);
    return { id: row.id, topic };
  });
}

function setNews_(req) {
  return withLock_(() => {
    const n = readTable_('news').find(x => x.id === req.id);
    if (!n) throw err_('not_found', '找不到這篇文章');
    const patch = {};
    if (req.hidden !== undefined) patch.status = req.hidden ? 'hidden' : 'show';
    if (req.pinned !== undefined) patch.pinned = req.pinned ? 'TRUE' : 'FALSE';
    if (NEWS_TOPICS.includes(req.topic)) patch.topic = req.topic;
    updateRow_('news', n._row, patch);
    return { id: n.id };
  });
}

/** 讀 feeds 工作表的所有來源，把新文章寫進 news。每日觸發器與管理者「立即抓取」都走這裡 */
function fetchNews_() {
  ensureNewsSheets_();
  const feeds = readTable_('feeds').filter(f => norm_(f.enabled) !== 'false' && /^https?:\/\//i.test(f.url));
  const res = feeds.length ? UrlFetchApp.fetchAll(feeds.map(f => ({
    url: f.url, muteHttpExceptions: true, followRedirects: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; acd-tool-shelf news)' }
  }))) : [];
  const cutoff = Date.now() - NEWS_MAX_AGE_DAYS * 864e5;
  const seen = {};
  readTable_('news').forEach(n => { seen[urlKey_(n.url)] = true; });
  const fresh = [], errors = [];
  feeds.forEach((f, i) => {
    let items;
    try {
      const code = res[i].getResponseCode();
      if (code !== 200) throw new Error('HTTP ' + code);
      items = parseFeed_(res[i].getContentText(), f);
    } catch (x) { errors.push(f.name + '：' + (x.message || x)); return; }
    items.filter(it => it.url && it.title && it.time >= cutoff)
      .sort((a, b) => b.time - a.time)
      .slice(0, NEWS_PER_FEED)
      .forEach(it => {
        const k = urlKey_(it.url);
        if (seen[k]) return;
        const topic = NEWS_TOPICS.includes(f.topic) ? f.topic
          : (classify_(it.title) || classify_(it.cats) || classify_(it.text, 3));
        if (!topic) return; // auto 來源：跟五個主題都無關的新聞不收
        seen[k] = true;
        fresh.push({
          id: newId_('n'), url: it.url, title: clip_(it.title, 200), source: it.source || f.name, topic,
          excerpt: clip_(it.text, 220), image: it.image, publishedAt: new Date(it.time).toISOString(),
          kind: 'feed', by: '', note: '', status: 'show', pinned: 'FALSE', createdAt: nowIso_()
        });
      });
  });
  fresh.sort((a, b) => cmp_(b.publishedAt, a.publishedAt)).slice(0, NEWS_TRANSLATE_MAX).forEach(translateRow_);
  const keepAfter = new Date(Date.now() - NEWS_KEEP_DAYS * 864e5).toISOString();
  let added = 0, pruned = 0;
  withLock_(() => {
    const rows = readTable_('news');
    const has = {};
    rows.forEach(n => { has[urlKey_(n.url)] = true; });
    const add = fresh.filter(n => !has[urlKey_(n.url)]);
    const old = rows.filter(n => !bool_(n.pinned) && n.publishedAt && n.publishedAt < keepAfter).map(n => n._row);
    deleteRows_('news', old);
    appendRows_('news', add);
    added = add.length; pruned = old.length;
  });
  return { added, pruned, feeds: feeds.length, errors };
}

/** RSS 2.0 與 Atom 都用正規表示式解析（XmlService 遇到不標準的 feed 容易整個失敗） */
function parseFeed_(xml, feed) {
  const blocks = String(xml).match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  const out = [];
  blocks.forEach((b, i) => {
    const tag = n => { const m = b.match(new RegExp('<' + n + '\\b[^>]*>([\\s\\S]*?)</' + n + '>', 'i')); return m ? cdata_(m[1]) : ''; };
    const attr = (re) => { const m = b.match(re); return m ? decode_(m[1]) : ''; };
    const time = Date.parse(tag('pubDate') || tag('published') || tag('updated') || tag('dc:date')) || Date.now();
    const title = htmlText_(unescapeHtml_(tag('title')));
    const link = decode_(tag('link')).trim()
      || attr(/<link\b(?=[^>]*rel=["']alternate["'])[^>]*href=["']([^"']+)["']/i) || attr(/<link\b[^>]*href=["']([^"']+)["']/i);
    const body = tag('description') || tag('summary') || tag('media:description') || tag('content:encoded') || tag('content');
    const cats = [];
    b.replace(/<category\b([^>]*?)(?:\/>|>([\s\S]*?)<\/category>)/gi, (m, attrs, inner) => {
      cats.push(htmlText_(cdata_(inner || (attrs.match(/term=["']([^"']+)["']/i) || [])[1] || '')));
      return m;
    });
    if (norm_(feed.mode) === 'digest') {
      if (i < 2) out.push.apply(out, parseDigest_(unescapeHtml_(body), title, time, feed)); // 只看最新兩期
      return;
    }
    const image = attr(/<media:thumbnail\b[^>]*url=["']([^"']+)["']/i)
      || attr(/<media:content\b(?=[^>]*medium=["']image["'])[^>]*url=["']([^"']+)["']/i)
      || attr(/<enclosure\b(?=[^>]*type=["']image)[^>]*url=["']([^"']+)["']/i)
      || firstImg_(unescapeHtml_(body + ' ' + tag('content:encoded')));
    out.push({ title, url: link, text: cleanExcerpt_(htmlText_(unescapeHtml_(body))), cats: cats.join(' '), time,
               image: /^https:\/\//i.test(image) ? image : '' });
  });
  return out;
}

/** Graphics Programming weekly 這類「一期很多篇」的彙整：拆成一篇一篇 */
function parseDigest_(html, issueTitle, time, feed) {
  const issue = (issueTitle.match(/Issue\s*(\d+)/i) || [])[1];
  const source = feed.name + (issue ? ' #' + issue : '');
  return html.split(/<div class="post_header">/i).slice(1).map(chunk => {
    const a = chunk.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) return null;
    const body = (chunk.match(/<div class="post_content">([\s\S]*?)<\/div>/i) || [])[1] || '';
    const img = firstImg_(chunk);
    const text = (body.match(/<li[^>]*>[\s\S]*?<\/li>/gi) || [body]).map(htmlText_).filter(Boolean).join('；');
    return { title: htmlText_(a[2]), url: decode_(a[1]), text, cats: '', time, source,
             image: /^https:\/\//i.test(img) ? img : '' };
  }).filter(Boolean);
}

/** 讀文章網頁的 og:title／og:description／og:image（分享時用） */
function pageMeta_(url) {
  const out = { title: '', excerpt: '', image: '', source: '', publishedAt: '' };
  try {
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; acd-tool-shelf news)' } });
    if (res.getResponseCode() !== 200) return out;
    const html = res.getContentText().slice(0, 300000);
    const meta = k => {
      const m = html.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + k + '["\'][^>]*>', 'i'));
      const c = m && m[0].match(/content=["']([^"']*)["']/i);
      return c ? decode_(c[1]).trim() : '';
    };
    out.title = meta('og:title') || meta('twitter:title') || htmlText_((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
    out.excerpt = meta('og:description') || meta('description') || meta('twitter:description');
    const img = meta('og:image') || meta('twitter:image');
    out.image = /^https:\/\//i.test(img) ? img : '';
    out.source = meta('og:site_name');
    const t = Date.parse(meta('article:published_time'));
    if (!isNaN(t)) out.publishedAt = new Date(t).toISOString();
  } catch (x) { console.warn('pageMeta failed', url, x); }
  return out;
}

function classify_(text, onlyFirst) {
  const s = String(text || '');
  if (!s) return '';
  const hit = (onlyFirst ? NEWS_RULES.slice(0, onlyFirst) : NEWS_RULES).find(r => r[1].test(s));
  return hit ? hit[0] : '';
}

/** 用 Apps Script 內建的 Google 翻譯轉成繁中；已經是中文或翻譯失敗就留空，前端改顯示原文 */
function translateRow_(row) {
  const zh = s => {
    if (!s || /[一-鿿]/.test(s)) return '';
    try { return LanguageApp.translate(s, '', 'zh-TW'); } catch (x) { return ''; }
  };
  row.titleZh = zh(row.title);
  row.excerptZh = zh(row.excerpt);
}

/** 建立 news／feeds 工作表；feeds 是空的就放入預設來源 */
function ensureNewsSheets_() {
  const ss = ss_();
  ['news', 'feeds'].forEach(name => {
    if (ss.getSheetByName(name)) return;
    const cols = SHEETS[name], sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@');
  });
  if (!readTable_('feeds').length) {
    appendRows_('feeds', DEFAULT_FEEDS.map(f => ({ name: f[0], url: f[1], topic: f[2], mode: f[3], enabled: 'TRUE', note: f[4] })));
  }
}

function hasSheet_(name) { return !!ss_().getSheetByName(name); }
function cdata_(s) { return String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'); }
function unescapeHtml_(s) { return /&lt;\/?[a-z]/i.test(s) ? decode_(s) : String(s || ''); } // 有些 feed 把 HTML 再跳脫一次
function firstImg_(html) { const m = String(html || '').match(/<img[^>]+src=["']([^"']+)["']/i); return m ? decode_(m[1]) : ''; }
function hostOf_(u) { const m = String(u).match(/^https?:\/\/(?:www\.)?([^\/?#]+)/i); return m ? m[1] : ''; }
function urlKey_(u) {
  return String(u || '').trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/#.*$/, '')
    .replace(/[?&](utm_[^=&]+|ref|source)=[^&]*/g, '').replace(/[?&]$/, '').replace(/\/+$/, '');
}
function htmlText_(s) {
  return decode_(String(s || '').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function cleanExcerpt_(s) {
  return String(s || '')
    .replace(/\b\d+ posts? - \d+ participants?\b/gi, '').replace(/Read full topic/gi, '')
    .replace(/The post .{0,200}? appeared first on .{0,80}?\.\s*$/i, '').replace(/(Continue reading|Read more)\s*[.…»→]*\s*$/i, '')
    .replace(/https?:\/\/\S+/g, '').replace(/\s*\[(…|\.\.\.)\]/g, '…').replace(/\s*Source\s*$/, '')
    .replace(/\s+/g, ' ').trim();
}
function clip_(s, n) {
  s = String(s || '').trim();
  return s.length > n ? s.slice(0, n - 1).replace(/[\s,，。.;；:：、-]+$/, '') + '…' : s;
}
function decode_(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
                  ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', trade: '™', middot: '·', bull: '•' };
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const c = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(c); } catch (x) { return m; }
    }
    const v = named[e.toLowerCase()];
    return v !== undefined ? v : m;
  });
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

// 同一次執行只開一次試算表、只查一次時區（每次呼叫 Spreadsheet 服務都要花時間）
let SS_ = null, TZ_ = '';
function ss_() {
  if (SS_) return SS_;
  const id = prop_('SPREADSHEET_ID');
  return (SS_ = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet());
}
function tz_() { return TZ_ || (TZ_ = ss_().getSpreadsheetTimeZone()); }

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw err_('server', '找不到工作表「' + name + '」，請先在試算表選單執行「初始化」');
  return sh;
}

function readTable_(name) {
  const sh = sheet_(name), cols = SHEETS[name], n = sh.getLastRow() - 1;
  if (n <= 0) return [];
  const tz = tz_();
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
function today_() { return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd'); }
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
    .addSeparator()
    .addItem('最新資訊：立即抓取', 'runFetchNews')
    .addItem('最新資訊：開啟每日自動抓取', 'installNewsTrigger')
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
  ensureNewsSheets_(); // 第一次會放入預設的文章來源，之後可以直接在 feeds 工作表增刪
  const me = norm_(Session.getEffectiveUser().getEmail());
  if (me && !readTable_('members').some(m => norm_(m.email) === me)) {
    appendRows_('members', [{ email: me, name: '', role: 'admin', note: 'setup 自動加入' }]);
  }
  try { SpreadsheetApp.getUi().alert('初始化完成。\n\n下一步：選單「設定 Google Client ID」，然後部署為網頁應用程式。\n產業趨勢的最新資訊：選單「最新資訊：開啟每日自動抓取」。'); } catch (x) {}
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

/** 每日觸發器呼叫（觸發器不能指向結尾是底線的私有函式） */
function cronFetchNews() {
  const r = fetchNews_();
  if (r.errors.length) console.warn('fetchNews errors', r.errors);
  return r;
}

function runFetchNews() {
  const r = fetchNews_();
  SpreadsheetApp.getUi().alert('新增 ' + r.added + ' 篇、清除 ' + r.pruned + ' 篇過期文章（共 ' + r.feeds + ' 個來源）。'
    + (r.errors.length ? '\n\n抓取失敗：\n' + r.errors.join('\n') : ''));
}

/** 每天早上 8 點左右自動抓一次。重複執行只會留下一個觸發器 */
function installNewsTrigger() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'cronFetchNews').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('cronFetchNews').timeBased().everyDays(1).atHour(8).create();
  const r = fetchNews_();
  SpreadsheetApp.getUi().alert('已開啟每日自動抓取（每天 8～9 點）。\n這次先抓了 ' + r.added + ' 篇。'
    + (r.errors.length ? '\n\n抓取失敗：\n' + r.errors.join('\n') : ''));
}
