# Public addon API

Other addons can put a "Review this with Wisp" button on their own UI. Clicking it
opens Wisp's quick-question popup with your prompt and data attached. The player
sees what is attached, edits the prompt if they want, and presses Enter. Wisp never
sends anything on another addon's behalf.

That is the whole API: Wisp gives you a way into its chat, and you write what goes
in it. Wisp adds no text or translations of its own, so localize your prompt and
label yourself. The API does not read replies, conversations, memory or chat
history, register tools, or run game actions.

## Lua surface

The only global is `WispAI`. Everything else stays in Wisp's private namespace.

```lua
WispAI.API_VERSION -- 1

-- True when Wisp can take a question now: the bridge is connected and Wisp
-- Desktop needs no setup. Use it to enable or grey out your button.
WispAI.IsAvailable() --> boolean

-- Opens the quick-question popup prefilled. Never sends.
WispAI.Ask(request) --> true | false, reason
```

`request` fields (limits are in bytes):

| Field        | Type   | Required | Limit | Meaning                                                               |
| ------------ | ------ | -------- | ----- | --------------------------------------------------------------------- |
| `source`     | string | yes      | 40    | Your addon's name, shown to the player and passed to the model.       |
| `prompt`     | string | yes      | 500   | Text placed in the input box.                                         |
| `title`      | string | no       | 60    | Popup header after "Ask Wisp ·". Default: `source`.                   |
| `link`       | string | no       | 255   | One game hyperlink (item, spell, quest, unit), sent as the reference. |
| `attachment` | table  | no       | —     | `{ label = string, text = string }`; `label` ≤ 60, `text` ≤ 4000.     |

`false` comes with one of these reasons, and nothing changes in Wisp's UI:

| Reason            | When                                                                         |
| ----------------- | ---------------------------------------------------------------------------- |
| `unavailable`     | Wisp is not connected to Wisp Desktop, or Desktop needs setup.               |
| `invalid_request` | A field has the wrong type or is over its limit, or a required one is empty. |
| `busy`            | The popup is answering a question, or the player typed their own text.       |
| `throttled`       | Another `Ask` was accepted less than a second ago (from any addon).          |

Fields over their limit are rejected rather than cut, because a truncated log would
mislead the model. Trim your data before calling.

## Example

Add `## OptionalDeps: WispAI` to your TOC so Wisp loads first when installed.

```lua
local function reviewWithWisp()
    if not (WispAI and (WispAI.API_VERSION or 0) >= 1) then
        return
    end
    local ok, reason = WispAI.Ask({
        source = "MyMeter",
        prompt = "Review my last fight. What should I change?",
        attachment = { label = "Last fight", text = MyMeter:ExportPlainText(4000) },
    })
    if not ok and reason == "unavailable" then
        print("Open Wisp Desktop to ask Wisp.")
    end
end
```

## What the player sees

- The popup opens at the cursor with your prompt in the input box and focus in it.
- An attachment shows as a chip under the title, e.g. `MyMeter · Last fight · 2.1 KB`.
  Hovering it previews the first lines; its `x` removes the attachment.
- After sending, the question shows the same `MyMeter · Last fight` line under it.
  The attachment goes with the first question only; follow-ups in the same popup
  rely on the conversation history.
- Hovering something in the game and pressing the Wisp key replaces your request,
  like any new reference.

Display strings (`source`, `title`, `prompt`, `label`) lose WoW escape sequences
(colors, textures, hyperlinks) and line breaks. Attachment text keeps its
characters, including `|`, because it is data for the model; only `\r` and control
characters other than tab and newline are dropped.

## How it is built

- `addon/WispAI/Core.lua` defines the `WispAI` global and delegates to
  `addon/WispAI/Api/Api.lua`, which validates, cleans and throttles requests.
- `ns.Inline.OpenRequest` in `addon/WispAI/Inline/Inline.lua` fills the popup and
  draws the chip. `SendInline` adds `attachment` to the `inline_say` packet.
- `addonAttachment` in `packages/protocol/src/protocol.ts` bounds the field on the
  wire. The bridge stores it on the user message, so a retry sends it again, and
  projects only `source` and `label` back to the addon.
- `turnInput` in `apps/bridge/src/chat/context.ts` adds it as an
  `<addon_attachment>` block before `<user_message>`. JSON escaping keeps the text
  from closing the block, and the agent instructions treat it as untrusted data
  that never overrides the player, the game context or tool results.

Changes stay backward compatible: new fields are optional, and `API_VERSION` only
increases for a breaking change.
