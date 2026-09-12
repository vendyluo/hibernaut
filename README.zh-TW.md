# hibernaut

一份範圍刻意收窄、能感知 hibernation 的 Cloudflare Durable Object agent GitHub 模板。它是可執行的 echo 範例與可複製的架構，不是 runtime，也不是 npm package。

它處理一種具體失敗：記憶體中的 provider 呼叫消失，持久狀態卻還停在「等待」。Request ID、timeout 守衛與啟動時 reconciliation 恢復的是領域狀態，不是中斷的呼叫；若守衛尚未建立，仍需要另一個事件喚醒。

*[English](./README.md)*

## 內含內容

- `src/example/chat.ts`：有容量上限、request 關聯、持久逾時守衛與醒來時 reconciliation 的聊天狀態機。
- `src/index.ts`：Cloudflare 入口與只做 echo 的 `ModelClient` layer。
- `src/core/`：純狀態轉移與 directive 描述。Action 會 import Effect；`cmd` 本身不依賴平台。
- `src/runtime/`：負責持久化、排程、驗證、WebSocket 與 Action 執行的 Agents SDK shell。
- core 與 workerd 測試，包含明確觸發 Durable Object eviction 的測試。

範例不需要 AI key，也不會建立雲端資源。它只回傳文字，讓 durability 行為保持清楚且可預期。

## 需求與安裝

建議使用 [Node.js 24 LTS](https://nodejs.org/)。模板會把 `agents` 鎖在測試所支援的確切 SDK 版本；升級前請重新檢查測試與當時最新的 Cloudflare 文件。

使用 GitHub 的 **Use this template → Create a new repository**，clone 新 repository 後，在根目錄執行下列命令。授權尚待確認，再散布前請先查看 release preflight。

```bash
npm ci
npm run typecheck
npm test
```

也可以分別執行：

```bash
npm run test:core
npm run test:workers
```

## 本機執行

```bash
npm run dev
```

這會啟動 `wrangler dev --local --ip 127.0.0.1`。另開終端機執行：

```bash
npm run smoke
```

smoke test 會連到唯一 room：

```text
ws://127.0.0.1:8787/agents/chat-agent/<unique-room>
```

它會驗證純文字 echo，也會確認 client 無法寫入 SDK agent state。`validateStateChange` 拒絕 client 來源的寫入，同時允許伺服器狀態轉移；這**不是身分驗證**。根路徑刻意回傳 `404`。

若只想檢查部署 bundle、不實際部署：

```bash
npm run build
```

已記錄的驗證證據與 release preflight 請見 [RELEASE.md](./RELEASE.md)。不要從本 README 推論目前的測試數量或 bundle 限制。

## 改成你的 agent

1. 改寫 `src/example/chat.ts` 的 state、actions 與 `cmd` transition function。
2. 把 `src/index.ts` 的 echo `ModelClient` 換成你的 provider binding。
3. 決策留在 `cmd`、I/O 留在 Actions、平台轉譯留在 shell。
4. 上 production 前補上身分驗證、租戶授權、rate limit、可觀測性與 provider idempotency。
5. 重新命名或新增 agent class 時，加入相應的 Durable Object binding 與 migration。

這個範例會讓同一 room 的所有連線看到共用歷史，且沒有身分驗證或租戶隔離。加入這些控制以前，請勿公開部署。

## 範圍與限制

| 需求 | 優先選擇 |
| --- | --- |
| 明確領域狀態、過期結果守衛、可獨立測試的決策 | 本模板 |
| 一般有狀態聊天、排程或內建聊天 UI 整合 | 直接用 Agents SDK / AIChatAgent |
| agent 內部需要 checkpoint 的中斷工作 | SDK `runFiber` / `stash`，恢復邏輯仍由你定義 |
| 具持久步驟、重試、長時間等待的獨立多步驟任務 | Workflows |
| 無狀態請求處理 | 一般 Worker |

模板只示範一個有守衛的 request/response 回合，不提供通用 supervisor、tool loop、replay engine、outbox、schema migration 系統或 exactly-once effects。`runQuery` 只是模板內的唯讀慣例，無法強迫外部 provider 保持唯讀。

較長的 durable process 應依需求使用專用平台能力，例如 [Agents durable execution](https://developers.cloudflare.com/agents/runtime/execution/durable-execution/) 或 [Cloudflare Workflows](https://developers.cloudflare.com/workflows/)。本實作的詳細契約與失敗語意見 [NOTES.zh-TW.md](./NOTES.zh-TW.md)。

相依套件與 attribution 見 [THIRD_PARTY.md](./THIRD_PARTY.md)。`package.json` 目前保留 ISC metadata，但 repository 沒有 `LICENSE` 檔；不要把本 README 視為開放原始碼授權。

維護範圍是範例、失敗契約、測試與一致的文件，不包含 provider adapter 或下游應用。模板複本不會自動更新；請人工檢視變更、保留自己的 schema migration，並在 SDK 升級前重跑兩套測試。不承諾穩定的套件 API 或支援 SLA。
