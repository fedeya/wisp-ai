# Markdown

`Syntax.lua`, `Block.lua` and `Parser.lua` produce Wisp's text tree without UI
dependencies. `Cache.lua` schedules and caches parsing, `InlineRenderer.lua`
formats text, and `ReplyView.lua` owns reply presentation and its state.

The parser API is `ns.Markdown.Parse` and `ns.Markdown.ParseInline`; its tree uses
`children` arrays. The other modules live under the same `ns.Markdown` namespace.
`TextStyle.lua` lays out the view's preformatted inline runs and decorations;
`Links.lua` validates and encodes copyable web links. Neither module parses source.
`MessageRows` and `RichUI` own the native widgets.

See [the contract](../../../docs/markdown.md) for syntax, API, limits and checks.
