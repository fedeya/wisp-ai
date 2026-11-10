# Markdown

Replies are parsed in Lua. The parser produces a syntax tree; the addon controls
fonts, layout and native links. Stored Markdown is preserved.

## Supported syntax

- Paragraphs, headings, lists, tasks and quotes.
- Emphasis, bold, strikethrough and code.
- Links, image alt text and pipe tables.
- Wisp references: `[[ref:key]]`.

HTML is displayed as literal text. Images show their alt text.

## Parser API

```lua
local document, err = C.Markdown.parse(source, { references = true })
local label, err = C.Markdown.parseInline(source, { references = true })
```

`parse` handles a document; `parseInline` handles a UI label. Wisp references
are enabled with `references = true`. Failures return `nil` and an error with
`err.code`.

Optional `maxBytes`, `maxNodes` and `maxNesting` limits default to 65,536 bytes,
20,000 nodes and 64 nesting levels. Limits accept positive integers.

Nodes have `type` and a `children` array. Text and code use `literal`; references
use `key`. Block `sourcepos` contains start/end line and column pairs. Treat
returned trees as read-only.

## Checks

```sh
pnpm test:addon
```
