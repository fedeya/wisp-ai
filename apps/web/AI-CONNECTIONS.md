# AI connection copy

The website presents Wisp as an AI companion for WoW, independent of the model
provider. ChatGPT and Grok account sign-in are options alongside API connections
and compatible/local endpoints, not a prerequisite for every user.

Implementation references:

- `packages/protocol/src/providers.ts`: registered provider definitions and models.
- `apps/agent/src/providers.ts`: native provider adapter dispatch.
- `apps/desktop/src/routes/Connections.tsx`: desktop connection settings and model selection.
- `apps/desktop/src/components/connections/ConnectionEditor.tsx`: API/local connection forms,
  model discovery, exact IDs, context windows, testing and saving.
- `docs/usage.md`: current setup, billing, tools and connection limits.

Keep both language versions consistent across requirements, FAQ, privacy,
metadata and Features. Setup documents account sign-in for ChatGPT and Grok,
API connections and compatible/local servers, plus model tool-calling/context
requirements, provider billing and the potentially billable Test first model
operation.

Marketing examples name a few supported adapters without claiming universal
model compatibility or that every external account has been tested. Wowhead web
search is not presented as requiring a ChatGPT connection.
No API key entry or provider credentials are collected by the website. Actual
configuration and model selection happen in the desktop app and in-game chat.
