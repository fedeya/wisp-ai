local helper = require("addon.tests.support")

local function setup()
    local env = helper.env()
    helper.fixture("addon/tests/wow-ui-stub.lua", env)
    env.C = {}
    helper.addon("UI.lua", env)
    helper.addon("RichUI.lua", env)
    return env, env.C
end

it(
    "native tables wrap, stack on narrow windows, preserve reference hover and reuse cells",
    function()
        local env = helper.env()
        setfenv(1, env)
        helper.fixture("addon/tests/wow-ui-stub.lua", env)
        C = {}
        helper.addon("UI.lua", env)
        helper.addon("RichUI.lua", env)

        local host = CreateFrame("Frame")
        local node = {
            id = "gear",
            kind = "table",
            title = "Equipo actual",
            columns = {
                { label = "Pieza" },
                { label = "Estado" },
                {
                    label = "Armadura",
                    align = "right",
                },
            },
            rows = {
                { "[[ref:robe]]", "Equipada", "12" },
                { "[[ref:spell]]", string.rep("Explicación larga ", 8), "0" },
            },
        }
        local message = {
            ui = { node },
            references = {
                robe = { kind = "item", id = 100, label = "Toga" },
                spell = { kind = "spell", id = 122, label = "Nova" },
            },
        }
        C.RenderRichUI(host, {}, message, 600)
        local w = host.widgets.gear
        local header, first, second = w.tableRows[1], w.tableRows[2], w.tableRows[3]
        assert(header:IsShown() and header.cells[1]:GetText() == "Pieza")
        assert(first.cells[1]:GetText():find("|Hitem:100|h[Toga]|h", 1, true))
        assert(first.cells[3].point[4] > first.cells[2].point[4])
        assert(
            second:GetHeight() >= second.cells[2]:GetStringHeight() + 20,
            "row height follows wrapped text"
        )
        for _, pair in ipairs({ { first, "item:100" }, { second, "spell:122" } }) do
            local row, link = pair[1], pair[2]
            assert(row.mouseEnabled and row.hyperlinksEnabled)
            row.scripts.OnHyperlinkEnter(row, link, "[Reference]")
            assert(GameTooltip:IsShown() and UI_TEST.tooltipLink == link)
            row.scripts.OnHyperlinkLeave(row)
            assert(not GameTooltip:IsShown())
        end
        local count, wideHeight = #UI_TEST.widgets, first:GetHeight()
        C.RenderRichUI(host, {}, message, 210)
        assert(#UI_TEST.widgets == count, "resize reuses all rows and cells")
        assert(not header:IsShown() and first.labels[1]:IsShown())
        assert(first.labels[1]:GetText() == "Pieza" and first.labels[2]:GetText() == "Estado")
        assert(first.cells[2].point[5] < first.cells[1].point[5] - first.cells[1]:GetStringHeight())
        assert(first:GetHeight() > wideHeight)
        node.columns[3] = nil
        node.rows[1][3] = nil
        node.rows[2] = nil
        C.RenderRichUI(host, {}, message, 600)
        assert(header:IsShown() and not second:IsShown())
        assert(not first.cells[3]:IsShown() and not first.labels[1]:IsShown())
        assert(first.cells[1]:GetParent() == first and first.scripts.OnHyperlinkClick)
        message.parts =
            { { type = "text", text = "Usá [[ref:spell]]." }, { type = "ui", id = "gear" } }
        C.RenderRichUI(host, {}, message, 600)
        local owner = host.prose[1]:GetParent()
        assert(
            owner.hyperlinksEnabled and owner.scripts.OnHyperlinkEnter,
            "surrounding prose stays interactive"
        )
    end
)

it(
    "paginates Markdown rows locally and reuses twenty native rows across resize and shrink",
    function()
        local env, C = setup()
        local all, first = {}, {}
        for index = 1, 25 do
            local values = {
                "|Hitem:" .. (100 + index) .. "|h[Item " .. index .. "]|h",
                "Row " .. index,
            }
            all[index] = values
            if index <= 20 then
                first[index] = values
            end
        end
        local node = {
            id = "gear",
            kind = "table",
            _markdown = true,
            columns = { { label = "Item" }, { label = "State" } },
            rows = first,
            _markdownRows = all,
            totalRows = 25,
        }
        local message =
            { _markdown = true, ui = { node }, parts = { { type = "ui", id = "gear" } } }
        local invalidations = 0
        C.Markdown.ReplyView = {
            invalidate = function()
                invalidations = invalidations + 1
            end,
        }
        local originalFormatter = C.FormatText
        C.FormatText = function()
            error("projected cells must not be parsed again")
        end
        local host = env.CreateFrame("Frame")
        C.RenderRichUI(host, {}, message, 600)
        local tableWidget = host.widgets.gear
        local firstRow = tableWidget.tableRows[2]
        assert.equal(21, #tableWidget.tableRows)
        assert.equal("Row 1", firstRow.cells[2]:GetText())
        assert.equal("1-20 / 25", tableWidget.pagerLabel:GetText())
        assert.is_false(tableWidget.pagerPrev.enabled)
        assert.is_true(tableWidget.pagerNext.enabled)
        local count = #env.UI_TEST.widgets
        tableWidget.pagerNext.scripts.OnClick()
        assert.equal(1, invalidations)
        C.RenderRichUI(host, {}, message, 600)
        assert.equal(2, tableWidget.page)
        assert.equal(firstRow, tableWidget.tableRows[2])
        assert.equal("Row 21", firstRow.cells[2]:GetText())
        assert.equal("21-25 / 25", tableWidget.pagerLabel:GetText())
        assert.is_true(tableWidget.pagerPrev.enabled)
        assert.is_false(tableWidget.pagerNext.enabled)
        assert.is_true(tableWidget.tableRows[6]:IsShown())
        assert.is_false(tableWidget.tableRows[7]:IsShown())
        firstRow.scripts.OnHyperlinkEnter(firstRow, "item:121", "[Item 21]")
        assert.equal("item:121", env.UI_TEST.tooltipLink)
        assert.is_true(env.GameTooltip:IsShown())
        firstRow.scripts.OnHyperlinkClick(firstRow, "item:121", "[Item 21]", "LeftButton")
        assert.equal("item:121", env.UI_TEST.clickedLink)
        C.RenderRichUI(host, {}, message, 210)
        assert.equal(count, #env.UI_TEST.widgets)
        assert.equal(2, tableWidget.page)
        assert.is_false(tableWidget.tableRows[1]:IsShown())
        assert.equal("State", firstRow.labels[2]:GetText())
        for index = 25, 4, -1 do
            all[index] = nil
        end
        node.totalRows = 3
        C.RenderRichUI(host, {}, message, 210)
        assert.equal(1, tableWidget.page)
        assert.equal("Row 1", firstRow.cells[2]:GetText())
        assert.is_false(tableWidget.tableRows[5]:IsShown())
        assert.is_false(tableWidget.pagerPrev:IsShown())
        assert.is_false(tableWidget.pagerNext:IsShown())
        assert.is_false(tableWidget.pagerLabel:IsShown())
        assert.equal(count, #env.UI_TEST.widgets)
        C.FormatText = originalFormatter
        node._markdown, node._markdownRows = nil, nil
        node.rows = { { "Explicit", "Native" } }
        C.RenderRichUI(host, {}, message, 600)
        assert.equal("Explicit", firstRow.cells[1]:GetText())
        assert.equal(1, tableWidget.page)
        assert.is_false(
            tableWidget.pagerPrev:IsShown(),
            "wire tables keep their original native contract"
        )
    end
)

it("keeps a growing table visible at twenty-one rows and displays truncation notices", function()
    local env, C = setup()
    local rows = {}
    for index = 1, 20 do
        rows[index] = { "Row " .. index }
    end
    local node = {
        id = "table",
        kind = "table",
        _markdown = true,
        columns = { { label = "Item" } },
        rows = rows,
        _markdownRows = rows,
        totalRows = 20,
    }
    local host = env.CreateFrame("Frame")
    local message = { _markdown = true, ui = { node }, parts = { { type = "ui", id = "table" } } }
    C.RenderRichUI(host, {}, message, 210)
    local widget = host.widgets.table
    local first = widget.tableRows[2]
    assert.is_nil(widget.pagerPrev)
    rows[21], node.totalRows = { "Row 21" }, 21
    C.RenderRichUI(host, {}, message, 210)
    assert.equal(first, widget.tableRows[2])
    assert.is_true(widget:IsShown())
    assert.is_true(widget.pagerNext:IsShown())
    assert.equal(21, #widget.tableRows, "new pages must not allocate all body rows")
    node.notice = "Showing the first 200 rows and 6 columns."
    C.RenderRichUI(host, {}, message, 210)
    assert.equal(node.notice, widget.notice:GetText())
    assert.is_true(widget.notice:IsShown())
    node.rows, node._markdownRows, node.totalRows, node.notice = {}, {}, 0, nil
    C.RenderRichUI(host, {}, message, 210)
    assert.equal(1, widget.page)
    assert.is_true(widget.tableRows[1]:IsShown(), "a header remains visible while streaming")
    assert.equal("Item", widget.tableRows[1].cells[1]:GetText())
    assert.is_false(widget.tableRows[1].labels[1]:IsShown())
    assert.is_false(widget.tableRows[2]:IsShown())
    assert.is_false(widget.notice:IsShown())
    assert.is_false(widget.pagerNext:IsShown())
end)

it(
    "renders projected prose without UI nodes, keeps styles and indentation, and reuses fonts",
    function()
        local env, C = setup()
        C.FormatText = function()
            error("projected prose must not be parsed again")
        end
        local host = env.CreateFrame("Frame")
        local createFont = host.CreateFontString
        host.CreateFontString = function(self, ...)
            local f = createFont(self, ...)
            f.SetFontObject = function(font, style)
                font.actualFont = style
            end
            f.SetTextColor = function(font, ...)
                font.actualColor = { ... }
            end
            return f
        end
        local message = {
            _markdown = true,
            ui = {},
            parts = {
                {
                    type = "text",
                    text = "|cffe3c77eGuide|r",
                    _markdown = true,
                    style = "heading",
                    level = 1,
                },
                {
                    type = "text",
                    text = "**literal**",
                    _markdown = true,
                    style = "code",
                    indent = 12,
                },
                {
                    type = "text",
                    text = "|Hitem:100|h[Item]|h",
                    _markdown = true,
                    style = "quote",
                    indent = 1000,
                },
                { type = "text", text = "Body", _markdown = true },
            },
        }
        C.RenderRichUI(host, {}, message, 200)
        local heading, code, quote, body = unpack(host.prose)
        assert.equal("|cffe3c77eGuide|r", heading:GetText())
        assert.equal(env.GameFontNormalHuge or "GameFontNormalHuge", heading.actualFont)
        assert.equal("**literal**", code:GetText())
        assert.equal(env.GameFontHighlightSmall or "GameFontHighlightSmall", code.actualFont)
        assert.equal(12, code.point[4])
        assert.equal(188, code:GetWidth())
        assert.equal(160, quote.point[4])
        assert.equal(40, quote:GetWidth())
        assert.same({ 0.65, 0.63, 0.58 }, quote.actualColor)
        assert.equal(env.GameFontNormal or "GameFontNormal", body.actualFont)
        assert.equal(host, quote:GetParent())
        assert.is_true(host.hyperlinksEnabled)
        assert.is_function(host.scripts.OnHyperlinkClick)
        local count = #env.UI_TEST.widgets
        message.parts = { { type = "text", text = "Plain body", _markdown = true } }
        C.RenderRichUI(host, {}, message, 300)
        assert.equal(heading, host.prose[1])
        assert.equal(env.GameFontNormal or "GameFontNormal", heading.actualFont)
        assert.same({ 0.89, 0.85, 0.75 }, heading.actualColor)
        assert.equal(count, #env.UI_TEST.widgets)
        assert.is_false(code:IsShown())
        message._markdownSimple = true
        assert.equal(0, C.RenderRichUI(host, {}, message, 300))
        assert.is_false(
            heading:IsShown(),
            "the ordinary message row owns a simple projected paragraph"
        )
    end
)

it("indents projected table roots without changing native UI root coordinates", function()
    local env, C = setup()
    local host = env.CreateFrame("Frame")
    local markdown = {
        id = "local",
        kind = "table",
        _markdown = true,
        columns = { { label = "A" } },
        rows = { { "B" } },
    }
    local native = { id = "native", kind = "stat", label = "DPS", value = "1" }
    local message = {
        _markdown = true,
        ui = { markdown, native },
        parts = { { type = "ui", id = "local", indent = 48 }, { type = "ui", id = "native" } },
    }
    C.RenderRichUI(host, {}, message, 210)
    assert.equal(48, host.widgets["local"].point[4])
    assert.equal(162, host.widgets["local"]:GetWidth())
    assert.equal(0, host.widgets.native.point[4])
    assert.equal(210, host.widgets.native:GetWidth())
end)

it("reports pending formatting for native cells and prose separately for each host", function()
    local env, C = setup()
    local host, other = env.CreateFrame("Frame"), env.CreateFrame("Frame")
    local body = string.rep("Long cell ", 60) .. "end"
    local source = "**" .. body .. "**"
    local message = {
        ui = {
            {
                id = "table",
                kind = "table",
                columns = { { label = "Item" } },
                rows = { { source }, { "Settled cell" } },
            },
        },
        parts = { { type = "text", text = "Settled prose" }, { type = "ui", id = "table" } },
    }
    local height, pending = C.RenderRichUI(host, {}, message, 400)
    assert.is_true(height > 0)
    assert.is_true(pending)
    assert.equal(source, host.widgets.table.tableRows[2].cells[1]:GetText())
    local _, otherPending = C.RenderRichUI(other, {}, {
        ui = { { id = "label", kind = "text", text = "Settled label" } },
    }, 400)
    assert.is_false(otherPending)

    message.ui[1].rows = { { "Settled cell" } }
    message.parts[1].text = source
    _, pending = C.RenderRichUI(host, {}, message, 400)
    assert.is_true(pending, "unformatted surrounding prose participates in pending state")
    assert.equal(source, host.prose[1]:GetText())
    for _ = 1, 2000 do
        local _, remaining = C.Markdown.Cache.step()
        if remaining == 0 then
            break
        end
    end
    _, pending = C.RenderRichUI(host, {}, message, 400)
    assert.is_false(pending)
    assert.equal("|cffe3c77e" .. body .. "|r", host.prose[1]:GetText())
end)

it("keeps pending results local when formatting triggers a nested render", function()
    local env, C = setup()
    local host, nestedHost = env.CreateFrame("Frame"), env.CreateFrame("Frame")
    local mode, nestedPending = "inner"
    C.FormatText = function(value)
        if value == "outer" then
            local _
            _, nestedPending = C.RenderRichUI(nestedHost, {}, {
                ui = { { id = "nested", kind = "text", text = "inner" } },
            }, 400)
            return value, false
        elseif value == "inner" then
            return value, mode == "inner"
        elseif value == "waiting" then
            return value, mode == "outer"
        end
        return value
    end
    local message = {
        ui = {
            { id = "first", kind = "text", text = "waiting" },
            { id = "second", kind = "text", text = "outer" },
            { id = "last", kind = "text", text = "legacy formatter without pending return" },
        },
    }
    local _, pending = C.RenderRichUI(host, {}, message, 400)
    assert.is_false(pending, "a nested pending host does not mark the caller pending")
    assert.is_true(nestedPending)
    mode = "outer"
    _, pending = C.RenderRichUI(host, {}, message, 400)
    assert.is_true(pending, "a nested settled host does not clear the caller's pending result")
    assert.is_false(nestedPending)
end)
