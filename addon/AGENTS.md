# Addon work

Read and follow [the Lua guidelines](../docs/lua-guidelines.md) before changing
production Lua or its fixtures. The [module map](README.md),
[transport contract](../docs/transport.md) and
[Markdown contract](../docs/markdown.md) describe subsystem ownership.

Update `WispAI/WispAI.toc` when adding or moving source files. Keep runtime Lua
5.1-compatible, use the private `ns` subsystem APIs, and preserve the narrow
public WoW entry points.

Run `pnpm lint:addon`, `pnpm format:check` and `pnpm test:addon` for addon changes,
plus the relevant `tests/addon/` integrations for wire or host/addon changes.
Use isolated mocks and temporary data; do not deploy to the installed addon or
run live game/provider diagnostics as part of routine offline verification.
