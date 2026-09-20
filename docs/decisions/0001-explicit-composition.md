# ADR 0001: Explicit composition without a general plugin context

Status: accepted

## Context

The project needs replaceable model, tool, session, prompt, and host components while remaining small enough to study. A general plugin context would combine dependency discovery, event routing, configuration, lifecycle, and scoping before the agent loop itself is understood.

## Decision

Use typed capability interfaces and explicit constructor injection. Compose the complete runtime in `packages/runtime` or a host. Registries are immutable after startup in the initial implementation. Resource-owning components use explicit `start` and `stop` methods, with reverse-order cleanup after partial startup failure.

Use small, purpose-specific mechanisms: registries for keyed providers, around-middleware for operations that may be replaced or rejected, and failure-isolated observers for notifications.

## Consequences

Dependencies remain visible and ordinary TypeScript tests can construct every component. Runtime replacement requires building another composition rather than patching a live plugin tree. Hot reload and arbitrary plugin unloading are outside the initial scope. If future requirements demonstrate a need for dynamic composition, a later decision may add it without changing domain events or capability interfaces.

## Rejected alternatives

- Forking Cordis would shift the project toward framework maintenance before the agent lifecycle is implemented.
- A global service locator would hide dependencies and make scoped tests harder to construct.
- Direct imports of concrete adapters would make replacement require edits to core packages.
