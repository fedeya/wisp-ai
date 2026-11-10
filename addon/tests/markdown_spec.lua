local helper = require("addon.tests.support")

local function setup(env)
    helper.fixture("addon/tests/wow-ui-stub.lua", env)
    env.C = {}
    env.SlashCmdList = {}
    helper.addon("UI.lua", env)
    helper.addon("RichUI.lua", env)
end

it("recognizes heading levels without interpreting hashes in code or ordinary prose", function()
    local env = helper.env()
    setup(env)
    local parse = env.C.MessageFormat.blocks
    local blocks, headings = parse("Intro\r\n\r\n### **Rotación** ###\r\nUsá fuego.\r\n## Equipo")
    assert(headings and #blocks == 4)
    assert(blocks[1].text == "Intro" and not blocks[1].level)
    assert(blocks[2].text == "**Rotación**" and blocks[2].level == 3)
    assert(blocks[3].text == "Usá fuego." and blocks[4].level == 2)
    for level = 1, 6 do
        local heading = parse(string.rep("#", level) .. " Título")[1]
        assert(heading.level == level and heading.text == "Título")
    end
    for _, literal in ipairs({
        "C# y #etiqueta",
        "####### Demasiados",
        "\\### Escapado",
    }) do
        local parsed, found = parse(literal)
        assert(not found and #parsed == 1 and parsed[1].text == literal, literal)
    end
    local fenced = parse("# Título\n```\n## Código\n```\n## Sección")
    assert(
        #fenced == 3
            and fenced[2].kind == "code"
            and fenced[2].text == "## Código"
            and fenced[3].level == 2
    )
end)

it(
    "parses nested emphasis, escaped punctuation, code and URLs without changing payloads",
    function()
        local env = helper.env()
        setup(env)
        local md = env.C.Markdown
        local spans =
            md.inline("**negrita y *cursiva*** / ~~antes~~ / `a_b **literal**` / ***ambas***")
        assert(spans[1].text == "negrita y " and spans[1].bold)
        assert(spans[2].text == "cursiva" and spans[2].bold and spans[2].italic)
        local all = ""
        local code, strike, both = false, false, false
        for _, span in ipairs(spans) do
            all = all .. span.text
            code = code or (span.code and span.text == "a_b **literal**")
            strike = strike or (span.strike and span.text == "antes")
            both = both or (span.bold and span.italic and span.text == "ambas")
        end
        assert(code and strike and both and not all:find("***", 1, true))
        local italic = md.inline("*cursiva y **negrita***")
        assert(italic[1].italic and italic[2].bold and italic[2].italic)
        assert(md.format("snake_case_name y \\*literal\\*") == "snake_case_name y *literal*")
        assert(md.inline("`` `literal` ``")[1].text == "`literal`")
        local url = "https://example.com/Guía_(WoW)?a=1&b=2#sección"
        local rendered = md.format("[**Guía**](" .. url .. ")")
        local link = rendered:match("|H([^|]+)|h")
        assert(link and md.url(link) == url and rendered:find("Guía", 1, true))
        assert(md.format("[mal](javascript:alert(1))"):find("javascript:", 1, true))
        assert(not md.url("wispurl:00") and not md.url("wispurl:abc") and not md.url("wispurl:gg"))
        assert(
            md.inline("[parcial](https://example.com")[1].text == "[parcial](https://example.com"
        )
        assert(md.inline("<https://example.com>")[1].url == "https://example.com")
        assert(md.inline("(https://example.com/a_(b)).")[2].url == "https://example.com/a_(b)")
        assert(
            md.format("`→ snake_case **literal**`"):find("→ snake_case **literal**", 1, true)
        )
    end
)

it(
    "parses list continuations, nesting, tasks, quotes, rules and both kinds of code blocks",
    function()
        local env = helper.env()
        setup(env)
        local parse = env.C.Markdown.blocks
        local blocks = parse(
            "- Uno\n  continuación\n  - Dos\n1. Tres\n- [x] Listo\n- [ ] Pendiente\n\n> Nota\n> otra línea\n> > Anidada\n\n---\n\n```lua\n### literal\n**sin formato**\n```\n\n    local x = 1"
        )
        assert(#blocks == 10)
        assert(blocks[1].kind == "list" and blocks[1].text == "Uno\ncontinuación")
        assert(blocks[2].indent == 2 and blocks[3].marker == "1.")
        assert(blocks[4].task and blocks[4].checked and not blocks[5].checked)
        assert(blocks[6].kind == "quote" and blocks[6].text == "Nota\notra línea")
        assert(blocks[7].depth == 2 and blocks[7].text == "Anidada")
        assert(blocks[8].kind == "rule")
        assert(
            blocks[9].kind == "code"
                and blocks[9].language == "lua"
                and blocks[9].text == "### literal\n**sin formato**"
        )
        assert(blocks[10].kind == "code" and blocks[10].text == "local x = 1")
        local open = parse("~~~lua\n## texto\n`sin cerrar`")[1]
        assert(open.kind == "code" and open.text == "## texto\n`sin cerrar`")
        local long = parse("````\n```\n## literal\n````")[1]
        assert(long.text == "```\n## literal")
        local setext = parse("Título\n===\n\nSubtítulo\n---")
        assert(setext[1].level == 1 and setext[2].level == 2)
        local numbered = parse("3. Uno\n1. Dos\n  - Sublista\n1. Tres")
        assert(
            numbered[1].marker == "3." and numbered[2].marker == "4." and numbered[4].marker == "5."
        )
    end
)

it(
    "highlights emphasis with game fonts, uses JetBrains Mono for code and reuses widgets",
    function()
        local env = helper.env()
        setfenv(1, env)
        setup(env)
        local row = C.MakeMessageRow(CreateFrame("Frame"))
        local message = {
            id = "reply",
            role = "assistant",
            text = "**Fuerte** y *suave* y ~~viejo~~ y `x_y`\n\n> Nota\n\n- [x] Hecho\n  - Otra tarea\n\n---\n\n```lua\n  /cast [[ref:s]]\n**literal** |cff00ff00\n```",
        }
        local chat = { id = "chat", status = "working", messages = { message } }
        C.RenderMessageRow(row, chat, message, 400, true)
        assert(not row.text:IsShown())
        local block = row.markdown[1]
        assert(block.fontPath == "Fonts\\FRIZQT__.TTF")
        assert(block.tint[1] == 227 / 255 and block.tint[2] == 199 / 255)
        local italic, mono, strike = false, false, false
        for _, run in ipairs(block.runs) do
            if run:GetText() == "suave" then
                italic = run.fontPath == "Fonts\\FRIZQT__.TTF"
            end
            mono = mono or run.fontPath:find("JetBrainsMono-Regular.ttf", 1, true)
        end
        for _, decoration in ipairs(block.decorations) do
            strike = strike or decoration.height == 1
        end
        assert(italic and mono and strike)
        assert(row.markdown[2].decorations[1]:IsShown())
        assert(row.markdown[3].marker:GetText():find("UI-CheckBox-Check", 1, true))
        assert(row.markdown[4].point[4] > row.markdown[3].point[4])
        assert(
            row.markdown[4].marker.point[4] > row.markdown[3].marker.point[4]
                and row.markdown[4].marker:GetWidth() == row.markdown[3].marker:GetWidth()
        )
        assert(not row.markdown[5]:IsShown() and row.markdown[5].decorations[1]:IsShown())
        local code = helper.rendered(row.markdown[6])
        assert(
            code:find("  /cast [[ref:s]]", 1, true)
                and code:find("**literal** ||cff00ff00", 1, true)
        )
        assert(not code:find("```", 1, true) and not code:find("|Hspell:", 1, true))
        local wide = row:GetHeight()
        C.RenderMessageRow(row, chat, message, 150, true)
        assert(row:GetHeight() > wide)
        local count = #UI_TEST.widgets
        for i = 1, 20 do
            C.RenderMessageRow(row, chat, message, i % 2 == 0 and 150 or 400, true)
        end
        assert(#UI_TEST.widgets == count, "resizing must not accumulate runs, textures or markers")
        message.text = "Sin formato"
        C.RenderMessageRow(row, chat, message, 150, true)
        for _, font in ipairs(row.markdown) do
            assert(not font:IsShown())
            for _, run in ipairs(font.runs) do
                assert(not run:IsShown())
            end
            for _, decoration in ipairs(font.decorations or {}) do
                assert(not decoration:IsShown())
            end
            assert(not font.marker or not font.marker:IsShown())
        end
    end
)

it("web links expose the exact URL on hover and in a selectable copy dialog", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)
    local row = C.MakeMessageRow(CreateFrame("Frame"))
    local url = "https://example.com/guide?a=1&b=2"
    local rendered = C.FormatText("[Guía](" .. url .. ")")
    local link = rendered:match("|H([^|]+)|h")
    row.scripts.OnHyperlinkEnter(row, link, "Guía")
    assert(GameTooltip:GetText() == url and GameTooltip:IsShown())
    row.scripts.OnHyperlinkClick(row, link, "Guía", "LeftButton")
    assert(UI_TEST.popup.id == "WISPAI_COPY_URL" and UI_TEST.popup.data == url)
    local edit = CreateFrame("EditBox")
    StaticPopupDialogs.WISPAI_COPY_URL.OnShow({ editBox = edit }, UI_TEST.popup.data)
    assert(edit:GetText() == url)
    row.scripts.OnHyperlinkLeave(row)
    assert(not GameTooltip:IsShown())
end)

it("streaming prefixes stay renderable and preserve localized references beside code", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)
    local row = C.MakeMessageRow(CreateFrame("Frame"))
    local source =
        "## Guía\n**Usá [[ref:s]]** y `x_y`.\n\n- [x] Listo\n\n> Consejo\n\n~~~lua\n  /cast Fuego\n~~~\n\n[Fuente](https://example.com/a_(b))"
    local message = {
        id = "reply",
        role = "assistant",
        text = "",
        references = {
            s = { kind = "spell", id = 2137, label = "Fuego 🔥" },
        },
    }
    local chat = { id = "chat", status = "working", messages = { message } }
    for index = 1, #source do
        -- Delivery is UTF-8, so skip incomplete code points in this byte-based fixture.
        local nextByte = source:byte(index + 1)
        if not nextByte or nextByte < 128 or nextByte >= 192 then
            message.text = source:sub(1, index)
            C.RenderMessageRow(row, chat, message, 210, true)
            assert(row:GetHeight() >= 1)
        end
    end
    local rendered = helper.rendered(row.markdown[2])
    assert(rendered:find("|Hspell:2137|h[Fuego ", 1, true))
    assert(rendered:find("|TInterface\\AddOns\\WispAI\\Textures\\Emoji", 1, true))
    local host, pool = CreateFrame("Frame"), {}
    C.Markdown.render(host, pool, "**你好**", nil, 200, 0)
    assert(pool[1].fontPath == "Fonts\\FRIZQT__.TTF", "localized font survives emphasis")
    host.markdownMeasure.GetUnboundedStringWidth = false
    C.Markdown.render(host, pool, "*Compatible*", nil, 200, 0)
    assert(pool[1].fontPath == "Fonts\\FRIZQT__.TTF")
end)

it("code falls back to the game font for unsupported scripts and missing font files", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)
    local host, pool = CreateFrame("Frame"), {}
    for _, sample in ipairs({
        "こんにちは",
        "العربية",
        "ไทย",
        "你好",
        "한국어",
    }) do
        C.Markdown.render(host, pool, "`" .. sample .. "`", nil, 300, 0)
        assert(pool[1].fontPath == "Fonts\\FRIZQT__.TTF")
        assert(helper.rendered(pool[1]) == sample)
    end
    C.Markdown.render(host, pool, "`Explosión de Fuego`", nil, 300, 0)
    assert(pool[1].fontPath:find("JetBrainsMono-Regular.ttf", 1, true))
    local setFont = pool[1].SetFont
    pool[1].SetFont = function(self, path, ...)
        if path:find("JetBrainsMono", 1, true) then
            return false
        end
        return setFont(self, path, ...)
    end
    C.Markdown.render(host, pool, "`/cast Fuego`", nil, 300, 0)
    assert(
        pool[1].fontPath == "Fonts\\FRIZQT__.TTF",
        "failed code font must not retain an old face"
    )
end)

it("lays out and reuses heading fonts, references and wrapped body text in message rows", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)
    local message = {
        id = "reply",
        role = "assistant",
        text = "# Rotación\nUsá fuego y repetí esta secuencia varias veces.\n### [[ref:spell]]",
        references = { spell = { kind = "spell", id = 2137, label = "Fuego" } },
    }
    local chat = { id = "chat", status = "working", messages = { message } }
    local row = C.MakeMessageRow(CreateFrame("Frame"))
    C.RenderMessageRow(row, chat, message, 500, true)
    local title, body, subtitle = unpack(row.markdown)
    assert(not row.text:IsShown() and title:GetText() == "Rotación")
    assert(title.fontSize > subtitle.fontSize and subtitle.fontSize > body.fontSize)
    assert(subtitle:GetText():find("|Hspell:2137|h[Fuego]|h", 1, true))
    assert(title.point[5] > body.point[5] and body.point[5] > subtitle.point[5])
    assert(row.hyperlinksEnabled and row.scripts.OnHyperlinkClick)
    local height, count = row:GetHeight(), #UI_TEST.widgets
    C.RenderMessageRow(row, chat, message, 150, true)
    assert(row:GetHeight() > height)
    count = #UI_TEST.widgets
    C.RenderMessageRow(row, chat, message, 500, true)
    C.RenderMessageRow(row, chat, message, 150, true)
    assert(#UI_TEST.widgets == count, "subsequent resizes reuse line fragments")
    assert(row.markdown[1] == title and title.fontSize == 21, "resize must not grow fonts")
    message.text = "## Nuevo título"
    C.RenderMessageRow(row, chat, message, 150, true)
    assert(title:GetText() == "Nuevo título" and not body:IsShown() and not subtitle:IsShown())
    message.text = "Respuesta simple"
    C.RenderMessageRow(row, chat, message, 150, true)
    assert(row.text:IsShown() and not title:IsShown())
    message.role, message.text = "user", "### Mi mensaje"
    C.RenderMessageRow(row, chat, message, 150, true)
    assert(row.text:IsShown() and row.text:GetText() == message.text and not title:IsShown())
end)

it("keeps styled headings in order around generated cards and hides obsolete prose", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)
    local message = {
        id = "reply",
        role = "assistant",
        text = "## Equipo\nAntes\n### Después",
        ui = { { id = "result", kind = "stat", label = "DPS", value = "31.2" } },
        parts = {
            { type = "text", text = "## Equipo\nAntes" },
            { type = "ui", id = "result" },
            { type = "text", text = "### Después" },
        },
    }
    local chat = { id = "chat", status = "done", messages = { message } }
    local row = C.MakeMessageRow(CreateFrame("Frame"))
    C.RenderMessageRow(row, chat, message, 400, true)
    local first, body, last = unpack(row.rich.prose)
    local card = row.rich.widgets.result
    assert(first:GetText() == "Equipo" and last:GetText() == "Después")
    assert(first.fontSize > last.fontSize and last.fontSize > body.fontSize)
    assert(body.point[5] > card.point[5] and card.point[5] > last.point[5])
    assert(first:GetParent().hyperlinksEnabled)
    message.parts[1].text = "Texto simple"
    message.parts[3] = nil
    C.RenderMessageRow(row, chat, message, 400, true)
    assert(first:GetText() == "Texto simple" and first.fontSize == 14)
    assert(not body:IsShown() and not last:IsShown())
end)
