# Markdown parser

Wisp's Lua 5.1 parser lives in `addon/WispAI/Markdown/`. It produces a semantic
tree and has no dependency on WoW, fonts, widgets, HTML rendering, transport or
the bridge. The addon's TOC loads its modules in dependency order.

The parser and presentation layer have separate contracts. A renderer consumes
the tree and chooses typography, layout and link interaction. It must not parse
Markdown again or alter the canonical message. The renderer proposed in PR #32
will need to consume this API; this parser does not preserve that PR's earlier
`blocks`, `inline`, `format` or `render` interfaces.

## Parsing

```lua
local document, err = C.Markdown.parse(source, {
    dialect = "gfm", -- default; use "commonmark" for the core grammar
    references = true, -- opt in to Wisp's [[ref:key]] inline leaf
})
if not document then
    -- err.code identifies an invalid argument or an exhausted resource limit.
    return
end

for node, entering in document:walker() do
    -- Containers are visited on entry and exit; leaves are visited once.
end
```

`parseInline(source, options)` returns a paragraph node containing inline
children, preserving the supplied leading and trailing whitespace. Reference
definitions belong to a complete document parse: consumers should use the
already-resolved inline children of its paragraphs, headings and table cells.

Each parse owns its tree and reference map. Nodes expose `type`, `parent`,
`firstChild`, `lastChild`, `next` and `prev`. Absent links are `nil`. Consumers
should treat returned trees as read-only. Walking is iterative and supports
deep inline nesting without a recursive Lua call stack.

Block `sourcepos` values contain inclusive `{ { startLine, startColumn },
{ endLine, endColumn } }` coordinates. Lines are one-based; columns count UTF-8
bytes in normalized input, not display width. CRLF and CR normalize to LF;
NUL and malformed UTF-8 normalize to U+FFFD. Empty documents can end at column
zero. Inline leaves do not promise source ranges.

### Node types

| Types | Additional fields |
| --- | --- |
| `document`, `paragraph`, `block_quote`, `item` | Children; task items have `task = true` and boolean `checked` |
| `heading` | `level` from 1 through 6; inline children |
| `list` | `listType` (`bullet` or `ordered`), `listTight`; ordered lists also have `listStart` and `listDelimiter` |
| `code_block` | Literal `literal` text, including its final newline; fenced blocks also have unescaped `info` |
| `html_block`, `html_inline` | Opaque `literal` source; no execution or presentation |
| `thematic_break`, `softbreak`, `linebreak` | No text payload |
| `text`, `code` | `literal` text; code preserves its contents without entity, escape or reference processing |
| `emph`, `strong`, `strikethrough` | Inline children |
| `link`, `image` | `destination`, `title` and inline children; destinations have URI escaping applied |
| `reference` | Wisp `key` and exact `literal` token; emitted only when enabled |
| `table` | `align`: an array of `left`, `center`, `right` or `false`; a `table_head` followed by an optional `table_body` |
| `table_head`, `table_body` | `table_row` children |
| `table_row` | `table_cell` children |
| `table_cell` | Inline children, boolean `header`, optional `align` |

Table grammar is independent of presentation limits: empty headers,
single-column tables, zero body rows and arbitrary widths are valid. Short rows
are padded and extra cells are ignored as specified by GFM. Escaped pipes are
handled before inline parsing, including inside code spans. Renderers own
pagination, clipping or other display budgets; those do not rewrite the source.

Raw HTML remains an opaque syntax node. A renderer chooses whether to show,
omit or otherwise present it; the parser does not interpret HTML or provide
widgets. The HTML writer under test fixtures exists only to compare syntax
with the standards' HTML examples.

## Streaming

```lua
local stream, err = C.Markdown.newStream({ references = true })
local accepted, feedError = stream:feed(chunk)
local preview, previewError = stream:snapshot()
local final, finalError = stream:finish()
```

Chunks may split any UTF-8 code point or Markdown token. Snapshots defer a
potentially valid incomplete UTF-8 tail; `finish()` handles a malformed final
tail like ordinary batch parsing. `source()` retains the original bytes.

Snapshots are complete parses of the available prefix, with `complete = false`.
Later chunks may change earlier structure (a table delimiter or a late link
definition, for example). Previous snapshots are not mutated. Unchanged
snapshots reuse their cached tree; `finish()` returns an independently parsed
tree with `complete = true` and is idempotent. Feeding a finished stream returns
`closed`. There is no renderer, clock, refresh cadence or append-only tree
assumption in the parser.

## Bounds and errors

Defaults are 1 MiB of input, 100,000 allocated nodes and 256 levels of container
block or link-destination parenthesis nesting. Override them with positive
integer `maxBytes`, `maxNodes` and `maxNesting` options. Inline traversal is
iterative. Node limits include
temporary nodes used while resolving delimiters. Exceeding a bound returns
`nil, { code = ... }`, never a silently truncated document. Rejected stream
chunks leave its source, revision and previous preview unchanged.

Errors include `invalid_source`, `invalid_options`, `invalid_dialect`,
`invalid_references`, `invalid_limit`, `max_bytes`, `max_nodes`, `max_nesting`
and `closed`. Programming errors are not swallowed as parse failures.

## Design and validation

The core follows the [CommonMark parsing strategy](https://spec.commonmark.org/0.31.2/#appendix-a-parsing-strategy)
and the architecture of [commonmark.js 0.31.2](https://github.com/commonmark/commonmark.js/tree/0.31.2):
container-block continuation and lazy paragraphs first, then separate bracket
and delimiter stacks with flanking rules and the rule of three. Link
definitions are collected before inline resolution. This keeps code and link
destinations atomic while processing emphasis.

The GFM profile adds pipe tables, task items, strikethrough and extended
autolinks. Footnotes, math and smart typography are outside this contract.
Unicode 16.0 classification and full case-folding tables, plus the authoritative
HTML named entities, are bundled as generated Lua data. Grammar character
classes are explicit ASCII and do not depend on the host locale.

Validation uses real Lua 5.1 through Busted:

```sh
pnpm test:addon
busted addon/tests/markdown-conformance_spec.lua
busted addon/tests/markdown-parser_spec.lua addon/tests/markdown-stream_spec.lua
```

The corpus contains all 652 CommonMark 0.31.2 examples, all 28 published GFM
extension examples and 27 additional applicable cmark-gfm regressions. Tests
also cover Wisp references, API errors, tree invariants, byte-level streaming,
Unicode boundaries, 1,200 deterministic fuzz inputs and adversarial inputs.
HTML comparison normalizes equivalent checkbox attribute ordering and void-tag
spelling. One upstream crash-only regression intentionally has no HTML oracle.

Backtick runs are indexed once. Emphasis resolution defers delimiter-string
reconstruction, bracket deactivation skips image openers, and URL/HTML scans
cache bounds instead of rescanning suffixes. Large plain lines use explicit
newline search rather than a backtracking pattern.

Regenerate pinned data and fixtures with the repository's Node toolchain:

```sh
node scripts/generate-markdown-data.ts
node scripts/generate-markdown-spec.ts
```

Each generator also accepts a directory of previously downloaded source files
as its first argument. Content checksums are verified before writing. Changes
to upstream sources require explicit checksum and corpus review. Standards
fixtures and data attributions live beside their generated files.
