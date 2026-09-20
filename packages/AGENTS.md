# Package instructions

Each package has one primary responsibility and publishes the smallest interface needed by its consumers.

## Dependency direction

Allowed dependency direction is:

```text
hosts -> runtime -> agent/tools/model/session -> domain
                  -> adapters -> capability-owning package -> domain
test-support -> any package used by tests
```

`domain` has no workspace dependencies. Capability-owning packages must not import adapters or hosts. Adapters must not import runtime or hosts. Runtime and hosts are the only composition roots.

Run `pnpm run gate:architecture` after adding or changing workspace dependencies. The gate is authoritative for the mechanically checkable portion of this rule.

## Public APIs

- Export domain vocabulary and capability interfaces deliberately from each package entrypoint.
- Keep implementation helpers private unless a real external consumer exists.
- Use discriminated unions and exhaustive switches for closed state and event sets.
- Use branded strings for session, message, turn, tool-call, and attempt identities.
- Every asynchronous operation that may block accepts or owns an `AbortSignal`.

## Tests

- Test observable behavior and failure settlement, not private method structure.
- Use deterministic model and tool fakes; unit tests must not call real model APIs.
- For event-driven behavior, assert the committed event sequence and derived model request.
- Cover cancellation at await boundaries introduced by the change.
