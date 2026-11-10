# Wisp Markdown

Wisp's Lua 5.1 text grammar lives in `addon/WispAI/Markdown/`. It produces a small
semantic tree; native fonts, reference lookup, widget layout and timing belong to
the addon presentation layer. Source text remains canonical.

This is a product profile, not a general Markdown converter or a claim of full
CommonMark/GFM compatibility. The implementation uses its own array-based tree,
block records and inline span reduction. It includes no HTML renderer,
third-party parser runtime, generated Unicode database or document exporters.

## API

```lua
local document, err = C.Markdown.parse(source, { references = true })
local label, labelError = C.Markdown.parseInline(source, { references = true })
```

`parse` handles a document. `parseInline` handles a native UI label, preserving
leading and trailing whitespace. Each call owns its tree and reference definitions.
The parser has no global document state. The public surface consists of these
two functions and the returned node fields.

Supported options are `references` (boolean, default false), `maxBytes` (default
65,536), `maxNodes` (default 20,000) and `maxNesting` (default 64). Bounds accept
positive integers. Unknown options, including the removed `dialect` option,
return `invalid_option`. There is one Wisp profile and no public streaming wrapper.

Input CRLF and CR normalize to LF. NUL and malformed UTF-8 become U+FFFD.
The caller keeps the original source bytes. Block `sourcepos` fields contain
inclusive one-based line/column pairs. Container records preserve original line
numbers after quote/list prefixes are removed; tabs advance to four-column stops.

## Product syntax

- Paragraphs, ATX and Setext headings, thematic breaks and soft/hard line breaks.
- Bullet and ordered lists, nested lists, task checkboxes and block quotes.
- Fenced backtick/tilde code and indented code; inline code is opaque.
- Emphasis, strong emphasis and double-tilde strikethrough.
- Inline links with balanced destinations, angle destinations, optional titles,
  reference links and image alt text. Link definitions are collected before
  resolving inline content. Native UI decides whether a destination is actionable.
- Pipe tables, including one-column/header-only tables and tables in containers.
  Short rows are padded; extra cells are ignored. Escaped pipes remain cell text,
  including inside inline code.
- Optional Wisp `[[ref:key]]` leaves with exact ASCII keys. A trailing incomplete
  token becomes `reference_pending` outside code; the renderer decides its preview.
- Native WoW hyperlinks outside code become opaque `native_link` leaves, including
  named or hexadecimal quality colors. Presentation permits their markup only for
  user messages; assistant-supplied native markup remains escaped text.
- Raw HTML-looking tags remain literal text nodes. No HTML is executed, interpreted
  into widgets, loaded or fetched.

Supported character references are `amp`, `lt`, `gt`, `quot`, `apos`, `nbsp` and
numeric Unicode references. Other named references stay literal. Ordinary Markdown
reference labels collapse ASCII whitespace and fold ASCII/common accented Latin
letters; this profile does not provide full Unicode case folding or normalization.
Bare URL/email text remains ordinary text; explicit links and angle URLs are parsed.
Footnotes, math, inline attributes, smart typography and external image rendering
are outside the profile.

## Tree

Every node has `type` and an array `children`. Leaves use `literal` or `key`.
There are no parent/sibling pointers, mutation helpers or public walker class.

| Node                                               | Fields                                                        |
| -------------------------------------------------- | ------------------------------------------------------------- |
| `document`, `paragraph`, `block_quote`             | `children`                                                    |
| `heading`                                          | `level`, inline `children`                                    |
| `list`                                             | `ordered`, optional `start`, `tight`; `item` children         |
| `item`                                             | Block `children`; optional boolean `checked` for tasks        |
| `code_block`                                       | Opaque `literal` and `info`                                   |
| `thematic_break`, `softbreak`, `linebreak`         | No text payload                                               |
| `text`, `code`, `html_inline`, `reference_pending` | `literal`                                                     |
| `emph`, `strong`, `strikethrough`                  | Inline `children`                                             |
| `link`, `image`                                    | `destination`, `title`, inline `children`                     |
| `reference`                                        | Exact `key` and original `literal`                            |
| `native_link`                                      | Opaque native hyperlink `literal`; presentation decides trust |
| `table`                                            | `align` array; direct `table_row` children                    |
| `table_row`                                        | Boolean `header`; `table_cell` children                       |
| `table_cell`                                       | Boolean `header`, optional `align`, inline `children`         |

Returned trees contain no parser scratch fields and should be treated as read-only.
Presentation limits, pagination and truncation do not modify the syntax tree or
canonical source.

## Execution and errors

Parsing is deterministic and synchronous by default. It returns `nil, err` for
invalid arguments or resource limits, never a partially parsed document. Errors
include `invalid_source`, `invalid_options`, `invalid_option`,
`invalid_references`, `invalid_limit`, `max_bytes`, `max_nodes` and `max_nesting`.
Programming errors propagate.

The internal `_newTask(source, options, inline)` coroutine lets the UI scheduler
spread work across frames. It yields after bounded groups of Lua scanning,
allocation and tree work. The caller uses `coroutine.resume`; a completed task
returns `document, err`. Resource errors thrown inside a suspended parse retain
a private `markdownLimit` marker for the scheduler to translate. Native pattern
searches, concatenation, allocations and garbage collection cannot be preempted,
so this is cooperative scheduling rather than a guaranteed frame-time deadline.
It is not an append-only or incremental Markdown parser.

## Validation

```sh
pnpm test:addon
busted addon/tests/markdown-parser_spec.lua addon/tests/markdown-task_spec.lua addon/tests/wisp-block_spec.lua
```

Tests cover the supported product syntax, independent documents, byte handling,
structured limits, nested containers, source positions, late definitions,
500 deterministic mixed-input cases, and equivalence between synchronous and
cooperative execution. These focused tests replace the former general-purpose
standards corpus; they do not claim complete CommonMark/GFM conformance.
