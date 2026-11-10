# Development in parallel

- Before editing, use a dedicated worktree and a `codex/` branch for the chat.
  Reuse this chat's existing worktree when continuing its task; base independent
  work on the updated default branch. Never switch another chat's checkout.
  Prefer Codex's managed worktree tools and create the worktree before the first
  edit without asking for confirmation. Read-only investigation needs no worktree.
- Use `pnpm dev:instance info` to identify the instance, `pnpm dev:instance addon`
  to install its sandbox addon, and `pnpm dev:instance desktop` to preview it.
  State the worktree and command before implementation. Keep the generated window
  title visible so previews are identifiable.
- Development instances share completed chats, memory, panels, routine
  definitions and LLM connections/credentials through the repository's shared
  development profile. Active turns, engine sessions, routine execution, game
  connections, MCP credentials, ports, logs and native outputs stay per worktree.
  Never point ordinary development at the installed app's data or addon folders.
- Use the worktree's sandbox WoW target by default. In-game testing requires a
  dedicated WoW client directory for that worktree; do not run multiple development
  bridges against the same client. Preserve other chats' files and processes.
- Shared-profile schema changes must use Drizzle migrations. Restart instances
  after changing migrations; use a separate `WISP_SHARED_DATA_DIR` when testing
  incompatible persistence changes.
