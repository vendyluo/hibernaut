# 架構筆記

*[English](./NOTES.md)*

核對日期：2026-09-12。本文描述 repository 所鎖定實作的契約。Cloudflare 最新文件可能使用較新的 Agents SDK；例如這裡的 [npm `agents@0.20.1` artifact](https://registry.npmjs.org/agents/-/agents-0.20.1.tgz) 包含 partyserver lifecycle 行為，卻沒有 `lifecycle.start` API。不要假定最新文件中的 API 存在於鎖定版本。此版本有 `runFiber`；模板不假設有 `startFiber`。npm metadata 沒有 `gitHead`，不能把目前 GitHub commit 當作這個版本的精確來源。

## 分層與邊界

| 層 | 職責 |
| --- | --- |
| `src/core/` | state/action 型別、純 `cmd`、directives 與 turn guard 計算 |
| `src/runtime/shell.ts` | Agents SDK 邊界、state 與 scheduled payload 驗證、dispatch、排程、WebSocket、Effect runtime |
| `src/example/chat.ts` | 一個有容量上限的 echo chat 狀態機與一個 Effect-based Action |
| `src/index.ts` | Worker routing、Durable Object class 與 provider layer |
| `src/example/task-agent.ts` | 長任務收據、接受去重、終態、取消意圖與持久補查 |
| `src/example/task-workflow.ts` | Workflows 持久步驟、有限重試、人工確認與終態回寫 |
| `src/core/task.ts` | 工作資料契約與版本化產品策略 |
| `src/runtime/task-http.ts` | 工作提交、查詢、確認與取消的示範 HTTP transport |

`cmd(state, action)` 同步回傳完整的新 state 與出站效果描述；時間與 identifier 都是明確輸入。純 command 路徑不依賴平台，但 `src/core/action.ts` 會 import Effect 來定義及執行 Actions。

需要跨 activation 的 state 由 Cloudflare storage 與 Agents SDK schedule 擁有。Effect timeout 與 retry 只作用於當次 Action 執行。需要 durable task execution 時，應評估平台文件所列選項，而不是延伸記憶體內的 fibers：

- [排程任務](https://developers.cloudflare.com/agents/runtime/execution/schedule-tasks/)
- [Durable execution](https://developers.cloudflare.com/agents/runtime/execution/durable-execution/)
- [執行 Workflows](https://developers.cloudflare.com/agents/runtime/execution/run-workflows/)

## 長任務產品契約 — 2026-10-01

主要範例的工作生命週期為 `submitting → queued/running/waiting → succeeded/failed/cancelled`。`submitting` 是已保留識別與內容、尚未確認接受的內部狀態；HTTP `202` 只在 Workflow 存在且持久 watcher 已建立後回覆。相同 owner/key 對應同一個 Workflow ID，內容不同則拒絕；接受回應遺失時，用原 key 重送，不能換 key 猜測是否成功。

SQLite 收據、SDK interval schedule 與 Workflow 建立不是跨系統交易。先同步保留工作識別，再建立 watcher，最後建立／確認同 ID 的 Workflow。接受前的中斷可能留下未接受收據；有 watcher 的收據會自動補建，沒有 watcher 的收據需重送或查詢原 key，重新建立 watcher 才能繼續。這個窗口不會回覆接受成功。Workflow create 失敗後會查詢同 ID，以區分已建立但回應遺失與仍未確認的結果。

Workflows 保存完成步驟與等待事件；Agent 驅逐或 client 離線不會丟失工作。它不是原 Promise 的續跑，未完成的外部步驟仍可能重新執行。每個 provider 步驟有穩定 idempotency key；provider adapter 要實際使用該 key，或提供查核／補償。範例是可重做的 deterministic echo，不宣稱真實 provider 的 exactly-once 行為。

兩種策略目前都允許最多兩次 durable retry。`transient-only` 只允許 adapter 明確標記可重試的執行失敗；`regenerate` 另外允許 output 驗證失敗後重新生成。Input 驗證失敗不重試。Action 預算為 25 秒，Workflow step 上限為 30 秒，未標記的未知／永久失敗與應用 timeout 不自動重試。平台中斷仍可能重做未完成步驟，這是冪等契約的另一個必要原因。Workflow 不疊加 Action 的 in-handler retry。

可選的人工確認最多等待 24 小時。產品的 `waiting` 由明確的持久進度步驟設定，因為本機 Workflows 在 `waitForEvent` 期間仍可能回報 `running`。不把平台的執行狀態直接當成產品的等待狀態。

Workflow 以持久步驟回寫終態，60 秒 interval watcher 補查回寫遺失、建立中斷與整體 25 小時期限。取消或逾時的停止意圖先保存，再 terminate Workflow；若中斷發生在停止成功與收據結案之間，watcher 仍能區分取消與逾時失敗。完成與停止競爭時，保留已確認的終態，晚到結果不得覆寫。取消不撤銷外部效果。

終態與輸出保留在 Agent SQLite。清理 watcher 失敗不會推翻終態，之後的 watcher 會再清理；每個 key 擁有獨立 watcher，不會因一個工作結案而移除另一個工作的喚醒來源。範例不刪除收據；正式產品需訂保留期限、配額與去重窗口。Workflow 的執行紀錄有平台保留期限，但已保存的收據不依賴它。

這個承諾以 Cloudflare storage、alarms、Workflows 與有效 deployment 持續可用為前提。平台中斷會延後重試與期限處理；60 秒是補查 cadence，不是完成時間 SLA。停止服務、刪除 binding／namespace 或不相容地替換工作版本會破壞承諾。保留 `hibernaut-task-v1`、步驟名稱與已接受工作的政策語意；新契約應新增版本。

目前 task HTTP 範例沒有身分驗證、owner 授權或配額，不能直接公開。這些是產品正式交付前的必要邊界，不由 room 名稱提供隔離保證。Workflows API 與持久步驟契約見 [Workers API](https://developers.cloudflare.com/workflows/build/workers-api/) 與 [sleeping and retrying](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/)。

新收據與 Workflow parameters 會在接受工作時綁定 `contract.workflowVersion` 與 `contract.policyVersion`。沒有這些欄位的舊收據與執行中 v1 payload 固定解析為原本 v1 契約。未知版本會拒絕，不回退到目前預設值。v1 政策 registry 已凍結；修改產品時保留原語意並新增 registry／Workflow 版本。這是明確相容處理，不是自動資料遷移。

## Hibernation 是資格條件，不是計時器

Durable Object 通常必須閒置，且沒有阻止 hibernation 的項目才有資格休眠：不能有 timer、尚在進行且被 await 的 fetch、active event、standard WebSocket 或 outbound socket。Cloudflare 對一般 hibernation eligibility 記載的是 10 秒 idle period。文件中的 70–140 秒指無法 hibernate 的 idle object 被 eviction 的區間，不是週期性喚醒，也不是 SLA。deployment 與 restart 也可能清掉記憶體。

所以所有 in-memory runtime、layer 與 fiber 都只是 cache 或當次 handler 機制，不是 durable state。本機 `wrangler dev` 不會重現 production eviction timing；workers tests 會明確 evict object，以驗證 storage 保留時能否重建。

來源：[Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)。

## Dispatch 與初始化

寫入或執行效果前，shell 先透過 property descriptor 檢查完整候選資料，拒絕 accessor 與自訂陣列 prototype，不執行 getter 或序列化 hook。接著在 schema 的 Type 側驗證完整候選狀態，並驗證整批 directive（含 scheduled payload 與已登記的 instruction target）。驗證不會 decode 或遷移候選資料。無效候選不寫入、不送出任何效果。

失敗會拋出帶有 `stage` 與 `commitStatus` 的 `TurnError`：execution／validation 是 `not-committed`；儲存確認失敗是 `unknown`；directive 執行失敗是 `committed`。儲存錯誤不代表寫入一定失敗，重試前必須查核。效果失敗會停止後續效果，不回滾已提交狀態。既有守衛排程失敗仍透過 `onFail` 回報、執行終結守衛並中止該批效果，不是回滾。Provider 錯誤以 instruction outcome 回到領域狀態機，仍屬於 domain input。

每個 action 都先由 shell 算出並持久化完整新 state，再把 scheduled guard 排到 emission 與 instruction 前面，最後執行 directives。本實作的 state persistence 與 schedule creation **不在同一個 transaction**；這不代表所有平台 storage API 都做不到更廣泛的原子操作。

初始化會驗證 stored state、執行子類別中冪等的 `onWake`，再 reconciliation。它採 single-flight；失敗的 `onWake` 可以於下次嘗試重跑。內部 instruction result 走私有 initialized dispatch 路徑，避免初始化等待自己。Native RPC 或測試可能繞過一般 SDK lifecycle entry，因此必須透過 shell 的公開入口抵達初始化，或自行明確初始化。WebSocket SDK RPC 是另一項 transport 議題。

`onWake` 應有界且可重建，不要在裡面執行慢速 provider 呼叫。初始化中不可呼叫公開的 `dispatch`、`reconcileNow` 或 `runQuery`，否則會等待自己而死鎖。

Action timeout 在 ManagedRuntime 完成 Layer 建立後才開始，不涵蓋 `onWake` 或 Layer acquisition。Echo 使用 `Layer.succeed`；若改成非同步初始化，需另外設定有界的建立／失敗策略。`runQuery` 沒有 scheduled turn guard，無法靠守衛補救卡住的 Layer。

shell 刻意不把通用 `dispatch`、`reconcile` 或 `runQuery` endpoint 公開給不受信任的 client。應用自己的 RPC 必須另做驗證與授權。

## Guarded turn 契約

以下是保留的聊天範例契約；長任務使用上述 Workflows 路徑，不靠聊天的 timeout guard 執行工作。

範例先持久化 `AwaitingModel(requestId, deadlineAt)`，再排 60 秒的 `ModelTimeout`，最後執行 provider instruction。這些是 application policy，不是 Worker limit。Action 在其設定的 in-handler retries 整體上有 25 秒 timeout；這也不是宣稱 Worker 有 30 秒 wall-clock 限制。

模板的 `ScheduleAction` 只適合能安全提早執行、會終結回合的 guard。guard 排程失敗時，shell 會立刻 dispatch 該 guard action，並中止該批其餘 directives；它不是通用 scheduler。

Agents SDK 排程使用 `idempotent: true` 時，會依 callback、serialized payload 與 schedule type 去重；不會更新既有 due time，也不會讓後續 side effect 變成 exactly once。這項敘述只限鎖定版本與測試涵蓋的行為。

若 guard 遺失且 object crash，修復必須等待另一次 activation；沒有 self-wake 保證。既有 guard 可能稍後喚醒 object，但 deadline 是 recovery target，不是 SLA。期限前的 recovery 會確保 guard 存在；到期後才把 state 改回 `Idle` 並 emit error。它不會 resume 或 replay 中斷的 provider call：結果可能遺失，外部 effect 是否發生則未知。

Provider result 帶有 `requestId`。相符的 result 與 timeout 會在同一狀態機中競爭；先被處理者獲勝，後到者被忽略。在 timeout action 真正被處理前，deadline 不會嚴格使 output 失效。

## Delivery 與 concurrency 語意

Durable Object alarm 是 at-least-once。Cloudflare 文件指出，alarm handler 若以 uncaught exception 結束，平台會做 exponential backoff 自動重試：從 2 秒開始，最多 6 次。Agents SDK scheduled callback 有 SDK 自己的 callback/retry policy；本模板不保證永久 delivery。見 [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)。

await point 允許 interleaving，因此明確 busy rejection 是為了避免回合重疊；不是宣稱每個慢 await 都會擋住每個 request。Emission 是 best effort，且沒有 outbox。Provider retry 可能重複執行效果，應使用 provider 支援的 idempotency key，並依需求加入查核／補償；本模板不保證 exactly-once 外部副作用。

Persisted state 與 scheduled payload 會在 activation/callback 時過 schema 驗證。Invalid state 會被 quarantine 而不默默 reset；invalid scheduled payload 會被丟棄並回報。實作限制 input 與 retained history 大小，但沒有通用 schema migration 機制。

這些邊界使用 `Schema.decodeUnknownResult(Schema.toType(schema))`：儲存的值必須已符合 schema 解碼後的 **Type** 側，且能以 JSON 表示。Shell 不會呼叫 schema encoder，也不會在恢復時做轉換。例如 `NumberFromString` 要求儲存數字而非數字字串；`Trim` 會拒絕未裁除空白的 scheduled ID，不會改變其識別值。Action input 是不同的契約：`runAction` 會在執行前明確 decode。需要遷移的 schema 變更，必須另行設計明確的資料遷移流程。

## 安全性與預期用途

`validateStateChange` 拒絕 client 來源的更新，避免 client 透過 state protocol 修改 `cf_agent_state`，同時一般文字訊息仍可使用。此 SDK 版本不可直接改用 readonly connection hook，因為它也會禁止該連線 handler 內的伺服器 state 寫入。這是 hardening，不是 authentication。本範例沒有 authentication、tenant authorization 或 rate limiting；使用同一 room name 的每條連線都會收到該 room 的共用歷史。加入這些控制前，請勿公開範例。

`runQuery` 只是已初始化且會尊重 quarantine 的 query path 慣例；它無法證明 Action 或外部 provider 沒有 side effect。模板也不承諾 supervisor、通用 tool loop、中斷呼叫 replay、outbox delivery 或 exactly-once 行為。

## 驗證與 release

使用 `npm ci`、`npm run typecheck`、`npm test`、分開的 core/workers suites、本機 dev 搭配 `npm run smoke`，以及 `npm run build` 的 Wrangler dry run。已記錄的證據應放在 [RELEASE.md](./RELEASE.md)，而不是在本文保留歷史 test counts 或 bundle measurements。相依套件 attribution 見 [THIRD_PARTY.md](./THIRD_PARTY.md)。
