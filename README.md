# cfa — Cloudflare Durable Agent 模式模板

這不是通用 starter，是**模式模板**：一套在 Cloudflare Durable Objects 上寫
「長壽命、有狀態、跨 hibernation 可恢復」agent 的不變式，附帶可跑的參考實作
與測試骨架。核心思路借自 BEAM/OTP（經由 [Jido](https://github.com/agentjido/jido)
的三層切法），落地在 Agents SDK + Effect 上。

架構的完整論述、四條硬規則、每一條的實測依據，都在 **[NOTES.md](./NOTES.md)** ——
那份文件是這個 repo 真正的資產，程式碼只是它的可執行版本。

## 什麼案子該用 / 不該用

**適用**（甜蜜點很窄但很深）：

- 長壽命、事件驅動的 agent：一趟旅程、一場對話、一個訂單的生命週期
- 需要跨 hibernation / 部署恢復的多步驟流程（tool-calling 迴圈、逾時守衛、排程喚醒）
- 決策邏輯需要零平台可測（純函式 `cmd`，不用 miniflare 就能測完）

**不適用**（別套，紀律是白付的成本）：

- 無狀態 Worker（純 API、代理、轉換）—— 用平台原生寫法
- 標準聊天應用且 SDK 的 `AIChatAgent` + `useAgentChat` 夠用 —— 走 SDK 內建路線
- 長時背景批次管線 —— 用 [Workflows](https://developers.cloudflare.com/workflows/)，不是這個

## 三層切法

```
core/      純函式層。Action / AgentDef / Directive / turn —— 零平台、零 Effect runtime，
           agent 的全部決策邏輯在這裡，snapshot test 就能測完。
runtime/   shell。唯一碰 Agents SDK 的檔案（DirectiveAgent）：dispatch 順序、
           排程守衛、狀態驗證與隔離、reconcile、runQuery、文字輸入邊界。
example/   chat.ts 是活規格 —— 剛好展示完所有規則，一行不多。新 agent 從抄它開始。
```

規則的最短版（完整版與依據見 NOTES.md）：

1. `cmd` 是純函式 —— 時間與亂數是輸入，不是環境
2. 持久性只有一個擁有者：Cloudflare（`setState` / `schedule`）；Effect 只管單次 handler 內部
3. 先存狀態、再排守衛、最後才做有風險的呼叫；期限寫進狀態本身，醒來靠 `reconcile` 自我修復
4. 所有回音都要能被安全忽略（requestId 關聯，過期就丟）

## 用法

這個 repo 是 GitHub template：`Use this template` 開新專案（或 `degit vendyluo/cfa`），
然後：

```bash
npm install
npm test          # core（零平台）+ workers（真 workerd，可手動觸發驅逐）
npm run typecheck
npm run dev
```

新 agent 的起手式：抄 `example/chat.ts` 改狀態機，在 `index.ts` 掛上
`DirectiveAgent` 子類，`wrangler.jsonc` 加 DO binding 與 `new_sqlite_classes`
migration。決策邏輯全部放 `cmd`，I/O 全部放 Action，shell 不准長業務。

## 維護紀律

- **每個應用收尾時問一次「有什麼該回流 template」。** 這個 repo 靠應用經驗
  迭代；template 模式的固有缺點（clone 漂移）用回流慣例對沖。等第三個消費者
  出現且 core 穩定不動，再考慮抽成 package —— 不要提前。
- **抗拒把它養肥。** 想加東西先問「這是不變式還是業務？」業務留在應用 repo。
- **`agents` 是 pre-1.0，版本要鎖。** shell 是唯一碰 SDK 的檔案，SDK 升版只准
  改它；reconcile 依賴的 SDK 行為（如 `schedule` 的 `idempotent` 語意）由
  workers 測試釘住 —— SDK 偷改行為時是測試叫，不是線上叫。
