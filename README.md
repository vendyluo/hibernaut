# hibernaut — a durable-agent pattern template for Cloudflare

> hibernation + astronaut: a Durable Object gets evicted roughly every
> 70–140 seconds. Everything in this repo is about navigating that
> environment and staying alive.

*[繁體中文](./README.zh-TW.md)*

This is not a general-purpose starter. It is a **pattern template**: a set
of invariants for writing long-lived, stateful, hibernation-survivable
agents on Cloudflare Durable Objects, shipped as a runnable reference
implementation with its test harness. The core ideas are borrowed from
BEAM/OTP (by way of [Jido](https://github.com/agentjido/jido)'s three-layer
split), grounded on the Agents SDK + Effect.

The full argument — the four hard rules and the field evidence behind each —
lives in **[NOTES.md](./NOTES.md)** (zh-TW). That document is the actual
asset of this repo; the code is its executable form.

## When to use it / when not to

**Use it for** (the sweet spot is narrow but deep):

- Long-lived, event-driven agents: the lifecycle of a trip, a conversation,
  an order
- Multi-step flows that must survive hibernation and deploys (tool-calling
  loops, timeout guards, scheduled wake-ups)
- Decision logic that must be testable with zero platform dependencies
  (a pure `cmd` function — no miniflare needed to test it)

**Do not use it for** (the discipline would be pure overhead):

- Stateless Workers (plain APIs, proxies, transforms) — write them the
  platform-native way
- Standard chat apps where the SDK's `AIChatAgent` + `useAgentChat` are
  enough — take the SDK's built-in path
- Long-running background pipelines — use
  [Workflows](https://developers.cloudflare.com/workflows/), not this

## The three-layer split

```
core/      Pure functions. Action / AgentDef / Directive / turn — zero
           platform, zero Effect runtime. All agent decision logic lives
           here and can be fully covered by snapshot tests.
runtime/   The shell. The only file that touches the Agents SDK
           (DirectiveAgent): dispatch ordering, schedule guards, state
           validation and quarantine, reconcile, runQuery, the text-input
           boundary.
example/   chat.ts is the living spec — it demonstrates every rule and
           not one line more. New agents start by copying it.
```

The rules, shortest form (full version and evidence in NOTES.md):

1. `cmd` is a pure function — time and randomness are inputs, not ambient
2. Durability has exactly one owner: Cloudflare (`setState` / `schedule`);
   Effect only governs the inside of a single handler
3. Persist state first, arm the guard second, make the risky call last;
   the deadline lives in state itself, and `reconcile` self-repairs on wake
4. Every echo must be safe to ignore (requestId correlation; stale ones
   are dropped)

## Usage

This repo is a GitHub template: hit `Use this template`
(or `degit vendyluo/hibernaut`), then:

```bash
npm install
npm test          # core (zero platform) + workers (real workerd, manual eviction)
npm run typecheck
npm run dev
```

Starting a new agent: copy `example/chat.ts` and rewrite the state machine,
subclass `DirectiveAgent` in `index.ts`, add the DO binding and a
`new_sqlite_classes` migration in `wrangler.jsonc`. All decisions go in
`cmd`, all I/O goes in Actions, and the shell never grows business logic.

## Maintenance discipline

- **At the end of every app built on this, ask once: what should flow back
  into the template?** This repo iterates on application experience; the
  backflow habit is what offsets the template model's inherent flaw (clone
  drift). Once a third consumer exists and core has stopped moving, consider
  extracting a package — not before.
- **Resist fattening it.** Before adding anything, ask: is this an invariant
  or business logic? Business logic stays in the application repo.
- **`agents` is pre-1.0 — pin it.** The shell is the only file that touches
  the SDK; an SDK upgrade may only change that file. SDK behaviors that
  `reconcile` depends on (like `schedule`'s `idempotent` semantics) are
  pinned by the workers tests — when the SDK quietly changes behavior, a
  test screams, not production.
