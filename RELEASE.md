# Release preparation — approval pending

Prepared 2026-09-12. Nothing has been pushed, released, deployed, renamed remotely,
published to npm, or posted externally by this work. GitHub already reports the
repository as public and `isTemplate: true`.

## Version source and maintenance location

The old local `cfa` history and GitHub `main` have no common ancestor. They must
not be joined with a blind pull/reset or an unrelated-histories merge.

- Old local HEAD: `b489e335be4ddbc0b8d1c0364e2f65e8c85817ac` (legacy-only commit ID).
- Its complete tree equals GitHub's
  [initialization fix](https://github.com/vendyluo/hibernaut/commit/06e2697):
  tree `8226e944b860b9cfc723b1e908bb58f29841502c`; `git diff` is empty.
- GitHub then contains the turn guards, input/query boundary, and bilingual docs,
  through [the inspected main](https://github.com/vendyluo/hibernaut/commit/328782e).
- The old tracked worktree and untracked non-ignored set were clean. No unique
  tracked content needs transplanting. Existing ignored local data/builds remain
  in `cfa`, untouched; they are not publication inputs.

Recommendation: maintain the independent `hibernaut` clone on
`template-readiness`, based on GitHub main. Keep `cfa` as the preserved legacy
checkout; the new clone also retains `legacy/main` as a local comparison ref.
No remote rename is needed. Archiving/removing the old directory is a separate
decision, not part of this preparation.

## Executed verification

The [complete Linux output](./verification/local-linux.txt) records a fresh
container with **Node 24.21.0 / npm 11.19.0**, no host `node_modules`, Wrangler
state, Cloudflare credentials, or persistent Docker volume. The container was
removed after completion. The final suite contains 58 tests (27 core, 31 workerd).

Linux image: `node:24-bookworm-slim`, manifest digest
`sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553`.
Lockfile SHA-256:
`5f1ebf78dcdca552e379e21f63d1c7a3937a7da83a166efee528c62a475c1d91`.

| Check | Observed result | What it does not prove |
| --- | --- | --- |
| `npm ci` | Clean Linux install succeeds | No vulnerability-free dependency claim |
| `npm run types` + byte comparison | Generated binding types unchanged | Production bindings exist |
| `npm run typecheck` | Source, both test suites and Vitest config pass | Runtime behavior |
| `npm run test:core` | 27 pass | Storage, scheduling or transport |
| `npm run test:workers` | 31 pass in local workerd | Production timing, availability or regional behavior |
| `npm run build` | Dry run: 2897.65 KiB raw / 544.72 KiB gzip | Deployment success, production startup budget or billing |
| Local dev + `scripts/smoke.mjs` | 101 upgrade, echo, client state-write rejection, persisted seq, clean 1000 close | Authentication, provider integration or production hibernation |
| `npm audit --omit=dev` | 0 reported vulnerabilities | Absence of unknown vulnerabilities |
| Full `npm audit` | 0 reported vulnerabilities after the patch override below | Absence of unknown vulnerabilities |
| Patched `sharp` smoke | Native PNG encode/decode, width 2 / height 3 pass | Coverage of every image codec |

Commands can be repeated with `npm ci`, `npm run types`, `npm run typecheck`,
`npm test`, and `npm run build`; use a second terminal for `npm run smoke` while
`npm run dev` is running. The container run used the same Wrangler CLI underlying
`npm run dev`. Docker's macOS archive metadata was disabled during transfer; it
is not part of the GitHub template. GitHub Actions CI is prepared locally, not
executed remotely.

Expected fault-injection errors are retained in the log: invalid stored state,
simulated schedule failure, and denied client state updates. SDK dependency
sourcemap warnings do not fail the test run. ANSI terminal colors are removed
from the saved log for readability; warnings and errors are not filtered. The smoke prints PASS only after
the WebSocket closes normally; an early draft caught a close-handshake failure
and was corrected to send explicit close code 1000 before this recorded run.

## Failure coverage and limits

- **Pure decisions:** stale/duplicate model results; timeout then newer turn;
  old timeout duplicates; exact deadline boundary; bounded text/history;
  result-versus-timeout first-processed-wins policy.
- **Local workerd:** memory marker lost on forced eviction, SQLite state and
  guard survival, missing-guard repair before/after deadline, duplicate schedule
  repair, same-payload deduplication preserving due time, failed scheduling
  aborting instructions, initialization single-flight/failure/retry/self-deadlock,
  invalid scheduled payload rejection, quarantine including query path, live
  WebSocket reconnection-free forced eviction, server-owned protocol state.
- **Review regressions:** stored state and scheduled payloads validate the
  schema's decoded Type side without running transformations. Numeric state is
  accepted while encoded numeric strings are quarantined; canonical scheduled
  IDs execute while untrimmed IDs are rejected and reported. These tests caught
  three failures in the old decoder-based implementation before the fix.
- Interrupted provider states are **seeded deliberately**, not produced by
  killing a real remote model call. `evictDurableObject` normally drains in-flight
  events; manually due SQL rows and `runDurableObjectAlarm` are fault-injection
  tools, not measurements of scheduler latency or actual idle eviction.
- No real Cloudflare deployment or provider call was made. No claims of fixed
  hibernation intervals, exact alarm timing, unconditional self-wake, replay of
  interrupted execution, durable emission delivery, or exactly-once effects.
- The Action timeout does not cover `onWake` or ManagedRuntime layer acquisition.
  The echo layer is synchronous; downstream asynchronous layers need a separate
  bounded initialization policy. See NOTES for the query-path limitation.

## Security and publication audit

The initial lockfile had 11 reported vulnerabilities. Compatible dependency and
tooling updates first reduced this to 4 high entries in the test-tool dependency chain:
`@cloudflare/vitest-pool-workers → wrangler/miniflare → sharp`.
The underlying advisory is
[GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c)
(libheif, `sharp <0.35.4`). The test pool pins its own older tools even though the
top-level Wrangler was updated. A targeted `sharp: 0.35.4` npm override replaces
its `0.35.2` with a same-minor patch release (the top-level Wrangler already uses
0.35.4). The final full audit reports **zero** vulnerabilities. Both test suites,
local dev/transport smoke and a native sharp PNG encode/decode check pass with
this override in clean Linux. No forced testing-API downgrade was used.
Remove the override when the test pool's own dependency is patched, then rerun
clean installation, tests, dev smoke and full audit. The app itself does not use
image processing; these checks are not a comprehensive image-codec security audit.

Gitleaks 8.30.1 found no secrets across all 8 reachable commits (including the
legacy history), and its directory scan found no secrets in the current
publication files. Pattern scanning is not proof that all sensitive data is absent.
The repo has no required secrets or account IDs; `.env*`, `.dev.vars*`, Wrangler
state, build output, logs and dependencies are ignored. Error details/history
are visible to room participants; add authorization and sanitize provider errors
before production use.

Publication inputs: source, tests, lockfile, Wrangler/TypeScript/Vitest config,
generated binding types, smoke script, CI, bilingual README/NOTES, third-party
notices and license copies, this record and introduction draft. **Main LICENSE is
the intentional missing prerequisite.** No npm package entry point or release
automation is provided; `private: true` blocks accidental npm publishing.

## Shortest approval checklist

1. **License:** recommended Apache-2.0 for project code/docs, copyright
   `2026 vendyluo`, retaining upstream notices. It aligns with Jido references
   and includes explicit patent terms. Alternative: retain ISC for original
   work and keep Apache notices for quoted/adapted material. Confirm the license
   and copyright name; then add root LICENSE and align package metadata/docs.
2. **Remote update:** approve pushing `template-readiness` to
   `vendyluo/hibernaut` and opening a review PR against `main` (no force push,
   legacy-history merge, repository rename or deployment). Merge requires its
   own authorization unless explicitly included. Run CI on that exact revision.
3. **Release:** after approval of the final revision, create a GitHub prerelease
   tagged `template-2026-09` using the draft below. The inherited package version
   `1.0.0` is not a published runtime API promise. No npm release is proposed.
4. **Introduction:** approve the text in [INTRO.md](./INTRO.md) and the exact
   external destination before posting. No destination has been chosen.

## Optional real-platform verification — separate approval

Not required to honestly publish a **locally verified preview template**, but
required before claiming Cloudflare production validation. Proposed resources:
one temporary Worker `hibernaut-validation`, one SQLite DO namespace with a few
test instance names, synthetic text only, no Workers AI/API keys, bounded test
window of roughly 30 minutes. Account and spending cap must be supplied/approved;
Worker requests, DO duration/storage and logs can incur charges.

Before deployment, add access control to the validation route in a separate
test configuration; do not expose the unrestricted example. Record cold-start
markers and timestamps, observe eligible idle WebSocket survival, restart/deploy
during a delayed synthetic call, verify existing guards deliver and return Idle,
and inject missing guards to verify repair only after a separate wake. Record
actual observed delays without converting them to an SLA. Provider side-effect
idempotency remains a separate integration test. Cleanup of this test Worker,
namespace data and logs must be included explicitly in the resource approval.

## GitHub prerelease draft (English)

**Hibernaut — a locally verified durable-agent pattern template**

This preview makes one failure boundary explicit: a turn can remain persisted
as waiting after its in-memory provider execution disappears. Hibernaut records
a request ID/deadline, arms a timeout before the call, rejects stale results, and
reconciles domain state on activation. It returns an interrupted turn to a
defined timeout outcome; it does not resume the call or guarantee exactly-once
external effects.

Included: a no-credentials echo example, 58 local tests (27 pure-core, 31
workerd), a working local quickstart/smoke, generated binding types, CI, bilingual
documentation and source attribution. Client protocol state writes are rejected
without breaking normal text-driven server transitions.

Choose this template for explicit domain decisions and failure-state tests.
Use the official Agents SDK directly for ordinary chat or checkpoints, and
Workflows for independent durable multi-step jobs. No real-platform validation,
production authentication, stable package API or npm package is included.

Before publishing this draft, insert the approved license. The pinned dependency
graph passes the full npm audit on the verification date; a documented patch
override is required for the current test pool. See the verification record for
exact versions and limits.
