# Feature flags

[Development](development.md) · [Transport](transport.md) · [Lua guidelines](lua-guidelines.md)

Feature flags let unfinished work merge to `main` and ship in Nightly without
reaching Stable. A Stable release is a published Nightly rebuilt with a stable
version, so a flag can't be removed at build time: every build carries the
code, and the channel decides at runtime whether it runs.

## How a flag is resolved

The bridge is the only place flags are evaluated, through
[OpenFeature](https://openfeature.dev) (`@openfeature/web-sdk`, the static-context
SDK, because the bridge serves a single player and reads values synchronously).
Its provider, `ChannelFeatureProvider` in `apps/bridge/src/features.ts`, decides
each flag in this order:

1. The player's override, saved as `features` in the bridge config and changed
   under **Settings → Experimental** in the desktop app.
2. The flag's `channels` in the registry, for the evaluation context's channel.

The channel comes from `featureChannel` in `@wisp/protocol/features`:

| Build                                                      | Channel       |
| ---------------------------------------------------------- | ------------- |
| `pnpm start`, `pnpm desktop:dev`, any debug Tauri build    | `development` |
| Packaged build with a version like `0.4.1-nightly.120.1`   | `nightly`     |
| Packaged build with a version like `0.4.0` (or no version) | `stable`      |

The Tauri host sets `WISP_RELEASE_BUILD=1` only in release builds. The bridge
then publishes the resolved values to every other surface:

- **Desktop:** `Status.features`, mirrored into an OpenFeature provider in the webview.
- **Agent:** `features` in the capabilities file the agent already reads per turn.
- **Addon:** `features` in each snapshot.
- **Telemetry:** a `features` property listing the flags that are on.

## Add a flag

Register it in `packages/protocol/src/features.ts`:

```ts
export const featureFlags = {
  combat_coach: {
    name: 'Combat coach',
    description: 'Coaching tips during combat.',
    channels: ['development', 'nightly'],
  },
} as const satisfies FeatureRegistry;
```

Then check it where the feature lives. The name is typed from the registry,
so removing the flag makes every TypeScript check fail to compile; search the
addon for the name by hand.

| Surface | Check                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------- |
| Bridge  | `features.enabled('combat_coach')`                                                                      |
| Desktop | `useFeature('combat_coach')` (from `apps/desktop/src/features.tsx`)                                     |
| Agent   | `await featureEnabled('combat_coach')`                                                                  |
| Addon   | `ns.Core.FeatureEnabled("combat_coach")`, and `ns.Core.OnFeaturesChanged(listener)` to react to changes |

A tool that belongs to the feature goes in `toolFeatures` in
`packages/protocol/src/capabilities.ts` (`coach: 'combat_coach'`). While the flag
is off, the bridge leaves the tool out of the desktop and addon capability
lists and publishes it as disabled, so the agent never offers it.

Every flag is off until the bridge answers. In the addon that means at login:
code that decides at startup should also register `ns.Core.OnFeaturesChanged`
and check again, and everything behind a flag must work while it is off.

## Ship or remove a flag

When the feature is ready for Stable, delete its registry entry and its checks
in the same PR. Don't add `stable` to `channels`: a test rejects that, because a
flag that is on everywhere is dead configuration. Overrides saved for a removed
flag are ignored and dropped on the next save.

## What a flag can't hide

- **Database migrations and wire shapes** ship to everyone. Keep them
  compatible with the feature turned off.
- **Code that fails while loading** runs regardless of the flag. Check the flag
  before registering or starting the feature, not inside it.
