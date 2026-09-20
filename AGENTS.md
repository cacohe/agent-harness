# AGENTS.md

Agent Harness Lab is a production-oriented learning implementation of an agent harness. Keep the implementation small enough to understand while preserving the failure, cancellation, persistence, and replacement seams that make an agent runtime reliable.

## Required workflow

- Read `docs/architecture.md` before changing runtime code.
- Record material architecture decisions in `docs/decisions/` before or with the implementation.
- Use one Git worktree per coding or review agent. Coding and review must be performed by different agents.
- Human owners decide architecture. Agents may implement an accepted decision, identify missing decisions, and present concrete options; they must not silently choose a materially different architecture.
- Run `pnpm run check` before handing off a change. Report the exact commands run.

## Engineering rules

- TypeScript, ESM, Node.js 24, and `strict: true` are mandatory.
- Dependencies are explicit constructor or function parameters. Do not introduce a service locator or process-global runtime.
- Model-visible state is reconstructed from the append-only session event log.
- Domain code imports no runtime, adapter, host, filesystem, network, process, or model SDK module.
- Core packages depend on capability interfaces, never concrete adapters.
- Adapters translate external systems into core capability interfaces.
- Hosts compose the runtime and own process lifecycle.
- Every started turn and step must settle exactly once, including cancellation and failure paths.
- Streaming notifications are transient. Durable assistant settlements are session events.
- Validate untrusted data at configuration, storage, process, tool JSON, and wire boundaries.
- Avoid speculative abstractions. Add a seam when at least two implementations exist or the external boundary already varies.
- Files end with exactly one newline. Formatting, dependency direction, package metadata, type checking, and tests are executable gates under `scripts/` or package scripts.

## Repository map

```text
docs/                 Architecture and decisions
packages/domain/      Pure identifiers, events, messages, and errors
packages/session/     Event log, projections, and persistence interfaces
packages/model/       Model provider interfaces and stream vocabulary
packages/tools/       Tool definitions, registry, and scheduling
packages/agent/       Inbox and agent state machine
packages/runtime/     Explicit composition and lifecycle
packages/adapters/    External implementations
packages/hosts/       CLI, JSON-RPC, HTTP, and other process entrypoints
packages/test-support/ Deterministic fakes and fixtures
scripts/              Executable repository gates
.agents/skills/       Reusable repository workflows
```

More specific `AGENTS.md` files apply inside their directories.
