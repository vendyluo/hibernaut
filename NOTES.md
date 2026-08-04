# Cloudflare Agents + Effect：從 BEAM / Jido 借鑑的架構

這份骨架不是「用 Effect 包一層 Agents SDK」。它是把 Jido 的三層切法
（Action / Agent / AgentServer）原樣搬到 Durable Object 上，因為那個切法
恰好解掉 DO 最難的問題：**hibernation**。

## 對應表

| Jido（Elixir） | 這裡（TypeScript） | 檔案 |
| --- | --- | --- |
| `Jido.Action` | `Action` — Schema 進出、Effect 執行 | `src/core/action.ts` |
| `Jido.Instruction` | `RunInstruction` directive | `src/core/directive.ts` |
| `Jido.Agent` + `cmd/2` | `AgentDef` + 純 `cmd` | `src/core/agent.ts` |
| `Jido.Agent.Directive` | `Directive` | `src/core/directive.ts` |
| `Jido.AgentServer` | `DirectiveAgent extends Agent` | `src/runtime/shell.ts` |
| `Jido.Exec` 的 timeout / retry / backoff | `runAction` 的 `Effect.timeout` / `Effect.retry` | `src/core/action.ts` |
| GenServer `init/1` | `onStart()`（每次醒來都跑） | `src/runtime/shell.ts` |
| `%Directive.Schedule{}` | `ScheduleAction` → `this.schedule()` | `src/runtime/shell.ts` |
| 監督樹、`Jido.Pod` topology | **不搬**。DO 沒有 supervisor | — |

## 四條硬規則

### 1. `cmd` 是純函式，簽章裡不准有 Effect

抄自 `jido/lib/jido/agent.ex` 的不變式：

> - The returned `agent` is **always complete** — no "apply directives" step needed
> - `directives` are **external effects only** — they never modify agent state
> - `cmd/2` is a **pure function**

推論：`cmd` 裡不准有 `Date.now()` / `crypto.randomUUID()`。時間與 id 由邊界取好
傳進來，或用狀態裡的單調 `seq` 導出。

**注意**：狀態變更**不是** directive。`cmd` 回傳的 state 已經是最終狀態。
directive 純粹是出站效果。這比「回傳一串 patch 再套用」更嚴格，也更好測。

### 2. 持久性只有一個擁有者：Cloudflare

> 跨越單次 handler 的東西 → Cloudflare（`setState` / `sql` / `schedule`）
> 單次 handler 內部的東西 → Effect（timeout / retry / Layer / Schema）

`Effect.retry`、`Effect.sleep`、`Effect.fork` 全部活在記憶體裡，DO 大約
70–140 秒沒活動就被驅逐，它們一起消失。Effect 自己的 durable execution
（Effect Cluster、`@effect/workflow`）**不要用** —— 兩套 durability 並存的結果
是兩套都只做對一半。

### 3. 順序：先存狀態，再排守衛，最後才做有風險的呼叫

`dispatch` 的順序：

1. `cmd` 算出完整新狀態 → `setState`（同步寫入）
2. `ScheduleAction`（把逾時守衛變持久）
3. `Emit` / `Fail`
4. `RunInstruction`（可能永遠不回來的那個）
5. `Stop`

守衛必須在風險呼叫**開始之前**就寫進 SQLite。否則 DO 死在呼叫途中，agent
就永遠卡在 `AwaitingModel`。

### 4. 所有回音都要能被安全忽略

`this.schedule()` 是 at-least-once 的。同一個結果可能送達兩次，hibernation
之後也可能收到上一輪的殘留。所以每個回音都帶 `requestId`，`cmd` 比對不上就
直接丟掉 —— 等同 OTP 裡收到過期 monitor ref 的處理方式。

**不要試圖取消逾時守衛。** 讓它照常送達然後被忽略。在 at-least-once 的世界裡，
把訊息設計成可安全忽略，比保證它不送達容易一個數量級。

## 可恢復性從哪來

不是從「把每一步都排進佇列」來的 —— 那樣每步都要多付一次 alarm round-trip 的延遲。

是從**狀態機的設計**來的：狀態裡有 `AwaitingModel(requestId, deadlineAt)`，逾時
守衛在呼叫前就已持久化；若守衛沒寫成功，醒來也能從 deadline 自行補排或逾時。
DO 死在半路仍能把 agent 拉回 `Idle`。這是 BEAM 那套
「用狀態機而不是用重試把事情做對」直接搬過來。

所以 `executeInstruction` 是同步等待，不是排隊。延遲跟可恢復性都拿到。

## 不要從 BEAM 搬過來的東西

- **監督樹。** DO 沒有 supervisor、沒有 restart strategy、沒有 backoff、
  沒有 `max_restarts`。在應用層仿一個只會做出更爛的版本。錯誤恢復靠規則 1–4。
- **調度公平性。** DO 單執行緒且序列化，一次慢呼叫卡住送到同一個 agent 的
  所有請求，沒有 reduction 計數幫你切換。「反正 scheduler 會處理」在這裡是錯的。
  所以範例在忙碌時**明確拒絕**而不是排隊。
- **`:observer` / 熱更新。** 沒有。可觀測性要第一天就設計進去。

## 為什麼 `wrangler dev` 不夠

Cloudflare 文件寫得很直白：本地開發時 hibernatable WebSocket 的事件照常送達，但

> the Durable Object is never evicted from memory

也就是說 **`wrangler dev` 跟 miniflare 永遠不會驅逐 DO**，你在本地看不到任何
hibernation bug。這是最危險的失敗模式 —— 本地全綠，上線後每 70–140 秒被咬一次。

所以平台相關的驗證一律走 `@cloudflare/vitest-pool-workers`（測試跑在真的 workerd
裡），用 `evictDurableObject()` 手動觸發驅逐。它做的正好是真實驅逐做的事：
記憶體沒了，SQLite 還在。

專案分成兩個 vitest project：`core`（純核心，零平台）與 `workers`（真 workerd）。

## 驗證狀態

| 項目 | 結果 |
| --- | --- |
| `npm run typecheck` | 通過 |
| `npm test` | 39/39 通過（core 18、workers 21） |
| Spike 1 — hibernation 存活 | **通過**。驅逐後狀態完整、排程列仍在 SQLite、守衛到期能把 agent 拉回 Idle、ManagedRuntime 重建後完整一輪對話走得完 |
| Spike 2 — 跨 handler 的 fiber | **推翻了原本的假設**，見下 |
| Spike 3 — bundle 體積 | 2892.66 KiB raw / **543.09 KiB gzip**（含完整 Agents SDK + Effect）。離免費方案 3 MiB 壓縮上限還很遠 |
| E2E — Worker 入口 | **通過**。`SELF.fetch()` 發真實 WebSocket upgrade → `onMessage` → 回覆；未知路徑 404 |

`test/chat.test.ts` 沒有 import `agents`、miniflare、wrangler、ManagedRuntime 或
Layer。agent 的全部決策邏輯都能在零平台的情況下測完 —— 這是規則 1 換來的。

## Spike 2 的更正

原本的假設是：fork 出去的 fiber 稍後做 I/O 會噴
`Cannot perform I/O on behalf of a different request`。

**實測不會。** DO 的 `ctx.storage` 綁在物件本身而不是某一次請求，跨 handler
存取是合法的（那個錯誤真正管的是從別次 incoming request 抓來的物件）。

但真正的危險沒有消失，只是換了名字：**fork 出去的工作沒有人等它，DO 可以在它
跑到一半時就被回收，做到一半的事會無聲消失** —— 沒有例外、沒有紀錄、沒有告警。
`test-workers/io-context.test.ts` 第二支測試把這件事釘住了。

結論不變，理由要換：不要用 `Effect.fork` 承載跨 handler 的工作。
不是因為平台會擋，是因為**平台不會擋** —— 它只會安靜地不見。

## 審查後修正（第二輪）

一次外部審查點出四個問題，全部成立，都已修掉。最有價值的是第二個 —— 它打中的是
我原本宣稱已經解決的東西。

### 1. Worker 入口沒接上（CRIT）

`export default { fetch: () => new Response("ok") }` 是佔位，`ChatAgent` 對外根本
不可達。已改用 `routeAgentRequest(request, env)`，並補上 `test-workers/route.test.ts`
從 `SELF.fetch()` 發真實 WebSocket upgrade 的 E2E。

其他 Workers 測試都用 `env.ChatAgent.get(...)` 直接操作 DO，**會繞過整合入口** ——
入口壞掉的時候它們照樣全綠。這條路徑需要它自己的測試。

### 2. `setState` 成功但 `schedule` 失敗 → 永久卡在 `AwaitingModel`

我在 `shell.ts` 原本寫著「先存狀態則最壞情況是效果沒送出，而那是可以被逾時守衛
撿回來的，**因為守衛本身也在狀態裡**」。最後那句是錯的：守衛在
`cf_agents_schedules`，由一次獨立、可獨立失敗的寫入產生。舊的 hibernation 測試只
證明「已成功排入的守衛能跨驅逐存活」，完全沒碰到「守衛根本沒排進去」。

而且這個窗口**在平台層面關不起來**：DO 只提供同步的 `ctx.storage.transactionSync()`，
跨不過 `await`，而 `schedule()` 是 async。所以 reconciliation 不是折衷方案，是唯一解。

修法：

- `AwaitingModel` 從 `{ requestId }` 變成 `{ requestId, deadlineAt }` ——
  **期限進狀態**，修復時只看狀態，不問排程表。
- `AgentDef.reconcile(state, now)`：純函式，回答「要修回一致該做哪個 action」。
  `now` 由 shell 傳入，規則 1 照舊成立。
- `schedule()` 一律帶 `idempotent: true`，補排不會長出重複列。
- 排程失敗就地把該 action 跑掉，並終止這批剩餘 directives：這一輪提早失敗，
  但不會死鎖，也不會在沒有守衛時繼續呼叫模型。

### 3. `AgentDef.state` 宣稱會驗證但從沒被用過

註解寫「在信任邊界驗證」，實作一行都沒有。已在 `initializeOnce()` 實際 decode。

**壞狀態的預設策略是隔離**：原始資料原封不動留在 SQLite，agent 拒絕服務並回報。
不默默重置（會無聲吃掉使用者資料），不照樣執行（`cmd` 可能 throw 或走進沒有匹配
的分支）。這是可以改的產品決策，不是技術結論。

### 4. 輸入與歷史無界成長

`MAX_MESSAGE_CHARS`（4096）與 `MAX_HISTORY_MESSAGES`（40）三處共用：邊界依 UTF-8
byte 擋、`cmd` 裁切、schema 當不變式。模型輸出也一樣裁 —— 否則超長回覆會讓下次
醒來的狀態驗證失敗而被隔離。

### 修這些的過程中發現的另一件事

`onStart()` 是由 partyserver 的 `#ensureInitialized()` 觸發的，而那**只發生在 SDK 的
真實入口**（`fetch` / `alarm` / `webSocketMessage`）。任何繞過那些入口直接呼叫方法的
路徑（RPC、facet、`runInDurableObject`）都不會跑到它。

所以驗證與修復不能只掛在 `onStart()` 上 —— 不變式不該依賴呼叫方走了哪條路進來。
現在它們放在 `initializeOnce()`，由 `onStart()`、`dispatch()` 與公開的
`reconcileNow()` 共同保證。初始化使用共享 Promise 做 single-flight：並行呼叫會等待
同一輪完成，失敗不會被誤記成已完成；真正執行 repair 的私有路徑只接收已驗證狀態。
初始化內部產生的 instruction 結果也必須留在這條私有路徑；若回頭走公開 `dispatch()`，
會等待自己尚未完成的 initialization Promise 而死鎖。

## 順帶觀察

DO 裡實際建出來的表包含 `cf_agents_fibers`、`cf_agents_workflows`、`cf_agents_runs`
—— Agents SDK 自己就帶了一套 durable execution。加上 Effect 那邊的 Effect Cluster
與 `@effect/workflow`，**同一個程序裡有兩套 durable execution 是真實存在的風險**，
不是假想。規則 2 不是潔癖，是必要的。

## 還沒做的

- **還沒真的部署過。** 以上全部在本地 workerd（miniflare）驗證。真實驅逐的
  *時序*（70–140 秒）模擬不了，`runDurableObjectAlarm()` 也是立刻執行而非等待。
  驗到的是「被驅逐之後接不接得上」，不是「幾秒後被驅逐」。
- `ModelClientLive` 是 echo stub，還沒接 Workers AI / AI Gateway。
- `agents` 是 `^0.20.1`，pre-1.0 且 README 明說不收外部 PR、`experimental/` 無穩定性
  保證。務必鎖版本並準備定期跟遷移。
