# Architecture notes

*[台灣繁體中文](./NOTES.zh-TW.md)*

Reviewed 2026-09-12. This document states the contract of the implementation pinned in this repository. Cloudflare's current documentation may describe a newer Agents SDK; for example, the [published `agents@0.20.1` artifact](https://registry.npmjs.org/agents/-/agents-0.20.1.tgz) used here includes partyserver lifecycle behavior but no `lifecycle.start` API. Do not assume a current-doc API exists in the pinned version. `runFiber` exists in this version; this template does not assume `startFiber`. npm metadata provides no `gitHead`, so a current GitHub commit is not treated as this version's source provenance.

## Layers and boundaries

| Layer | Responsibility |
| --- | --- |
| `src/core/` | State/action types, pure `cmd`, directives, and turn-guard calculations |
| `src/runtime/shell.ts` | Agents SDK boundary, state and scheduled-payload validation, dispatch, scheduling, WebSockets, Effect runtime |
| `src/example/chat.ts` | One bounded echo-chat state machine and one Effect-based Action |
| `src/index.ts` | Worker routing, Durable Object class, and provider layer |
| `src/example/task-agent.ts` | Long-task receipts, deduplication, terminal outcomes, termination intent and durable reconciliation |
| `src/example/task-workflow.ts` | Durable Workflow steps, bounded retries, approval waits and terminal publication |
| `src/core/task.ts` | Job data contracts and versioned product policies |
| `src/runtime/task-http.ts` | Demo HTTP submission, inspection, approval and cancellation |

`cmd(state, action)` synchronously returns the complete next state plus descriptions of outbound effects. Time and identifiers are explicit inputs. The pure command path is platform-free, although `src/core/action.ts` imports Effect to define and run Actions.

Cloudflare storage and Agents SDK schedules own state that must cross activations. Effect timeout and retry apply only inside the current Action execution. For durable task execution, evaluate the platform's documented choices instead of extending in-memory fibers:

- [Schedule tasks](https://developers.cloudflare.com/agents/runtime/execution/schedule-tasks/)
- [Durable execution](https://developers.cloudflare.com/agents/runtime/execution/durable-execution/)
- [Run Workflows](https://developers.cloudflare.com/agents/runtime/execution/run-workflows/)

## Long-task product contract — 2026-10-01

The primary example follows `submitting → queued/running/waiting → succeeded/failed/cancelled`. `submitting` reserves identity and input without confirmed acceptance. HTTP `202` confirms that the Workflow exists and a durable watcher is armed. One owner/key identifies one Workflow; changing the request under that key is rejected. Retry a lost acceptance response with the same key.

The SQLite receipt, SDK interval schedule and Workflow creation are not a distributed transaction. Reserve identity synchronously, arm the watcher, then create or confirm the same Workflow ID. An interruption before acceptance can leave a receipt: an armed watcher repairs it automatically; a receipt without a watcher needs resubmission or inspection with the same key to rearm recovery. That window never returns acceptance. Failed creation is followed by inspection of the same ID to distinguish a lost successful response from an unconfirmed result.

Workflows retains completed steps and event waits independently of Agent eviction or client connections. It does not resume the original Promise; unfinished external steps may execute again. Provider steps receive stable idempotency keys, which adapters must actually use or replace with reconciliation/compensation. The example's deterministic echo is repeatable; it does not establish exactly-once behavior for a real provider.

Both policies permit two durable retries. `transient-only` permits execution failures explicitly marked retryable by the adapter. `regenerate` also permits regeneration after output validation fails. Invalid input is not retried. Actions have a 25-second budget, Workflow steps a 30-second timeout; unclassified/permanent failures and application timeouts are not retried automatically. Platform interruption can still replay unfinished steps, requiring idempotency. Workflow execution does not add an in-handler Action retry loop.

Optional approval waits expire after 24 hours. A durable progress step explicitly records product-level `waiting`: the local Workflow engine can report `running` during `waitForEvent`. Platform execution status is not used as the sole source of product waiting state.

The Workflow publishes terminal outcomes through durable steps. A 60-second interval watcher repairs lost publication, interrupted creation and the 25-hour overall deadline. Cancellation/deadline intent is persisted before terminating the Workflow, so recovery between platform termination and receipt settlement preserves the right reason. A confirmed terminal outcome wins completion/termination races; late results cannot overwrite it. Cancellation does not undo external effects.

Agent SQLite retains terminal receipts and outputs. Watcher cleanup failures do not reverse terminal outcomes; subsequent ticks retry cleanup. Each key owns an independent watcher, so settling one job cannot remove another job's wake-up. Receipts are not deleted by this example: define retention, quotas and deduplication windows for production. Retained receipts do not depend on Workflow history retention.

The promise assumes continuing availability of Cloudflare storage, alarms, Workflows and a compatible deployment. Outages delay retries and deadline handling; the 60-second cadence is not a completion SLA. Disabling service, deleting bindings/namespaces or incompatibly replacing in-flight contracts breaks the promise. Keep `hibernaut-task-v1`, step names and accepted-job policy semantics; add versions for new contracts.

The task HTTP example has no authentication, owner authorization or quota enforcement and must not be exposed publicly as-is. A room name is not an authorization boundary. Platform contracts: [Workers API](https://developers.cloudflare.com/workflows/build/workers-api/) and [sleeping and retrying](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/).

New receipts and Workflow parameters bind `contract.workflowVersion` and `contract.policyVersion` at acceptance. Legacy receipts and in-flight v1 payloads without these fields resolve specifically to the original v1 contract. Unknown versions fail without falling back to current defaults. The v1 policy registry is frozen; retain its semantics and add a new registry/Workflow version for changes. This is explicit compatibility handling, not an automatic migration.

Existing receipt updates use one synchronous transition: reread SQLite, decide
and write without an intervening await. Terminal receipts are immutable; identity
and contract fields are excluded from updates. Cross-binding continuations recheck
current state before cancellation or deadline handling. Watcher cleanup matches
callback and task key, including watchers created after settlement while
preserving other jobs' schedules.

## Hibernation is eligibility, not a timer

A Durable Object can normally hibernate only while idle and when nothing prevents hibernation: no timers, in-progress awaited fetch, active event, standard WebSocket, or outbound socket. Cloudflare documents a 10-second idle period for normal hibernation eligibility. The documented 70–140 second range concerns eviction of an idle object that cannot hibernate; it is not a periodic wake-up or service-level guarantee. Deployments and restarts can also discard memory.

Therefore every in-memory runtime, layer, and fiber is a cache or current-handler mechanism, never durable state. Local `wrangler dev` does not reproduce production eviction timing; workers tests explicitly evict the object to verify reconstruction while preserving storage.

Source: [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/).

## Dispatch and initialization

An SDK commit can update its memory cache before writing SQLite. An uncertain
commit quarantines the entire activation, blocking new domain commands, queries,
late instruction results and remaining directives. Already admitted external
effects are not undone. Reinitializing the same activation cannot clear this;
eviction or a full restart lets a fresh activation reload actual persisted state.
This trades temporary availability for confirmed state, without guessing rollback
or automatically retrying the turn.

Before any write or effect, the shell checks the complete candidate data through property descriptors, rejecting accessors and custom array prototypes without invoking getters or serialization hooks. It then validates the complete candidate state on the schema Type side and the entire directive batch (including scheduled payloads and registered instruction targets). Validation does not decode or migrate candidates. Invalid candidates leave storage unchanged and dispatch no effects.

Failures throw `TurnError` with `stage` and `commitStatus`: execution/validation are `not-committed`, storage acknowledgement failures are `unknown`, and directive failures are `committed`. A storage error does not prove the write failed; inspect before retrying. Effect failure stops later effects and does not roll back the commit. The existing guard-scheduling fallback still reports through `onFail`, runs its terminal guard and aborts the batch; it is not a rollback. Provider errors delivered as instruction outcomes remain domain inputs.

For each action, the shell computes and persists the complete next state, orders scheduled guards before emissions and instructions, then executes directives. State persistence and schedule creation are **not one transaction in this implementation**. No broader claim is made about every platform storage API.

Initialization validates stored state, runs the subclass's idempotent `onWake`, and reconciles the state. It is single-flight, and failed `onWake` attempts can be retried. Internal instruction-result dispatch uses a private initialized path so initialization never waits on itself. Native RPC or tests can bypass normal SDK lifecycle entries, so they must reach initialization through the shell's public entry points or initialize explicitly. WebSocket SDK RPC is a separate transport concern.

Keep `onWake` bounded and reconstructible; do not perform slow provider calls there. Never call public `dispatch`, `reconcileNow`, or `runQuery` from initialization: they wait for initialization and would self-deadlock.

The Action timeout starts after ManagedRuntime has acquired its layer; it does not bound `onWake` or layer acquisition. The echo uses `Layer.succeed`. If you replace it with asynchronous initialization, provide a separate bounded acquisition/failure policy; `runQuery` has no scheduled turn guard to compensate for a stalled layer.

The shell intentionally exposes no public generic `dispatch`, `reconcile`, or `runQuery` endpoint to untrusted clients. Any application-specific RPC needs its own validation and authorization.

## Guarded turn contract

This section describes the retained chat example. Long tasks use the Workflow path above instead of chat timeout guards.

The example persists `AwaitingModel(requestId, deadlineAt)`, then schedules a 60-second `ModelTimeout`, then runs the provider instruction. These are application policies, not Worker limits. The Action has a 25-second timeout across its configured in-handler retries; that is also not a 30-second Worker wall-clock claim.

The template's `ScheduleAction` is safe only for early, terminal guards. If guard scheduling fails, the shell immediately dispatches the guard action and aborts all remaining directives in that batch. It is not a general-purpose scheduler.

SDK scheduling with `idempotent: true` deduplicates the callback, serialized payload, and schedule type. It does not update an existing due time, and it does not make downstream side effects exactly once. This statement is limited to the pinned version and covered behavior.

If a guard is missing and the object crashes, repair needs another activation; there is no self-wake guarantee. An existing guard may wake the object later, but its deadline is a recovery target, not an SLA. Before the deadline, recovery ensures a guard exists; on expiry it moves the state to `Idle` and emits an error. It never resumes or replays an interrupted provider call: its result may be lost, while an external effect may have happened with an unknown outcome.

Provider results carry `requestId`. A matching result and timeout race through the same state machine; the first one processed wins, and the later one is ignored. The deadline does not strictly invalidate output before the timeout action is processed.

## Delivery and concurrency semantics

Durable Object alarms are at-least-once. For an alarm handler ending in an uncaught exception, Cloudflare documents automatic retries with exponential backoff, up to six retries starting at two seconds. An Agents SDK scheduled callback has the SDK's own callback/retry policy; this template does not promise perpetual delivery. See [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/).

Await points permit interleaving, so the explicit busy rejection prevents overlapping turns; it does not mean every slow await blocks every request. Emissions are best effort and there is no outbox. Provider retries can repeat effects: use provider-supported idempotency keys and reconciliation/compensation where necessary. This template does not guarantee exactly-once external effects.

Persisted state and scheduled payloads are schema-validated on activation/callback. Invalid state is quarantined without silent reset; invalid scheduled payloads are dropped and reported. The implementation has bounds on input and retained history, but no general schema migration mechanism.

These boundaries use `Schema.decodeUnknownResult(Schema.toType(schema))`: stored values must already satisfy the schema's decoded **Type** side and be JSON-compatible. The shell does not call schema encoders or apply transformations on recovery. For example, `NumberFromString` requires a stored number, not a numeric string; `Trim` rejects untrimmed scheduled IDs rather than changing their identity. Action inputs are different: `runAction` explicitly decodes them before execution. Schema changes requiring migration need a separate, deliberate data-migration procedure.

## Security and intended use

`validateStateChange` rejects client-originated state updates so they cannot mutate `cf_agent_state` through the state protocol while ordinary text messages continue to work. Do not substitute the readonly-connection hook on this SDK version: it also prevents server state writes within that connection's handler. This is hardening, not authentication. There is no authentication, tenant authorization, or rate limiting. Every connection using the same room name receives that room's shared history. Do not expose the example publicly before adding those controls.

`runQuery` is a convention for an initialized, quarantine-aware query path; it cannot prove that an Action or external provider has no side effects. The template also does not promise a supervisor, generic tool loop, replay of interrupted calls, outbox delivery, or exactly-once behavior.

## Verification and release

Use `npm ci`, `npm run typecheck`, `npm test`, the focused core/workers suites, `npm run smoke` against local dev, and `npm run build` for a Wrangler dry run. Recorded evidence, rather than historical counts or bundle measurements in prose, belongs in [RELEASE.md](./RELEASE.md). Dependency attribution is in [THIRD_PARTY.md](./THIRD_PARTY.md).
