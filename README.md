# hibernaut

A GitHub template centered on durable long-running agents on Cloudflare. An Agent accepts jobs and retains receipts; Workflows executes durable steps, retries and waits independently of client connections and Agent activations. It is a runnable example and an architecture to copy, not an npm package.

The primary contract is to track accepted work to success, failure or cancellation and retain a queryable terminal receipt. Retry and recovery follow product policy; external effects are not exactly once. The original guarded chat remains a separate product contract: it repairs domain state after interruption without resuming the provider call.

*[台灣繁體中文](./README.zh-TW.md)*

## What is included

- `src/example/task-agent.ts`: retained receipts, submission deduplication, inspection, approval, cancellation and alarm reconciliation.
- `src/example/task-workflow.ts`: durable steps, approval waits that survive restarts and terminal publication.
- `src/core/task.ts`: job contracts and replaceable `transient-only` / `regenerate` product policies.
- `src/example/chat.ts`: a bounded chat state machine with request correlation, a durable timeout guard, and wake-time reconciliation.
- `src/index.ts`: the Cloudflare entry point and an echo-only `ModelClient` layer.
- `src/core/`: pure state transitions and directive descriptions. Actions import Effect; `cmd` itself is platform-free.
- `src/runtime/`: the Agents SDK shell for persistence, scheduling, validation, WebSockets, and action execution.
- Core tests and workerd tests, including explicit Durable Object eviction.

The example needs no AI key and creates no cloud resources. It echoes text so the durability behavior stays visible and deterministic.

## Requirements and setup

[Node.js 24 LTS](https://nodejs.org/) (24.11 or newer) is recommended. The template pins `agents` to the exact SDK version whose behavior is covered by its tests; review the tests and current Cloudflare documentation before upgrading it.

Use GitHub's **Use this template → Create a new repository**, then clone your new repository and run the commands from its root. The license decision is still pending; see the release preflight before redistribution.

```bash
npm ci
npm run typecheck
npm test
```

The toolchain pins Vite+ 1.0.0 and Effect 4.0.0. Core tests use Vite+'s bundled
Vitest 5.0.1. The `test-workers` npm workspace retains Vitest 4.1.11 because
Cloudflare's pinned pool supports only Vitest 4.1; root `npm ci` installs both
runners, and `npm test` runs both suites. Keep their dependencies separate and
do not add a global Vitest override. The worker workspace also pins Vitest 4's
optional UI/browser-preview peers to prevent npm from binding them to v5; these
packages do not enable browser or UI tests. `npm run check` runs Vite+ format/lint checks;
`npm run typecheck` checks the source and both test suites. Worker dev/build stay
on Wrangler (`npm run dev` / `npm run build`).

Focused suites are also available:

```bash
npm run test:core
npm run test:workers
```

## Run locally

```bash
npm run dev
```

This starts `wrangler dev --local --ip 127.0.0.1`. In another terminal:

```bash
npm run smoke
npm run smoke:tasks
```

The smoke test opens a unique room at:

```text
ws://127.0.0.1:8787/agents/chat-agent/<unique-room>
```

It verifies the plain-text echo and verifies that client writes to SDK agent state are rejected. `validateStateChange` rejects client-originated writes while allowing server transitions; it is **not authentication**. The root path intentionally returns `404`.

To check the deployment bundle without deploying:

```bash
npm run build
```

See [RELEASE.md](./RELEASE.md) for recorded verification evidence and the release preflight. Do not infer current test counts or bundle limits from this README.

## Long tasks and product policy

```bash
curl -X PUT http://127.0.0.1:8787/tasks/demo/jobs/report-1 \
  -H 'content-type: application/json' \
  -d '{"text":"Prepare a report","policy":"transient-only","requireApproval":true}'
curl http://127.0.0.1:8787/tasks/demo/jobs/report-1
curl -X POST http://127.0.0.1:8787/tasks/demo/jobs/report-1/approve
```

New jobs receive `202` only after their Workflow exists and durable reconciliation is armed; already-settled duplicates return the retained terminal receipt. The same owner/key and request address one job; a different request reusing the key receives `409`. A timeout or `503` means acceptance is unconfirmed: retry with the same key. `DELETE` requests cancellation. Success, failure and cancellation are immutable terminal outcomes. When completion races cancellation, the confirmed persisted outcome wins; cancellation does not undo external effects.

`transient-only` retries execution failures explicitly marked `retryable: true` by the provider adapter. `regenerate` also retries output validation failures, which suits repeatable content generation rather than payments or email delivery. Both examples allow two retries, a 25-second Action budget and a 30-second Workflow step timeout. Approval waits expire after 24 hours; jobs have a 25-hour deadline, reconciled by a 60-second durable watcher. Platform outages can delay progress: these deadlines are not an SLA.

Adapt the versioned Workflow, policies and `composeTask` provider adapter. Each provider step receives a stable idempotency key; adapters must actually use it and define reconciliation/compensation for unknown effects. Workflows retains completed steps, but unfinished steps may execute again. Terminal receipts remain in Agent SQLite independently of Workflow history retention. The example does not delete receipts; define retention and deduplication windows for your product. Keep old Workflow and step contracts when introducing new versions instead of changing jobs in flight.

For a full local restart check, run `npm run smoke:tasks -- accept`, stop and restart dev with the same `--persist-to` directory, then run `npm run smoke:tasks -- resume`. The check targets localhost only.

## Adapt the guarded chat

1. Replace the state, actions, and `cmd` transition function in `src/example/chat.ts`.
2. Replace the echo `ModelClient` in `src/index.ts` with your provider binding.
3. Keep decisions in `cmd`, I/O in Actions, and platform translation in the shell.
4. Add authentication, tenant authorization, rate limits, observability, and provider idempotency before production use.
5. Add a Durable Object binding and migration when renaming or adding an agent class.

This example shares a room's history with every connection to that room. It has no authentication or tenant isolation. Do not deploy it publicly before adding those controls.

## Scope and limits

| Need | Start with |
| --- | --- |
| Accepted long-running jobs, terminal receipts, approval and replaceable policies | This template's TaskAgent + Workflows |
| Explicit domain states, stale-result guards, independently testable decisions | This template |
| Ordinary stateful chat, scheduling, or built-in chat UI integration | Agents SDK / AIChatAgent directly |
| Agent-local interrupted work with explicit checkpoints | SDK `runFiber` / `stash`; recovery logic is still yours |
| Independent multi-step jobs with durable steps, retries and long waits | Workflows |
| Stateless request handling | A plain Worker |

This template demonstrates durable long tasks and a guarded request/response turn. It does not provide a general supervisor, tool loop, cross-system outbox, schema-migration system, or exactly-once effects. `runQuery` is a read-only convention in the chat example; it cannot force an external provider to be read-only. The task HTTP routes also lack authentication and owner authorization; add these controls and quotas before exposing them.

For longer durable processes, use the platform facilities designed for them: [Agents durable execution](https://developers.cloudflare.com/agents/runtime/execution/durable-execution/) or [Cloudflare Workflows](https://developers.cloudflare.com/workflows/), according to your requirements. The detailed contract and failure semantics of this implementation are in [NOTES.md](./NOTES.md).

Dependency and attribution information is in [THIRD_PARTY.md](./THIRD_PARTY.md). `package.json` currently carries ISC metadata, but this repository has no `LICENSE` file; do not treat this README as an open-source license grant.

Maintenance covers the example, failure contracts, tests, and matching documentation—not provider adapters or downstream applications. Template copies do not auto-update. Review changes manually, retain your schema migrations, and rerun both suites before upgrading the SDK. No stable package API or support SLA is promised.
