---
name: add-capability
description: Add or replace an Agent Harness Lab capability with its interface, implementation, composition, event impact, tests, and architecture checks. Use for model, storage, prompt, tool, lifecycle, or host capabilities; do not use for local refactors that introduce no capability seam.
---

# Add a capability

Read `AGENTS.md`, `packages/AGENTS.md`, and `docs/architecture.md` before editing.

Identify the capability owner, provider, and consumer. Put the interface in the consumer-facing core package, the external implementation under `packages/adapters`, and construction under `packages/runtime` or the relevant host. Do not add a registry until keyed selection is required.

Before implementation, determine whether the capability changes model-visible input or durable behavior. If it does, define or update session events and their projection first. Record a decision in `docs/decisions/` when the change alters dependency direction, event compatibility, lifecycle ownership, or a public capability interface.

Test the interface through a deterministic fake and test the adapter at its external boundary. Include failure and cancellation at each new await boundary. Run focused tests, then `pnpm run check`. Report the commands actually run and unresolved external integration risks.
