# hibernaut

一份以持久長任務為主的 Cloudflare agent GitHub 模板。Agent 接受工作與保存收據，Workflows 執行持久步驟、重試與等待；工作不依賴聊天連線或 Agent 實例持續存活。它是可執行的範例與可複製的架構，不是 npm package。

主要契約是：回覆接受成功後，持續追蹤到成功、失敗或取消，並保存可重新查詢的終態。重試與恢復必須符合產品政策；這不保證外部副作用 exactly once。原本的 guarded chat 保留為另一種產品契約：中斷後恢復領域狀態，不續跑 provider 呼叫。

*[English](./README.md)*

## 內含內容

- `src/example/task-agent.ts`：持久工作收據、相同 key 去重、狀態查詢、確認、取消與 alarm 補查。
- `src/example/task-workflow.ts`：持久步驟、可跨重啟的人工確認等待與終態回寫。
- `src/core/task.ts`：工作契約與可替換的 `transient-only`／`regenerate` 產品策略。
- `src/example/chat.ts`：有容量上限、request 關聯、持久逾時守衛與醒來時 reconciliation 的聊天狀態機。
- `src/index.ts`：Cloudflare 入口與只做 echo 的 `ModelClient` layer。
- `src/core/`：純狀態轉移與 directive 描述。Action 會 import Effect；`cmd` 本身不依賴平台。
- `src/runtime/`：負責持久化、排程、驗證、WebSocket 與 Action 執行的 Agents SDK shell。
- core 與 workerd 測試，包含明確觸發 Durable Object eviction 的測試。

範例不需要 AI key，也不會建立雲端資源。它只回傳文字，讓 durability 行為保持清楚且可預期。

## 需求與安裝

建議使用 [Node.js 24 LTS](https://nodejs.org/)（24.11 以上）。模板會把 `agents` 鎖在測試所支援的確切 SDK 版本；升級前請重新檢查測試與當時最新的 Cloudflare 文件。

使用 GitHub 的 **Use this template → Create a new repository**，clone 新 repository 後，在根目錄執行下列命令。授權尚待確認，再散布前請先查看 release preflight。

```bash
npm ci
npm run typecheck
npm test
```

工具鏈鎖定 Vite+ 1.0.0 與 Effect 4.0.0。核心測試使用 Vite+ 內建的
Vitest 5.0.1；`test-workers` npm workspace 保留 Vitest 4.1.11，因為鎖定的
Cloudflare pool 只支援 Vitest 4.1。根目錄的 `npm ci` 會安裝兩套 runner，
`npm test` 會執行兩套測試。請保留 runner 的依賴隔離，勿加入全域 Vitest override。
Workers workspace 也固定 Vitest 4 的 optional UI／browser-preview peers，避免
npm 將它們解析到 v5；這些套件不會啟用 UI 或瀏覽器測試。
`npm run check` 執行 Vite+ 格式與 lint 檢查；`npm run typecheck` 檢查程式與
兩套測試。Worker 開發與打包仍使用 Wrangler（`npm run dev`／`npm run build`）。

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
npm run smoke:tasks
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

## 長任務與產品策略

```bash
curl -X PUT http://127.0.0.1:8787/tasks/demo/jobs/report-1 \
  -H 'content-type: application/json' \
  -d '{"text":"準備報告","policy":"transient-only","requireApproval":true}'
curl http://127.0.0.1:8787/tasks/demo/jobs/report-1
curl -X POST http://127.0.0.1:8787/tasks/demo/jobs/report-1/approve
```

新工作只在確認 Workflow 存在且持久補查已建立後回覆 `202`；已結案的相同工作則回傳保存的終態收據。相同 owner/key 與相同內容回到同一個工作；換內容重用 key 回 `409`。逾時或 `503` 代表接受結果未確認，請使用原 key 重送。`DELETE` 同一路徑要求取消；成功、失敗、取消都是不可逆的終態。完成與取消同時發生時，以已確認並保存的終態為準；取消不會撤銷已發生的外部效果。

`transient-only` 只重試 provider adapter 明確標記 `retryable: true` 的執行失敗。`regenerate` 另外允許輸出驗證失敗後重新生成；它適合可重做的內容生成，不應直接套在付款或寄信。範例兩者最多重試兩次，每次 Action 有 25 秒預算，Workflow 步驟有 30 秒上限；人工確認最多等 24 小時，整個工作期限為 25 小時，由 60 秒持久補查協助結案。平台服務中斷會延後進度，這些期限不是 SLA。

修改產品時，改寫版本化的工作與策略，以及 `composeTask` provider adapter。每個步驟有穩定的 provider idempotency key；adapter 必須實際使用它，並針對未知副作用結果設計查核／補償。已完成的步驟由 Workflows 保存，未完成的步驟仍可能重做。終態副本保留在 Agent SQLite，不依賴 Workflow 執行紀錄的保留期限；範例未提供收據清理，正式產品需自訂保留與去重期限。新增版本時保留舊 Workflow 與步驟契約，勿直接改寫仍在執行的工作。

要驗證整個本機服務重啟，先執行 `npm run smoke:tasks -- accept`，停止並重新啟動使用同一 `--persist-to` 的 dev，再執行 `npm run smoke:tasks -- resume`。此測試只連 localhost。

## 改寫保留的聊天範例

1. 改寫 `src/example/chat.ts` 的 state、actions 與 `cmd` transition function。
2. 把 `src/index.ts` 的 echo `ModelClient` 換成你的 provider binding。
3. 決策留在 `cmd`、I/O 留在 Actions、平台轉譯留在 shell。
4. 上 production 前補上身分驗證、租戶授權、rate limit、可觀測性與 provider idempotency。
5. 重新命名或新增 agent class 時，加入相應的 Durable Object binding 與 migration。

這個範例會讓同一 room 的所有連線看到共用歷史，且沒有身分驗證或租戶隔離。加入這些控制以前，請勿公開部署。

## 範圍與限制

| 需求 | 優先選擇 |
| --- | --- |
| 接受長任務後追蹤到終態、人工確認與可替換策略 | 本模板的 TaskAgent + Workflows |
| 明確領域狀態、過期結果守衛、可獨立測試的決策 | 本模板 |
| 一般有狀態聊天、排程或內建聊天 UI 整合 | 直接用 Agents SDK / AIChatAgent |
| agent 內部需要 checkpoint 的中斷工作 | SDK `runFiber` / `stash`，恢復邏輯仍由你定義 |
| 具持久步驟、重試、長時間等待的獨立多步驟任務 | Workflows |
| 無狀態請求處理 | 一般 Worker |

模板示範持久長任務與有守衛的 request/response 回合，不提供通用 supervisor、tool loop、跨系統 outbox、schema migration 系統或 exactly-once effects。`runQuery` 只是聊天範例內的唯讀慣例，無法強迫外部 provider 保持唯讀。新的 task HTTP 路由同樣沒有身分驗證或 owner 授權；正式開放前必須補上這些控制與配額。

較長的 durable process 應依需求使用專用平台能力，例如 [Agents durable execution](https://developers.cloudflare.com/agents/runtime/execution/durable-execution/) 或 [Cloudflare Workflows](https://developers.cloudflare.com/workflows/)。本實作的詳細契約與失敗語意見 [NOTES.zh-TW.md](./NOTES.zh-TW.md)。

相依套件與 attribution 見 [THIRD_PARTY.md](./THIRD_PARTY.md)。`package.json` 目前保留 ISC metadata，但 repository 沒有 `LICENSE` 檔；不要把本 README 視為開放原始碼授權。

維護範圍是範例、失敗契約、測試與一致的文件，不包含 provider adapter 或下游應用。模板複本不會自動更新；請人工檢視變更、保留自己的 schema migration，並在 SDK 升級前重跑兩套測試。不承諾穩定的套件 API 或支援 SLA。
