local helper = require("addon.tests.support")

it("native comparison resizes, updates winners, handles zero results and reuses widgets", function()
    local env = helper.env()
    setfenv(1, env)
    helper.fixture("addon/tests/wow-ui-stub.lua", env)
    do
        C = {}
        host = CreateFrame("Frame")
        C.LinkWidget = function(w)
            w.linked = true
        end
    end
    helper.addon("EmojiData.lua", env)
    helper.addon("Emoji.lua", env)
    helper.addon("MessageFormat.lua", env)
    helper.addon("Markdown.lua", env)
    helper.addon("RichUI.lua", env)

    local node = {
        id = "sim",
        kind = "comparison",
        title = "Rotaciones",
        unit = "DPS",
        winner = "mixed",
        winnerLabel = "Mejor DPS",
        baseline = "frost",
        items = {
            {
                id = "mixed",
                label = "Misiles + Explosión",
                value = 25.28,
                detail = "Canales completos",
            },
            { id = "frost", label = "[[ref:frost]]", value = 20.65 },
            { id = "zero", label = "Sin daño", value = 0 },
        },
    }
    local message = {
        references = { frost = { kind = "spell", id = 205, label = "Descarga de Escarcha" } },
        ui = {
            node,
            { id = "stat", kind = "stat", label = "DPS", value = "25.28", detail = "Experimental" },
        },
    }
    C.RenderRichUI(host, {}, message, 600)
    local card = host.widgets.sim
    local first, second = card.entries[1], card.entries[2]
    assert(first.badge:GetText() == "Mejor DPS" and not second.badge:IsShown())
    assert(first.metric:GetText() == "25.3 DPS")
    assert(first.delta:GetText():find("+22.4% vs. ", 1, true))
    assert(first.delta:GetText():find("|Hspell:205|h[Descarga de Escarcha]|h", 1, true))
    assert(second.metric:GetText():match("^20%.%d DPS$"))
    assert(first.bar:GetValue() == 1 and math.abs(second.bar:GetValue() - 20.65 / 25.28) < 0.0001)
    assert(card.entries[3].bar:GetValue() == 0)
    assert(
        node.items[1].value == 25.28 and node.items[2].value == 20.65,
        "rounding is presentation only"
    )
    node.precision = 2
    C.RenderRichUI(host, {}, message, 600)
    assert(first.metric:GetText() == "25.28 DPS")
    node.precision = nil
    assert(first.metric.point[5] == first.title.point[5], "wide layout aligns numbers")
    assert(first.linked and second.linked, "spell hyperlinks remain interactive")
    assert(second.title:GetText():find("|Hspell:205|h[Descarga de Escarcha]|h", 1, true))
    local stat = host.widgets.stat
    assert(stat.title:GetText() == "DPS" and stat.metric:GetText() == "25.28")
    assert(
        stat.detail.point[5] < stat.metric.point[5] and stat.metric.point[5] < stat.title.point[5]
    )
    local count = #UI_TEST.widgets
    node.items[1].label = string.rep("Nombre largo localizado ", 4)
    C.RenderRichUI(host, {}, message, 210)
    assert(#UI_TEST.widgets == count, "snapshots and resize must reuse widgets")
    assert(first.metric.point[5] < first.title.point[5], "narrow layout stacks values")
    assert(first.delta.point[5] < first.metric.point[5] - first.metric:GetStringHeight())
    assert(first.bar.point[5] < first.metric.point[5] - first.metric:GetStringHeight())
    assert(first.detail.point[5] < first.bar.point[5])
    assert(first:GetHeight() >= -first.detail.point[5] + first.detail:GetStringHeight())
    node.winner = "frost"
    node.items[1].value = 0
    node.items[2].value = 0
    node.items[3] = nil
    C.RenderRichUI(host, {}, message, 600)
    assert(not first.badge:IsShown() and second.badge:IsShown())
    assert(first.bar:GetValue() == 0 and second.bar:GetValue() == 0)
    assert(first.metric:GetText() == "0.0 DPS", "zero baseline cannot produce a percentage")
    assert(not first.delta:IsShown())
    assert(not card.entries[3]:IsShown(), "removed entries must disappear")
    node.winner = nil
    node.items[1].detail = nil
    message.ui[2].detail = nil
    C.RenderRichUI(host, {}, message, 300)
    assert(not first.badge:IsShown() and not second.badge:IsShown())
    assert(not first.detail:IsShown() and not stat.detail:IsShown())
end)
