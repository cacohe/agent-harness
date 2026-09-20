# Documentation instructions

- `architecture.md` describes the current architecture and dependency direction.
- `decisions/` records accepted architecture decisions. Do not rewrite an accepted decision; add a successor that marks it superseded.
- Decision records state context, decision, consequences, and rejected alternatives without conversation history.
- Update documentation in the same change as the behavior it describes.
- Keep prose focused on behavior, ownership, failure, timing, and replacement seams.
- Run `pnpm run gate:docs` after documentation changes.
