# Wisp text grammar

The parser produces Wisp's semantic text tree, independently of native UI.
Load `Syntax.lua`, `Block.lua` and `Parser.lua` in that order.

The public API is `C.Markdown.parse` and `C.Markdown.parseInline`. The returned
tree uses `children` arrays. Internal module tables and the cooperative task
constructor are implementation details of the addon.

See [the product contract](../../../docs/markdown.md) for supported syntax,
resource bounds, scheduler integration and verification. This product profile
does not claim full CommonMark/GFM compatibility or include an HTML renderer.
