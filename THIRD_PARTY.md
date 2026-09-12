# Sources and third-party licensing

Reviewed 2026-09-12. This is attribution, **not a license grant for Hibernaut**.
The root package's existing ISC metadata has been retained pending the owner's
license decision. No npm publication is intended (`private: true`).

## Jido / BEAM inspiration

The Action / AgentDef / Directive / shell separation was inspired by
[Jido](https://github.com/agentjido/jido) and
[Jido Action](https://github.com/agentjido/jido_action), not a port of their
supervision or runtime. Hibernaut implements its own TypeScript state transitions,
Cloudflare persistence/schedule boundary, and Effect execution.

- [`Jido.Agent` invariants](https://github.com/agentjido/jido/blob/8a6b53134b92af91ca15d42e0834962da4bf26cb/lib/jido/agent.ex#L19-L28)
  inform `src/core/agent.ts`. The local pure `cmd` contract is a paraphrase and
  adaptation, not a verbatim claim about all Jido Actions (which can be effectful).
- [`Jido.Agent.Directive`](https://github.com/agentjido/jido/blob/8a6b53134b92af91ca15d42e0834962da4bf26cb/lib/jido/agent/directive.ex#L3-L7)
  is quoted in `src/core/directive.ts`: “Agents and strategies never interpret
  or execute directives; they only emit them.”
- [`Jido Action`](https://github.com/agentjido/jido_action/tree/d7940ea3ff51f2de605b3ff6c14fa25f05d3001a)
  informs the schema-in/schema-out Action terminology and timeout/retry concepts.

Both upstream projects use Apache-2.0 and identify:
**Copyright 2026 Mike Hostetler <mike.hostetler@gmail.com>**.
Unmodified upstream license copies are retained at
[licenses/JIDO-LICENSE](./licenses/JIDO-LICENSE) and
[licenses/JIDO-ACTION-LICENSE](./licenses/JIDO-ACTION-LICENSE), retrieved from
[Jido's pinned LICENSE](https://github.com/agentjido/jido/blob/84ae1389d818215df8524f8ef12cf6c8d1928d2f/LICENSE)
and [Jido Action's pinned LICENSE](https://github.com/agentjido/jido_action/blob/d7940ea3ff51f2de605b3ff6c14fa25f05d3001a/LICENSE).
The original working source revisions behind the initial Hibernaut implementation
were not recorded; these are verified attribution references, not claims of exact
historical provenance. Preserve the notices and review any additional copied code
before distributing adaptations.

## Direct npm dependencies

License identifiers below come from the installed package metadata. The complete
resolved graph and integrity hashes are in `package-lock.json`; dependencies are
installed, not vendored into this template. Their distributed LICENSE/NOTICE files
remain authoritative, including transitive dependencies.

| Package | Version | Declared license |
| --- | --- | --- |
| agents | 0.20.1 | MIT |
| effect | 3.22.1 | MIT |
| @cloudflare/vitest-pool-workers | 0.22.0 | MIT |
| @cloudflare/workers-types | 5.20260911.1 | MIT OR Apache-2.0 |
| typescript | 7.0.2 | Apache-2.0 |
| vitest | 4.1.11 | MIT |
| wrangler | 4.131.1 | MIT OR Apache-2.0 |

Sources: [Agents](https://github.com/cloudflare/agents),
[Effect](https://github.com/Effect-TS/effect),
[Workers SDK](https://github.com/cloudflare/workers-sdk),
[workerd / Workers types](https://github.com/cloudflare/workerd),
[TypeScript](https://github.com/microsoft/TypeScript),
[Vitest](https://github.com/vitest-dev/vitest).
Before redistributing a compiled bundle, include the applicable notices for its
actual bundled dependency graph; this direct-dependency table is not a bundle SBOM.

Cloudflare, Jido, BEAM/OTP and Effect names describe dependencies or inspiration;
no affiliation, endorsement, or upstream compatibility guarantee is claimed.
