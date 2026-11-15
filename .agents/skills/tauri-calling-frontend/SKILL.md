---
name: tauri-calling-frontend
description: Review Tauri 2 events and channels in Wisp desktop, including asynchronous listener cleanup, bridge status reads, progress reporting, and IPC tests.
---

# Wisp desktop Tauri events

Read the event producer in the native host and its consumer in the frontend before changing either. Preserve the payload shape, event name and target window together.

- Start at [the native host](../../../apps/desktop/src-tauri/src/main.rs), [the updater](../../../apps/desktop/src-tauri/src/updates.rs) and [the bridge lifecycle](../../../apps/desktop/src/bridge-lifecycle.ts).
- Use commands for request/response and a channel for a stream that belongs to a command invocation. Keep low-frequency notifications on events and use the narrowest window target that receives them.
- Set up listeners before the producer can emit a one-shot event. Release listeners when the component or desktop session unmounts. If an asynchronous registration resolves after cleanup, release it immediately. Use an explicit readiness handshake when a window must receive the first notification.
- Keep durable status available through an explicit read so late subscribers can recover. A settings write followed by a status read must wait for any earlier poll and then request a fresh snapshot.
- Test the observable UI or IPC behavior using controlled promises or Tauri mocks. Cover cleanup that happens before listener registration finishes and check that late events cannot update a disposed session. Use a worktree-isolated native instance for checks that depend on a real WebView or installer.

Use Tauri's documentation for the exact API and options. [Events and channels](https://v2.tauri.app/develop/calling-frontend/) · [Frontend mocks](https://v2.tauri.app/reference/javascript/api/namespacemocks/)
