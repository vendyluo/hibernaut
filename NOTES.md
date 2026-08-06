# Cloudflare Agents + Effect: an architecture borrowed from BEAM / Jido

*[繁體中文](./NOTES.zh-TW.md)*

This skeleton is not "Effect wrapped around the Agents SDK". It is Jido's
three-layer split (Action / Agent / AgentServer) transplanted onto Durable
Objects as-is, because that split happens to solve the hardest problem DOs
have: **hibernation**.

## Correspondence table

| Jido (Elixir) | Here (TypeScript) | File |
| --- | --- | --- |
| `Jido.Action` | `Action` — schema in/out, Effect execution | `src/core/action.ts` |
| `Jido.Instruction` | `RunInstruction` directive | `src/core/directive.ts` |
| `Jido.Agent` + `cmd/2` | `AgentDef` + pure `cmd` | `src/core/agent.ts` |
| `Jido.Agent.Directive` | `Directive` | `src/core/directive.ts` |
| `Jido.AgentServer` | `DirectiveAgent extends Agent` | `src/runtime/shell.ts` |
| `Jido.Exec` timeout / retry / backoff | `runAction`'s `Effect.timeout` / `Effect.retry` | `src/core/action.ts` |
| GenServer `init/1` | `onStart()` (runs on every wake) | `src/runtime/shell.ts` |
| `%Directive.Schedule{}` | `ScheduleAction` → `this.schedule()` | `src/runtime/shell.ts` |
| Supervision trees, `Jido.Pod` topology | **Not ported.** DOs have no supervisor | — |

## The four hard rules

### 1. `cmd` is a pure function — no Effect in its signature

Copied from the invariants in `jido/lib/jido/agent.ex`:

> - The returned `agent` is **always complete** — no "apply directives" step needed
> - `directives` are **external effects only** — they never modify agent state
> - `cmd/2` is a **pure function**

Corollary: no `Date.now()` / `crypto.randomUUID()` inside `cmd`. Time and ids
are captured at the boundary and passed in, or derived from the monotonic
`seq` in state.

**Note**: a state change is **not** a directive. The state `cmd` returns is
already final. Directives are purely outbound effects. This is stricter than
"return a list of patches and apply them" — and easier to test.

### 2. Durability has exactly one owner: Cloudflare

> Anything that crosses a single handler → Cloudflare (`setState` / `sql` / `schedule`)
> Anything inside a single handler → Effect (timeout / retry / Layer / Schema)

`Effect.retry`, `Effect.sleep`, `Effect.fork` all live in memory. A DO gets
evicted after roughly 70–140 seconds of inactivity, and they vanish with it.
Effect's own durable execution (Effect Cluster, `@effect/workflow`) —
**do not use it**. Two coexisting durability systems end up each doing only
half the job right.

### 3. Ordering: persist state, arm the guard, then make the risky call

`dispatch` order:

1. `cmd` computes the complete new state → `setState` (synchronous write)
2. `ScheduleAction` (make the timeout guard durable)
3. `Emit` / `Fail`
4. `RunInstruction` (the one that may never come back)
5. `Stop`

The guard must be in SQLite **before** the risky call starts. Otherwise the
DO dies mid-call and the agent is stuck in `AwaitingModel` forever.

### 4. Every echo must be safe to ignore

`this.schedule()` is at-least-once. The same result can be delivered twice,
and after hibernation you can receive leftovers from a previous round. So
every echo carries a `requestId`, and `cmd` drops anything that doesn't
match — the same way OTP handles a stale monitor ref.

**Do not try to cancel the timeout guard.** Let it arrive and be ignored.
In an at-least-once world, designing messages to be safely ignorable is an
order of magnitude easier than guaranteeing non-delivery.

## Where recoverability comes from

Not from "queueing every step" — that costs an extra alarm round-trip of
latency per step.

It comes from **the design of the state machine**: state carries
`AwaitingModel(requestId, deadlineAt)`, and the timeout guard is persisted
before the call. Even if the guard write failed, waking up can re-arm or
time out from the deadline alone. A DO dying mid-flight still gets pulled
back to `Idle`. This is BEAM's "get it right with a state machine, not with
retries", ported directly.

That is why `executeInstruction` awaits synchronously instead of queueing.
You get the latency *and* the recoverability.

## Things NOT to port from BEAM

- **Supervision trees.** DOs have no supervisor, no restart strategy, no
  backoff, no `max_restarts`. Imitating one at the application layer only
  produces a worse version. Error recovery comes from rules 1–4.
- **Scheduling fairness.** A DO is single-threaded and serialized; one slow
  call blocks every request to that agent, and there is no reduction
  counting to preempt it. "The scheduler will handle it" is wrong here —
  which is why the example **explicitly rejects** while busy instead of
  queueing.
- **`:observer` / hot code upgrades.** Don't exist. Design observability in
  on day one.

## Why `wrangler dev` is not enough

Cloudflare's docs are blunt: in local development, hibernatable WebSocket
events are delivered normally, but

> the Durable Object is never evicted from memory

Meaning **`wrangler dev` and miniflare never evict a DO** — you will not see
a single hibernation bug locally. This is the most dangerous failure mode:
all green locally, bitten every 70–140 seconds in production.

So all platform-related verification goes through
`@cloudflare/vitest-pool-workers` (tests run in real workerd), using
`evictDurableObject()` to trigger eviction manually. It does exactly what a
real eviction does: memory is gone, SQLite remains.

The project is split into two vitest projects: `core` (pure core, zero
platform) and `workers` (real workerd).

## Verification status

| Item | Result |
| --- | --- |
| `npm run typecheck` | Pass |
| `npm test` | 46/46 pass (core 25, workers 21) |
| Spike 1 — hibernation survival | **Pass.** State intact after eviction, schedule rows still in SQLite, an expiring guard pulls the agent back to Idle, and a full conversation round completes after ManagedRuntime is rebuilt |
| Spike 2 — cross-handler fibers | **Overturned the original assumption**, see below |
| Spike 3 — bundle size | 2892.66 KiB raw / **543.09 KiB gzip** (full Agents SDK + Effect included). Far from the free plan's 3 MiB compressed limit |
| E2E — Worker entry | **Pass.** `SELF.fetch()` performs a real WebSocket upgrade → `onMessage` → reply; unknown paths 404 |

`test/chat.test.ts` imports neither `agents`, miniflare, wrangler,
ManagedRuntime nor Layer. The agent's entire decision logic is testable with
zero platform — that is what rule 1 buys.

## Correction to Spike 2

The original assumption: a forked fiber doing I/O later would throw
`Cannot perform I/O on behalf of a different request`.

**Measured: it does not.** A DO's `ctx.storage` is bound to the object
itself, not to a particular request; cross-handler access is legal (that
error actually polices objects captured from a *different incoming
request*).

But the real danger didn't disappear — it changed names: **nobody awaits a
forked fiber, the DO can be reclaimed while it is mid-flight, and
half-finished work vanishes silently** — no exception, no log, no alert.
The second test in `test-workers/io-context.test.ts` pins this down.

Same conclusion, different reason: don't carry cross-handler work on
`Effect.fork`. Not because the platform stops you — because **it doesn't**.
It just quietly disappears.

## Post-review fixes (round two)

An external review raised four issues. All valid, all fixed. The most
valuable was the second — it hit something I had claimed was already solved.

### 1. The Worker entry was never wired up (CRIT)

`export default { fetch: () => new Response("ok") }` was a placeholder;
`ChatAgent` was unreachable from the outside. Switched to
`routeAgentRequest(request, env)` and added `test-workers/route.test.ts` —
an E2E that performs a real WebSocket upgrade via `SELF.fetch()`.

The other Workers tests all drive the DO directly via
`env.ChatAgent.get(...)`, which **bypasses the integration entry** — they
stay green even when the entry is broken. That path needs its own test.

### 2. `setState` succeeds but `schedule` fails → stuck in `AwaitingModel` forever

I had written in `shell.ts` that "persisting state first means the worst
case is an unsent effect, which the timeout guard can recover, **because the
guard itself is in state**". That last clause was wrong: the guard lives in
`cf_agents_schedules`, produced by a separate write that can fail
independently. The old hibernation tests only proved "a successfully
scheduled guard survives eviction" — they never touched "the guard was never
scheduled at all".

And this window **cannot be closed at the platform level**: DOs only offer
the synchronous `ctx.storage.transactionSync()`, which cannot span an
`await`, while `schedule()` is async. So reconciliation is not a compromise
— it is the only solution.

The fix:

- `AwaitingModel` goes from `{ requestId }` to `{ requestId, deadlineAt }` —
  **the deadline lives in state**; repair reads state only, never the
  schedule table.
- `AgentDef.reconcile(state, now)`: a pure function answering "which action
  repairs me back to consistency". `now` is injected by the shell; rule 1
  still holds.
- `schedule()` always passes `idempotent: true`, so re-arming never grows
  duplicate rows.
- If scheduling fails, run that action on the spot and terminate the rest of
  the directive batch: the round fails early, but it neither deadlocks nor
  keeps calling the model without a guard.

### 3. `AgentDef.state` claimed validation but was never used

The comment said "validated at the trust boundary"; the implementation had
not a single line. Now actually decoded in `initializeOnce()`.

**The default policy for bad state is quarantine**: raw data stays untouched
in SQLite for human inspection; the agent refuses service and reports.
No silent reset (which silently eats user data), no running anyway (`cmd`
may throw or fall into an unmatched branch). This is a changeable product
decision, not a technical conclusion.

### 4. Unbounded growth of input and history

`MAX_MESSAGE_CHARS` (4096) and `MAX_HISTORY_MESSAGES` (40), shared across
three places: the boundary rejects by UTF-8 bytes, `cmd` truncates, the
schema enforces the invariant. Model output is truncated the same way —
otherwise an overlong reply makes the next wake's state validation fail and
quarantines the agent.

### One more thing found while fixing these

`onStart()` is triggered by partyserver's `#ensureInitialized()`, which
**only fires on the SDK's real entries** (`fetch` / `alarm` /
`webSocketMessage`). Any path that bypasses those entries and calls methods
directly (RPC, facets, `runInDurableObject`) never runs it.

So validation and repair cannot hang off `onStart()` alone — invariants must
not depend on which door the caller came through. They now live in
`initializeOnce()`, jointly guaranteed by `onStart()`, `dispatch()` and the
public `reconcileNow()`. Initialization is single-flight via a shared
Promise: concurrent callers await the same round, and a failure is never
mistakenly recorded as completed. Instruction results produced *inside*
initialization must also stay on that private path; going back through the
public `dispatch()` would await the still-unfinished initialization Promise
— an instant deadlock.

## Backflow from the first real app (round three)

After building the first real application on this skeleton (a tool-calling
shop-assistant agent), four friction points — places the app either worked
around or copied verbatim — flowed back into the base:

- **`core/turn.ts`, the turn-guard toolkit**: the `reconcile` decision was
  duplicated word-for-word across both agents — that is a base invariant,
  not business logic. `nextRequest` / `guardDeadline` / `reconcileTurn`.
- **`AgentDef.scheduledAction`**: schedule-table payloads cross the same
  SQLite trust boundary as state; `resumeAction` now validates on wake and
  drops malformed rows with a report instead of feeding them to `cmd`.
- **`DirectiveAgent.runQuery`**: the sanctioned read-only path (awaits
  initialization, respects quarantine). The first app reached into
  `this.runtime` to run an action directly and bypassed quarantine — the
  bug got promoted into an affordance.
- **The text-input boundary**: byte limit, rejected reporting and clock
  injection moved into the shell (`maxInputBytes` / `textAction`); apps no
  longer copy the `onMessage` boilerplate.

Deliberately **not** backflowed: the tool-calling loop itself. The second
consumer's state machine won't be a plain chat loop; extracting now would
extract the wrong shape — wait for the third real copy.

## Incidental observation

The tables actually created inside the DO include `cf_agents_fibers`,
`cf_agents_workflows`, `cf_agents_runs` — the Agents SDK ships its own
durable execution. Add Effect's side (Effect Cluster, `@effect/workflow`)
and **two durable-execution systems in one process is a real risk, not a
hypothetical**. Rule 2 is not fastidiousness; it is necessary.

## Not done yet

- **Never actually deployed.** Everything above was verified in local
  workerd (miniflare). The *timing* of real evictions (70–140s) cannot be
  simulated, and `runDurableObjectAlarm()` fires immediately rather than
  waiting. What was verified is "can it pick up after an eviction", not
  "evicted after N seconds".
- `ModelClientLive` is an echo stub; Workers AI / AI Gateway not wired yet.
- `agents` is `^0.20.1` — pre-1.0, README explicitly not accepting external
  PRs, `experimental/` has no stability guarantees. Pin the version and be
  ready to track migrations.
