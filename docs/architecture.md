# Architecture

Agent Harness Lab uses an append-only session event log and an explicit agent state machine. The runtime composes capability interfaces with concrete adapters; core packages never discover dependencies through a global context.

## Dependency layers

`domain` defines stable value types and events. `session`, `model`, `tools`, and `agent` own core behavior and capability interfaces. `adapters` implement external storage, model, tool, and process integrations. `runtime` validates and composes a complete application. `hosts` expose that application over a process protocol.

Dependencies point inward. A model provider implements the interface owned by `model`; a session store implements the interface owned by `session`. The agent loop depends only on those interfaces.

## Execution model

A turn contains zero or more steps. A step assembles a prompt and visible tool schemas, prepares a model call, commits admitted input, streams one assistant attempt, commits its settlement, executes tool calls, and records results before another request is derived.

```text
input -> turn/start -> step/start -> model stream -> assistant settlement
                                      |                   |
                                      +------ tool calls -+
                                               |
                                         tool results
                                               |
                                         next step or
                                      step/end -> turn/end
```

The loop has one active activity per agent. Cancellation uses `AbortSignal`. Every opened turn and step settles exactly once. A failure to persist a model-visible fact stops execution before another model request.

## Session log

The session event log is the source of truth for model-visible history, replay, resume, audit, and UI reconstruction. Transient stream chunks are emitted to observers; a completed, interrupted, or failed assistant attempt is committed as one durable event.

Session storage has a single writer per session identity. Event sequence numbers are monotonic. Storage implementations validate persisted input and expose explicit `flush` and `close` operations.

## Replacement seams

The initial replacement seams are model providers, session persistence, prompt assembly, tool definitions, tool execution policy, identifiers, time, logging, and host protocol. Each seam consists of an interface owned by its consumer-facing core package, at least one implementation, and a composition point in `runtime` or a host.

Interception is intentionally limited. Around-middleware exists only for model request preparation and tool execution. Status, stream, and log notifications use failure-isolated observers that cannot veto lifecycle progress.

## Lifecycle

Components expose explicit `start` and `stop` operations where they own resources. Runtime startup is ordered; partial startup failure stops successfully started components in reverse order. Shutdown stops admission, cancels or drains active work according to host policy, flushes session writers, and then releases external resources.
