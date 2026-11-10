local helper = require("addon.tests.support")

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
