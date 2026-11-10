# Parser modules

See [the parser contract](../../../docs/markdown.md) for the AST, dialects,
streaming semantics, bounds and validation commands. These files contain no WoW
API calls or presentation code.

`Block.lua`, `Inline.lua` and the linked-node design adapt the algorithms of
[commonmark.js 0.31.2](https://github.com/commonmark/commonmark.js/tree/0.31.2),
Copyright (c) 2014 John MacFarlane. Its BSD license and notices are retained in
[LICENSE-commonmark.txt](LICENSE-commonmark.txt).

`Data.lua` is generated from Unicode 16.0.0 `UnicodeData.txt` and
`CaseFolding.txt`; Copyright © 2001–2024 Unicode, Inc. The
[Unicode License v3](LICENSE-Unicode.txt) is included. The HTML named character
references are from WHATWG's authoritative
[entities.json](https://html.spec.whatwg.org/entities.json); see the
[WHATWG copyright terms](https://whatwg.org/ipr-policy#copyright).
Source URLs and SHA-256 checksums are pinned in
[the generator](../../../scripts/generate-markdown-data.ts).

Load order: Node, Data, Scanner, Inline, Extensions, Block, Parser, Stream.
Only `parse`, `parseInline`, `newStream` and the returned tree/walker contract
are public consumer APIs; implementation module tables are internal.
