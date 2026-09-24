# ACD 工具陳列窗

團隊美術工具的陳列櫃：瀏覽、一鍵開啟、提交新工具與版本更新，由管理者審核上架。

- **前端**：`web/`，純靜態頁，放 GitHub Pages 就能用
- **後端**：`apps-script/Code.gs`，Google Apps Script 網頁應用程式
- **資料**：一份 Google 試算表（成員白名單、工具、更新紀錄、提交、Agent 金鑰）＋ Drive 資料夾（封面圖）
- **登入**：Google 帳號（私人 Gmail 也可以），只有 `members` 白名單內的人能使用
- **費用**：全部在免費額度內

```
瀏覽器（web/）──Google 登入──▶ ID Token
    │  POST（text/plain JSON）
    ▼
Apps Script（Code.gs）── 驗證 Token ＋ 白名單 ── 審核流程 ── 代抓 GitHub 資料／圖片
    ▼
Google 試算表 ＋ Drive
    ▲
Agent／GitHub Action ── API Key ──┘
```

`acd-tool-shelf.html` 是原本放在 claude.ai Artifact 上的舊版，留著當參考；新版在 `web/`。

---

## 部署步驟（約 20 分鐘）

### 1. 建立試算表與後端

1. 開一份新的 Google 試算表，命名例如「ACD 工具陳列窗 資料」。
2. 選單 **擴充功能 → Apps Script**，把 `apps-script/Code.gs` 的內容整份貼上，儲存。
3. （選用）Apps Script 左側 **專案設定** → 勾選「在編輯器中顯示 appsscript.json」，把 `apps-script/appsscript.json` 貼進去。
4. 回到試算表並重新整理，選單列會出現 **工具陳列窗**。點 **工具陳列窗 → 初始化／修復工作表**，依指示授權。
   - 會建立 `members / tools / updates / submissions / agents / news / feeds` 七個工作表
   - 會在你的 Drive 建立「ACD 工具陳列窗 封面」資料夾
   - 會把你自己加進 `members` 並設為 `admin`

### 2. 建立 Google 登入用的 Client ID

1. 到 [Google Cloud Console](https://console.cloud.google.com/)，建立一個專案（免費）。
2. **API 和服務 → OAuth 同意畫面**：使用者類型選「外部」，填好應用程式名稱和聯絡信箱。
   - 發佈狀態是「測試中」時，**只有列在「測試使用者」裡的帳號能登入**。20 人以內可以直接把大家加進去；
     或按「發佈應用程式」改成正式版（只用到 email／個人資料，不需要 Google 審查）。
3. **API 和服務 → 憑證 → 建立憑證 → OAuth 用戶端 ID**，類型選「網頁應用程式」。
   「已授權的 JavaScript 來源」加入：
   - `https://danielyu005.github.io`（正式網址；只填網域，不含 `/Magic-Tools` 路徑）
   - `http://localhost:8000`（本機測試用，可省略）
4. 複製產生的用戶端 ID（`xxxx.apps.googleusercontent.com`），回到試算表點 **工具陳列窗 → 設定 Google Client ID** 貼上。

### 3.（建議）設定 GitHub Token

公司或辦公室的人共用同一個對外 IP，GitHub 未登入查詢**每小時只有 60 次**，實測很容易用完。
前端直接查詢被擋時，會自動改由後端代查，後端需要一個 token 才有每小時 5000 次：

1. GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate，
   Repository access 選「Public repositories」，不用勾任何權限。
2. Apps Script → **專案設定 → 指令碼屬性** → 新增 `GITHUB_TOKEN`，值貼上 token。

### 4. 部署後端

Apps Script 右上角 **部署 → 新增部署作業**：

- 類型：**網頁應用程式**
- 執行身分：**我**
- 具有存取權的使用者：**任何人**（登入由程式自己檢查 Google Token 與白名單；設成「任何人」前端和 Agent 才連得進來）

部署後複製 **網頁應用程式網址**（`https://script.google.com/macros/s/…/exec`）。

> ⚠️ 之後修改 `Code.gs`，要到 **部署 → 管理部署作業 → 編輯（鉛筆）→ 版本選「新版本」→ 部署**，
> 網址不變但才會套用新程式。只按儲存不會生效。

### 5. 部署前端

1. 編輯 `web/config.js`，填入 `API_URL`（上一步的網址）和 `GOOGLE_CLIENT_ID`。兩者都不是機密，可以公開。
2. repo **Settings → Pages → Source** 選「GitHub Actions」（只需設定一次）。之後每次推到 `main` 且 `web/` 有變動，
   [`.github/workflows/pages.yml`](.github/workflows/pages.yml) 會自動發佈到 `https://danielyu005.github.io/Magic-Tools/`。
   也可以在 repo 的 Actions 頁籤手動執行「Deploy web to GitHub Pages」。
3. 本機測試：在 `web/` 資料夾執行 `python -m http.server 8000`，開 `http://localhost:8000`。

### 6. 加入成員

在試算表 `members` 工作表新增一列即可，不用重新部署：

| email | name | role | note |
|---|---|---|---|
| someone@gmail.com | 小明 | member | |
| lead@gmail.com | 組長 | admin | |

- `member`：瀏覽、提交新工具、回報更新、看自己的提交狀態
- `admin`：另外可以審核、退回、下架、換封面
- 要移除某人，刪掉那一列即可，下一次呼叫就會被擋下

---

## 使用方式

- **提交新工具**：右上角「提交工具」。有 GitHub repo 的話，先貼網址再按 **從 GitHub 自動填入**，
  會帶入名稱、開發者、簡介、首頁、標籤、最新 Release 的版本與說明，以及封面圖。空白欄位才會被填，不會蓋掉你已經打的字。
- **回報更新**：打開工具詳情 →「回報更新」。工具有 GitHub repo 時，可以按 **從 GitHub 最新 Release 帶入**。
- **審核**：管理者右上角「審核佇列」，核准或填原因退回。
- 頁面每 60 秒自動同步一次，切回分頁時也會同步。

### 產業趨勢：每週美術技術精選

產業趨勢頁籤最上方會列出 **特效／3D／Shader／美術工具／Spine** 的文章與教學，依「本週／上週／更早」分組，可以按主題篩選。

- **自動收集**：後端每天早上 8 點讀 `feeds` 工作表裡的 RSS 來源（Real-Time VFX、Graphics Programming weekly、80 Level、
  Unreal、Unity、Blender、Spine 官方教學影片等），依關鍵字分類，節錄摘要，並用 Google 翻譯翻成繁中。
  - 第一次使用：試算表選單 **工具陳列窗 → 初始化／修復工作表**（建立 `news`、`feeds` 並放入預設來源），
    再點 **最新資訊：開啟每日自動抓取**（會要求一次新的授權，用來建立排程）。
  - 增刪來源直接改 `feeds` 工作表：`topic` 填 `vfx`／`3d`／`shader`／`tool`／`spine` 表示整個來源都歸這類；
    填 `auto` 表示依關鍵字分類、跟這五類無關的文章不收。`mode` 一般填 `rss`；`digest` 用於一期多篇的週報，會拆成一篇一篇。
    `enabled` 改成 `FALSE` 即停用。
  - 文章抓取時只收 120 天內的，超過 180 天會自動清掉（設為精選的保留）。
- **分享文章**：任何成員按「分享文章」貼網址即可，標題、摘要、縮圖由後端從網頁讀取。分享後直接出現，不經審核。
- **複製本週摘要**：把本週文章整理成 Markdown，方便貼到群組或 Claude。
- **管理者**：可「設為精選」（固定顯示在本週）、「隱藏」（成員看不到，也不會再被抓回來）、「立即抓取」。

---

## 給 Agent 用的 API

### 建立金鑰

試算表選單 **工具陳列窗 → 建立 Agent 金鑰**，輸入 Agent 名稱和擁有者 Email（需在白名單內）。
金鑰**只會顯示一次**，試算表只存雜湊值。要停用就把 `agents` 工作表的 `enabled` 改成 `FALSE`。

Agent 的提交一樣進審核佇列，記在擁有者名下，審核畫面會標示「經由 〇〇」。每把金鑰每小時最多 30 次呼叫。

### 呼叫格式

`POST <API_URL>`，`Content-Type: text/plain`，內容是 JSON（用 text/plain 是為了避開瀏覽器的 CORS 預檢，Apps Script 不支援）。

```jsonc
// 查詢工具清單（拿 toolId 用）
{ "action": "list", "apiKey": "acd_…" }

// 上架新工具
{ "action": "submit", "apiKey": "acd_…", "data": {
    "kind": "new",
    "tab": "rd4",              // rd4 | other | trend
    "category": "setting",     // setting（美術設定）| post（美術後製）
    "name": "PSD 批次輸出",
    "owner": "小明",
    "desc": "把 PSD 圖層批次輸出成 PNG。",
    "clientUrl": "https://…",  // 必填
    "repoUrl": "https://github.com/…",
    "docUrl": "",
    "tags": ["Photoshop", "批次"],
    "version": "v1.0.0",
    "date": "2026-09-23",
    "summary": "首次上架"
}}

// 回報版本更新
{ "action": "submit", "apiKey": "acd_…", "data": {
    "kind": "update", "toolId": "t…", "version": "v1.1.0", "summary": "新增批次重新命名"
}}
```

```jsonc
// 分享一篇文章到「每週美術技術精選」（直接上架，不經審核）
// 例如讓 Claude 排程 Agent 每週搜尋 Spine／特效加速技巧，寫好中文摘要後送進來
{ "action": "shareNews", "apiKey": "acd_…", "data": {
    "url": "https://…",          // 必填
    "topic": "spine",            // vfx | 3d | shader | tool | spine，省略則自動判斷
    "title": "",                 // 省略就從網頁 og:title 讀
    "excerpt": "",               // 摘要，省略就從網頁 og:description 讀；已是中文就不翻譯
    "note": "一句話推薦"
}}
```

回應：`{ "ok": true, "data": { … } }` 或 `{ "ok": false, "error": { "code": "invalid", "message": "…" } }`。

```bash
curl -sL -H 'Content-Type: text/plain' --data '{"action":"list","apiKey":"acd_…"}' "$API_URL"
```

> Apps Script 會回 302 轉址，curl 要加 `-L`。

### GitHub Action：發 Release 自動回報

把 [`examples/report-release.yml`](examples/report-release.yml) 放到工具 repo 的 `.github/workflows/`，
設定 `ACD_API_KEY`（secret）、`ACD_API_URL`、`ACD_TOOL_ID`（variables）即可。

---

## 限制與注意事項

- Apps Script 每次呼叫約 1–3 秒；20 人以內的使用量遠低於免費配額。
- 封面圖存在 Drive，分享設定是「知道連結的人可檢視」。
- 登入憑證（Google ID Token）存在瀏覽器 localStorage，一小時到期，到期前會自動換新。
- 試算表可以直接手動修改資料（例如修錯字）；**不要改第一列的欄位名稱**，也不要調換欄位順序。
- 被退回或被取代的封面圖會自動移到 Drive 垃圾桶。

## 檔案結構

```
apps-script/Code.gs          後端（貼到 Apps Script）
apps-script/appsscript.json  Apps Script 設定（選用）
web/index.html               前端頁面
web/config.js                前端設定：API_URL、GOOGLE_CLIENT_ID
examples/report-release.yml  GitHub Action 範例（放到工具 repo 用）
.github/workflows/pages.yml  本 repo 的 GitHub Pages 自動部署
acd-tool-shelf.html          舊版（claude.ai Artifact）
legacy/*.d.ts                舊版 Artifact 執行環境的型別參考
```
