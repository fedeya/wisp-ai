local helper = require("addon.tests.fixtures.markdown.support")
local markdown = helper.parser()

it("matches batch parsing across every small byte chunk size", function()
    local source =
        "# Guía 😀\r\n\r\n**Usá `a**b` y [[ref:s]]**.\n\n| Pieza | Estado |\n|---|---|\n| Toga | Equipada |\n| Capa | [x] |\n\n[x]: /later\n\n> - [x] Listo\n\n~~~lua\nlocal x = 'ñ'\n~~~"
    local options = { references = true }
    local expected = helper.html(assert(markdown.parse(source, options)))
    for width = 1, 19 do
        local stream = assert(markdown.newStream(options))
        for position = 1, #source, width do
            assert(stream:feed(source:sub(position, position + width - 1)))
            local snapshot = assert(stream:snapshot())
            assert.is_false(snapshot.complete)
            assert.equal(snapshot, stream:snapshot(), "unchanged previews reuse the cached tree")
        end
        local final = assert(stream:finish())
        assert.is_true(final.complete)
        assert.equal(expected, helper.html(final))
        assert.equal(source, stream:source())
        assert.equal(final, stream:finish())
        assert.equal(final, stream:snapshot())
        local accepted, err = stream:feed("extra")
        assert.is_nil(accepted)
        assert.equal("closed", err.code)
    end
end)

it("defers incomplete UTF-8 tails and preserves malformed input on completion", function()
    for _, value in ipairs({ "ñ", "你", "😀" }) do
        local stream = assert(markdown.newStream())
        assert(stream:feed("a"))
        for i = 1, #value - 1 do
            assert(stream:feed(value:sub(i, i)))
            assert.equal("<p>a</p>\n", helper.html(assert(stream:snapshot())))
        end
        assert(stream:feed(value:sub(-1)))
        assert.equal("<p>a" .. value .. "</p>\n", helper.html(assert(stream:finish())))
    end
    local stream = assert(markdown.newStream())
    assert(stream:feed("a\240\159"))
    assert.equal("<p>a</p>\n", helper.html(assert(stream:snapshot())))
    assert.equal("<p>a��</p>\n", helper.html(assert(stream:finish())))
    assert.equal("a\240\159", stream:source())
end)

it("keeps old snapshots independent when later input resolves references", function()
    local stream = assert(markdown.newStream())
    assert(stream:feed("[x]\n"))
    local first = assert(stream:snapshot())
    local before = helper.html(first)
    assert(stream:feed("\n[x]: /resolved"))
    assert.equal('<p><a href="/resolved">x</a></p>\n', helper.html(assert(stream:finish())))
    assert.equal(before, helper.html(first))
    assert.is_false(first.complete)
end)

it("grows a table through partial cells and retains surrounding prose", function()
    local stream = assert(markdown.newStream())
    assert(stream:feed("Before\n\n| A | B |\n|---|---|"))
    local snapshot = assert(stream:snapshot())
    assert.equal("paragraph", snapshot.firstChild.type)
    assert.equal("table", snapshot.lastChild.type)
    assert.is_nil(snapshot.lastChild.firstChild.next)
    assert(stream:feed("\n| par"))
    snapshot = assert(stream:snapshot())
    assert.equal("par", snapshot.lastChild.lastChild.firstChild.firstChild.firstChild.literal)
    assert(stream:feed("tial | cell |\n\nAfter"))
    local final = assert(stream:finish())
    assert.is_truthy(helper.html(final):find("<td>partial</td>", 1, true))
    assert.equal("After", final.lastChild.firstChild.literal)
end)

it("rejects over-budget chunks transactionally and copies its options", function()
    local options = { dialect = "commonmark", maxBytes = 4 }
    local stream = assert(markdown.newStream(options))
    options.dialect, options.maxBytes = "gfm", 100
    assert(stream:feed("**x"))
    local first = assert(stream:snapshot())
    local revision = stream.revision
    local accepted, err = stream:feed("large")
    assert.is_nil(accepted)
    assert.equal("max_bytes", err.code)
    assert.equal("**x", stream:source())
    assert.equal(revision, stream.revision)
    assert.equal(first, stream:snapshot())
    assert(stream:feed(""))
    assert.equal(revision, stream.revision)
    assert(stream:feed("*"))
    assert.equal("commonmark", assert(stream:finish()).dialect)
end)
