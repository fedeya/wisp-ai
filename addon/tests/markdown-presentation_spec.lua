local helper = require("addon.tests.support")

local function setup()
    local env = helper.env()
    helper.fixture("addon/tests/wow-ui-stub.lua", env)
    env.ns = helper.namespace()
    helper.addon("UI/Window.lua", env)
    local row = env.ns.UI.MakeMessageRow(env.CreateFrame("Frame"))
    return env, env.ns, row
end

local function paint(ns, row, message, width)
    local chat =
        { id = "chat", status = message.streaming and "working" or "done", messages = { message } }
    ns.UI.RenderMessageRow(row, chat, message, width or 400, true)
    for _ = 1, 2000 do
        local _, pending = ns.Markdown.Cache.Step()
        if pending == 0 then
            break
        end
    end
    ns.UI.RenderMessageRow(row, chat, message, width or 400, true)
end

local function visibleFonts(row)
    local result = {}
    for _, font in ipairs(row.rich and row.rich.prose or {}) do
        if font:IsShown() then
            result[#result + 1] = font
        end
        for _, run in ipairs(font.runs or {}) do
            if run:IsShown() then
                result[#result + 1] = run
            end
        end
    end
    return result
end

it("styles the shared parser tree without reparsing on resize or reference updates", function()
    local env, ns, row = setup()
    local source =
        "# Rotación\n\n**Fuego** y `x_y`\n\n- [x] Listo\n  - Seguí [[ref:s]]\n\n> Consejo\n\n---\n\n```lua\n  /cast [[ref:s]]\n**literal** |cff00ff00\n```"
    local message = {
        id = "reply",
        role = "assistant",
        text = source,
        references = {
            s = { kind = "spell", id = 2137, label = "Fuego" },
        },
    }
    local parse, calls = ns.Markdown.Parse, 0
    ns.Markdown.Parse = function(...)
        calls = calls + 1
        return parse(...)
    end
    paint(ns, row, message)
    local syntaxCalls = calls
    assert.equal(1, syntaxCalls)
    local sawMono, sawGold, sawCode, sawTask, sawRule = false, false, false, false, false
    for _, font in ipairs(visibleFonts(row)) do
        if font.fontPath:find("JetBrainsMono-Regular.ttf", 1, true) then
            sawMono = true
        else
            assert.equal("Fonts\\FRIZQT__.TTF", font.fontPath)
        end
        sawGold = sawGold or (font:GetText() == "Fuego" and font.tint[1] == 227 / 255)
    end
    for _, block in ipairs(row.rich.prose) do
        if block.block and block.block.kind == "code" then
            local code = helper.rendered(block)
            assert.is_truthy(code:find("**literal** ||cff00ff00", 1, true))
            assert.is_truthy(code:find("  /cast [[ref:s]]", 1, true))
            assert.is_nil(code:find("|Hspell:", 1, true))
            sawCode = true
        elseif block.block and block.block.task then
            sawTask = block.marker:GetText():find("UI-CheckBox-Check", 1, true) ~= nil
        elseif block.block and block.block.kind == "rule" then
            sawRule = block.decorations[1]:IsShown()
        end
    end
    assert.is_true(sawMono and sawGold and sawCode and sawTask and sawRule)
    local height = row:GetHeight()
    paint(ns, row, message, 150)
    assert.is_true(row:GetHeight() > height)
    local count = #env.UI_TEST.widgets
    paint(ns, row, message, 400)
    paint(ns, row, message, 150)
    assert.equal(count, #env.UI_TEST.widgets)
    message.references.s.label = "Nueva llama"
    paint(ns, row, message, 150)
    assert.is_truthy(helper.rowText(row):find("[Nueva llama]", 1, true))
    assert.equal(syntaxCalls, calls)
    assert.equal(source, message.text)
end)

it("keeps tables and cards in order while inline code uses JetBrains Mono", function()
    local _, ns, row = setup()
    local message = {
        id = "reply",
        role = "assistant",
        text = "`Antes`\n\nA|B\n---|---\nx|y\n\n`Después`",
        ui = { { id = "panel", kind = "stat", label = "DPS", value = "31" } },
    }
    paint(ns, row, message)
    local first, last = row.rich.prose[1], row.rich.prose[2]
    local table = row.rich.widgets.markdown_table_1
    assert.is_truthy(first.fontPath:find("JetBrainsMono-Regular.ttf", 1, true))
    assert.is_truthy(last.fontPath:find("JetBrainsMono-Regular.ttf", 1, true))
    assert.is_true(first.point[5] > table.point[5] and table.point[5] > last.point[5])
    assert.is_true(last.point[5] > row.rich.widgets.panel.point[5])
end)

it("falls back to game fonts for other scripts and failed code font loads", function()
    local _, ns, row = setup()
    local message = { id = "reply", role = "assistant" }
    for _, sample in ipairs({
        "こんにちは",
        "العربية",
        "ไทย",
        "你好",
        "한국어",
    }) do
        message.text = "`" .. sample .. "`"
        paint(ns, row, message)
        assert.equal("Fonts\\FRIZQT__.TTF", row.rich.prose[1].fontPath)
        assert.equal(sample, helper.rowText(row))
    end
    message.text = "`Explosión de Fuego`"
    paint(ns, row, message)
    local font = row.rich.prose[1]
    assert.is_truthy(font.fontPath:find("JetBrainsMono-Regular.ttf", 1, true))
    local setFont = font.SetFont
    font.SetFont = function(self, path, ...)
        if path:find("JetBrainsMono", 1, true) then
            return false
        end
        return setFont(self, path, ...)
    end
    message.text = "`/cast Fuego`"
    paint(ns, row, message)
    assert.equal("Fonts\\FRIZQT__.TTF", font.fontPath)
end)

it("clears decorations and preserves completed presentation across pending append work", function()
    local env, ns, row = setup()
    local message = {
        id = "reply",
        role = "assistant",
        streaming = true,
        text = "~~Antes~~ y `código`\n\n> Nota\n\n- [x] Listo",
    }
    paint(ns, row, message)
    local before = helper.rowText(row)
    local fonts = row.rich.prose
    message.text = message.text .. "\n\n" .. string.rep("**texto** ", 200)
    ns.UI.RenderMessageRow(row, { id = "chat", status = "working" }, message, 150, true)
    assert.equal(before, helper.rowText(row))
    paint(ns, row, message, 150)
    message.text, message.streaming = "Texto simple", false
    paint(ns, row, message)
    assert.is_true(row.text:IsShown())
    for _, font in ipairs(fonts) do
        assert.is_false(font:IsShown())
        for _, run in ipairs(font.runs or {}) do
            assert.is_false(run:IsShown())
        end
        for _, decoration in ipairs(font.decorations or {}) do
            assert.is_false(decoration:IsShown())
        end
        assert.is_true(not font.marker or not font.marker:IsShown())
    end
end)

it("uses the parser's URL nodes for hover and the selectable copy dialog", function()
    local env, ns, row = setup()
    local url = "https://example.com/Guía_(WoW)?a=1&b=2"
    local source = "[**Guía**](" .. url .. ")"
    local message = { id = "reply", role = "assistant", text = source }
    paint(ns, row, message)
    local link = helper.rowText(row):match("|H([^|]+)|h")
    assert.equal(url, ns.Markdown.Links.Decode(link))
    row.scripts.OnHyperlinkEnter(row, link, "Guía")
    assert.equal(url, env.GameTooltip:GetText())
    row.scripts.OnHyperlinkClick(row, link, "Guía", "LeftButton")
    assert.equal(url, env.UI_TEST.popup.data)
    assert.equal("WISPAI_COPY_URL", env.UI_TEST.popup.id)
    local edit = env.CreateFrame("EditBox")
    env.StaticPopupDialogs.WISPAI_COPY_URL.OnShow({ editBox = edit }, env.UI_TEST.popup.data)
    assert.equal(url, edit:GetText())
    for _, invalid in ipairs({ "wispurl:abc", "wispurl:00", "wispurl:gg" }) do
        assert.is_nil(ns.Markdown.Links.Decode(invalid))
    end
    assert.is_nil(ns.Markdown.Links.Valid("javascript:alert(1)"))
end)

it("closes clipped hyperlinks and preserves preformatted run markers", function()
    local _, ns = setup()
    local tree = assert(
        ns.Markdown.ParseInline("[**" .. string.rep("etiqueta ", 40) .. "**](https://example.com)")
    )
    local text, runs = ns.Markdown.InlineRenderer.Render(tree, nil, false, 40, false, true)
    assert.is_truthy(text:find("...", 1, true))
    local _, opens = text:gsub("|H", "")
    local _, markers = text:gsub("|h", "")
    assert.equal(opens * 2, markers)
    assert.equal("...", runs[#runs].text)
end)

it("bounds inline font growth while retaining the shared formatter's full text", function()
    local env, ns, row = setup()
    local message = { id = "dense", role = "assistant", text = string.rep("`x` ", 1000) }
    paint(ns, row, message, 150)
    assert.is_true(row.rich.styledExtras <= 256)
    assert.is_true(#env.UI_TEST.widgets < 600)
    assert.equal(string.rep("x ", 1000), helper.rowText(row))
    local count = #env.UI_TEST.widgets
    paint(ns, row, message, 400)
    paint(ns, row, message, 150)
    assert.equal(count, #env.UI_TEST.widgets)
    assert.equal(string.rep("`x` ", 1000), message.text)
end)

it("separates headings from body emphasis and gives sections more breathing room", function()
    local _, ns, row = setup()
    paint(ns, row, {
        id = "sections",
        role = "assistant",
        text = "# **Rotación**\n\nAntes\n\n## Prioridades\n\nDespués\n\n```\n/cast Fuego\n```",
    })
    local title, before, section, after, code = unpack(row.rich.prose)
    assert.same(title.tint, section.tint)
    assert.is_true(title.tint[3] > ns.UI.Widgets.GOLD[3])
    assert.equal(0, title.point[5])
    local sectionGap = -section.point[5] + before.point[5] - before:GetStringHeight()
    local bodyGap = -after.point[5] + section.point[5] - section:GetStringHeight()
    assert.is_true(sectionGap > bodyGap and bodyGap > 8)
    assert.is_true(code.fontSize < before.fontSize)
end)

it("colors macro commands and conditions while keeping code literal across reflow", function()
    local _, ns, row = setup()
    local source =
        "#showtooltip\n/cast [mod:shift, @focus] Explosión de Fuego\n/say |Hspell:1|hFake|h :fire: [[ref:s]]\n"
    local message = { id = "macro", role = "assistant", text = "```macro\n" .. source .. "```" }
    local tree = assert(ns.Markdown.Parse(message.text))
    local formatted = ns.Markdown.InlineRenderer.Render(tree)
    local plain = formatted:gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|r", "")
    assert.equal(source:gsub("|", "||"), plain)
    for _, width in ipairs({ 400, 150, 400 }) do
        paint(ns, row, message, width)
        local text = helper.rowText(row)
        assert.is_truthy(text:find("|cff8fb7c6/cast|r", 1, true))
        assert.is_truthy(text:find("|cffb0aa8e#showtooltip|r", 1, true))
        assert.is_truthy(text:find("|cffaca0c2[mod:shift,|r", 1, true))
        local literal = text:gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|r", "")
        assert.equal(source:gsub("|", "||"):gsub("\n", ""), literal)
    end
    for _, sample in ipairs({
        "```python\n/cast [mod:shift] Fuego\n```",
        "```lua\nlocal value = '[mod:shift]'\n```",
    }) do
        message.text = sample
        paint(ns, row, message)
        assert.is_nil(helper.rowText(row):find("|cff", 1, true))
    end
end)
