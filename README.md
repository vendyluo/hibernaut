# hibernaut

A narrow GitHub template for a hibernation-aware agent on Cloudflare Durable Objects. It is a runnable echo example and an architecture to copy—not a runtime or npm package.

It addresses a specific failure: persisted state still says “waiting” after the in-memory provider call disappears. Request IDs, timeout guards and activation-time reconciliation recover the domain state—not the interrupted call. A missing guard still needs another event to wake the object.

*[台灣繁體中文](./README.zh-TW.md)*

## What is included

- `src/example/chat.ts`: a bounded chat state machine with request correlation, a durable timeout guard, and wake-time reconciliation.
- `src/index.ts`: the Cloudflare entry point and an echo-only `ModelClient` layer.
- `src/core/`: pure state transitions and directive descriptions. Actions import Effect; `cmd` itself is platform-free.
- `src/runtime/`: the Agents SDK shell for persistence, scheduling, validation, WebSockets, and action execution.
- Core tests and workerd tests, including explicit Durable Object eviction.

The example needs no AI key and creates no cloud resources. It echoes text so the durability behavior stays visible and deterministic.

## Requirements and setup

[Node.js 24 LTS](https://nodejs.org/) is recommended. The template pins `agents` to the exact SDK version whose behavior is covered by its tests; review the tests and current Cloudflare documentation before upgrading it.

Use GitHub's **Use this template → Create a new repository**, then clone your new repository and run the commands from its root. The license decision is still pending; see the release preflight before redistribution.

```bash
npm ci
npm run typecheck
npm test
```

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

## Adapt the template

1. Replace the state, actions, and `cmd` transition function in `src/example/chat.ts`.
2. Replace the echo `ModelClient` in `src/index.ts` with your provider binding.
3. Keep decisions in `cmd`, I/O in Actions, and platform translation in the shell.
4. Add authentication, tenant authorization, rate limits, observability, and provider idempotency before production use.
5. Add a Durable Object binding and migration when renaming or adding an agent class.

This example shares a room's history with every connection to that room. It has no authentication or tenant isolation. Do not deploy it publicly before adding those controls.

## Scope and limits

| Need | Start with |
| --- | --- |
| Explicit domain states, stale-result guards, independently testable decisions | This template |
| Ordinary stateful chat, scheduling, or built-in chat UI integration | Agents SDK / AIChatAgent directly |
| Agent-local interrupted work with explicit checkpoints | SDK `runFiber` / `stash`; recovery logic is still yours |
| Independent multi-step jobs with durable steps, retries and long waits | Workflows |
| Stateless request handling | A plain Worker |

This template demonstrates one guarded request/response turn. It does not provide a general supervisor, tool loop, replay engine, outbox, schema-migration system, or exactly-once effects. `runQuery` is a read-only convention inside the template; it cannot force an external provider to be read-only.

For longer durable processes, use the platform facilities designed for them: [Agents durable execution](https://developers.cloudflare.com/agents/runtime/execution/durable-execution/) or [Cloudflare Workflows](https://developers.cloudflare.com/workflows/), according to your requirements. The detailed contract and failure semantics of this implementation are in [NOTES.md](./NOTES.md).

Dependency and attribution information is in [THIRD_PARTY.md](./THIRD_PARTY.md). `package.json` currently carries ISC metadata, but this repository has no `LICENSE` file; do not treat this README as an open-source license grant.

Maintenance covers the example, failure contracts, tests, and matching documentation—not provider adapters or downstream applications. Template copies do not auto-update. Review changes manually, retain your schema migrations, and rerun both suites before upgrading the SDK. No stable package API or support SLA is promised.
