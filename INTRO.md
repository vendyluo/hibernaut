# Technical introduction draft — not published

## English

### When the request disappears but the agent is still waiting

A persisted conversation is not the same thing as a recoverable conversation.
An agent can record “waiting for the model,” call a provider, and lose its
in-memory execution before recording the answer. On the next activation, the
conversation history survives—but the Promise does not.

Hibernaut is a small Cloudflare durable-agent **pattern template** for that
failure boundary. It separates a pure state-transition function from Effect
Actions and an Agents SDK shell. The example uses an echo provider so you can
run it locally without an AI account or deployment.

Before calling the provider, the state machine records a request ID and a
deadline. The shell persists that state, arms a scheduled timeout, and only then
executes the instruction. Results and timeouts return through the same state
machine. Once a turn has finished, its duplicate or late messages have no effect
on a newer turn.

Recovery is deliberately modest: after losing execution, an activation checks
the stored deadline. It repairs a missing guard or resolves an expired turn as
a timeout. **It does not resume the provider call.** If the object stops between
writing state and creating its guard, another event is needed to activate it;
stored state alone is not an alarm. If the provider completed but its result was
lost, the template cannot tell whether an external effect happened.

This is not a replacement for the Agents SDK. Use the SDK directly for ordinary
chat and state synchronization, its durable fibers for agent-local checkpoints,
or Workflows for independent jobs with durable steps, retries, and long waits.
Hibernaut is useful when your own domain state machine—and tests for its failure
transitions—is the part you want to make explicit.

The test suite distinguishes pure decisions from local workerd behavior. Forced
eviction checks memory loss and reconstruction; it does not establish production
eviction timing, alarm latency, or availability. The template has no production
platform validation claim and no exactly-once external-effect guarantee. Read
[the contract](./NOTES.md) and [the verification record](./RELEASE.md) before
adapting it.

## 台灣繁體中文

### 請求消失了，agent 卻還在等

對話有持久化，不代表對話就能從中斷恢復。Agent 可以先記下「等待模型」，呼叫
provider，卻在寫回答案之前丟失記憶體內的執行。下一次啟動，歷史還在，Promise
已經不在了。

Hibernaut 是針對這個失敗邊界的 Cloudflare durable-agent **模式模板**。它把純
狀態轉移、Effect Action 與 Agents SDK shell 分開。範例只做 echo，不需要 AI
帳號或部署，就能在本機執行。

呼叫 provider 前，狀態機先記下 request ID 與 deadline；shell 先持久化狀態，
再排入 timeout 守衛，最後執行 instruction。結果與 timeout 都回到同一個
狀態機。回合結束後，該回合的重複或遲到訊息不能改變新回合。

它提供的恢復刻意有限：失去執行後，下一次 activation 檢查持久化 deadline，
補回缺失守衛，或把過期回合結束為 timeout。**它不會續跑原本的 provider 呼叫。**
如果狀態寫入後、守衛建立前就中斷，仍需要另一個事件喚醒；狀態本身不是 alarm。
如果 provider 已經成功、結果卻遺失，模板也無法判斷外部副作用是否已發生。

這不是 Agents SDK 的替代品。一般聊天與狀態同步直接使用官方 SDK；agent 內部
需要 checkpoint，可評估官方 durable fiber；獨立任務需要持久步驟、重試與長等待，
使用 Workflows。Hibernaut 適合的是：你想把自己的領域狀態機，以及失敗轉移的測試，
寫得明確可檢查。

測試分開驗證純決策與本機 workerd 行為。強制驅逐能檢查記憶體丟失後的重建，
不能證明 production 驅逐時間、alarm 延遲或可用性。模板沒有真實平台驗證的宣稱，
也不保證 exactly-once 外部副作用。採用前請閱讀[契約](./NOTES.zh-TW.md)與
[驗證紀錄](./RELEASE.md)。
