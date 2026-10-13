# Agent Harness Lab

> A TypeScript reference implementation for durable, bounded, observable agent execution.

Agent Harness Lab is not a prompt wrapper or a multi-tenant Agent SaaS. It treats append-only session events as the source of truth for model-visible history and recovery, runs turns and steps through an explicit state machine, and composes models, tools, Skills, Memory, and storage through capability protocols.

[Chinese README](README.md) · [Architecture](docs/architecture.md) · [Diagrams](docs/diagrams.md) · [Decisions](docs/decisions/) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## What it demonstrates

- Durable turn and step facts, lifecycle validation, and interrupted-session repair.
- FIFO single-session scheduling with cancellation, idempotent submissions, and exact terminal settlement.
- Independent limits for a turn, a model attempt, a tool call, tool payloads, and queued inputs.
- Explicit capability boundaries for JSONL, model providers, MCP, Skills, Memory, Platform adapters, and local tools.
- Minimal dependency direction: `hosts → runtime → core → kernel`, with adapters depending only on `kernel`.

## Zero-key demo

```bash
pnpm install
pnpm demo
```

The deterministic demo builds the workspace and executes a two-step agent turn: a model tool call, a local fake tool, persisted tool completion, and a final model response. It requires neither an API key nor a network model provider.

## Quick start with a model provider

Requirements: Node.js 24+ and the pnpm version declared in `package.json`.

```bash
cp examples/cli/.env.example examples/cli/.env
# Add DEEPSEEK_API_KEY to examples/cli/.env
pnpm run build
pnpm agent run --session demo-1 --message "Introduce yourself"
```

For a local browser UI:

```bash
cp examples/web/.env.example examples/web/.env
pnpm web
```

The Web Host binds only to `127.0.0.1`; the browser never receives the model API key.

## Boundaries

- JSONL is a single-writer, single-instance session store, not shared storage for multiple processes or services.
- The Web Host is a loopback-only local UI, not a remote or multi-user service.
- `run_shell` is disabled by default and is not sandboxed when enabled.
- Filesystem Skills rely on Linux path-safety semantics; use WSL on Windows.
- This is a production-oriented reference implementation, not a certified, highly available, multi-tenant product.

## Development

```bash
pnpm run check
```

Changes are submitted through feature branches and pull requests. See [CONTRIBUTING.md](CONTRIBUTING.md) for details. The repository is licensed under [Apache-2.0](LICENSE).
