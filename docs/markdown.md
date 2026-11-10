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

## Rendering

Prose, tables and UI labels share the same formatter. Syntax is cached separately
from layout and reference data; long responses are processed across frames.

Reply presentation uses the cached parser's tree and the shared inline formatter.
The formatter can also emit preformatted runs for inline code and strike-through;
layout and decoration do not parse Markdown again or change cached syntax.
Headings and emphasis retain the game typeface, while code uses JetBrains Mono
with a localized game-font fallback. Web links expose their URL on hover and
open a selectable copy dialog on click.
Inline layout keeps at most 256 extra font strings per reply host; dense content
falls back to the complete shared formatter output instead of growing widgets
without a bound.

Tables show 20 rows per page, up to 6 columns and 200 rows per table. Notices
identify clipped content.

## Checks

```sh
pnpm test:addon
lua addon/tests/benchmarks/markdown.lua
```
