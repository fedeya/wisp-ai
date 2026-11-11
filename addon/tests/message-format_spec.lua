local helper = require("addon.tests.support")

it("renders each macro reference with its game icon and preserves the pickup link", function()
    local env = helper.env()
    env.ns = helper.namespace()
    helper.addon("UI/EmojiData.lua", env)
    helper.addon("UI/Emoji.lua", env)
    helper.addon("UI/MessageFormat.lua", env)
    local macros = {
        [1] = { name = "Nova fría", icon = 135848 },
        [121] = { name = "Heal", icon = "Interface\\Icons\\Spell_Holy_Heal" },
    }
    env.GetMacroIndexByName = function(name)
        for index, macro in pairs(macros) do
            if macro.name == name then
                return index
            end
        end
        return 0
    end
    env.GetMacroInfo = function(index)
        local macro = assert(macros[index], "missing macros must not be queried")
        return macro.name, macro.icon, "#showtooltip"
    end
    for _, macro in pairs(macros) do
        local references = { macro = { kind = "macro", name = macro.name, label = "Pick up" } }
        local text = env.ns.UI.FormatText("[[ref:macro]]", references)
        assert.is_truthy(text:find("|T" .. macro.icon .. ":12:12:0:-2|t", 1, true))
        local link = assert(text:match("|H(.-)|h%[Pick up%]|h"))
        assert.equal(macro.name, env.ns.UI.MessageFormat.MacroNameFromLink(link))
    end

    local references = { macro = { kind = "macro", name = "Missing", label = "Missing" } }
    local function fallback()
        local text = env.ns.UI.FormatText("[[ref:macro]]", references)
        assert.is_truthy(text:find("|TInterface\\Icons\\INV_Misc_QuestionMark:", 1, true))
        assert.is_truthy(text:find("|Hwispmacro:", 1, true))
    end
    fallback()
    references.macro.name = "Heal"
    macros[121].icon = nil
    fallback()
    env.GetMacroInfo = nil
    fallback()
    env.GetMacroIndexByName = nil
    fallback()
end)

it(
    "emoji images preserve complete sequences, formatting, localized text and native links",
    function()
        local env = helper.env()
        setfenv(1, env)
        do
            ns = helper.namespace()
        end
        helper.addon("UI/EmojiData.lua", env)
        helper.addon("UI/Emoji.lua", env)
        helper.addon("UI/MessageFormat.lua", env)

        function image(text)
            local rendered = ns.UI.Emoji.Render(text)
            local _, count = rendered:gsub("|T", "")
            assert(
                count == 1 and rendered:sub(-2) == "|t",
                "Expected one image: " .. text .. " => " .. rendered
            )
            return rendered
        end
        for _, emoji in ipairs({
            "😄",
            "😎",
            "👍🏽",
            "✅️",
            "⚠️",
            "🧙‍♀️",
            "👨‍👩‍👧‍👦",
            "🇦🇷",
            "1️⃣",
            "#️⃣",
            "🏳️‍🌈",
            "👩🏽‍💻",
            "🫩",
        }) do
            image(emoji)
        end
        assert(ns.UI.Emoji.Render("❤") == ns.UI.Emoji.Render("❤️"))
        assert(
            ns.UI.FormatText("te pueden pegar a vos 😄")
                == "te pueden pegar a vos " .. image("😄")
        )
        local localized = "maná, pingüino, ¿qué? 你好 Привет 123 # * ©"
        assert(ns.UI.FormatText(localized) == localized)
        assert(
            ns.UI.FormatText("Explosión → Misiles → repetir")
                == "Explosión -> Misiles -> repetir"
        )
        assert(
            ns.UI.FormatText("20–30 DPS • daño × 2 ≠ vida ≤ 50 ≥ 10 ± 2")
                == "20-30 DPS * daño x 2 != vida <= 50 >= 10 +/- 2"
        )
        assert(
            ns.UI.FormatText("“maná”… x² + H₂O ∞ √9")
                == '"maná"... x^2 + H_2O infinity sqrt9'
        )
        assert(ns.UI.FormatText("A B C​D﻿E") == "A B CDE", "spaces and invisible separators")
        assert(ns.UI.FormatText("ＡＢＣ１２３") == "ABC123")
        assert(
            ns.UI.FormatText("⧖") == "[U+29D6]",
            "unmapped technical symbols need readable fallback"
        )
        local rotation = ns.UI.FormatText("[[ref:a]] → [[ref:b]]", {
            a = { kind = "spell", id = 2136, label = "Explosión de Fuego" },
            b = { kind = "spell", id = 5143, label = "Misiles Arcanos" },
        })
        assert(rotation:find("|Hspell:2136|h[Explosión de Fuego]|h", 1, true))
        assert(rotation:find(" -> ", 1, true))
        assert(rotation:find("|Hspell:5143|h[Misiles Arcanos]|h", 1, true))
        for code = 0x2070, 0x2BFF do
            local symbol = string.char(
                0xE0 + math.floor(code / 4096),
                0x80 + math.floor(code / 64) % 64,
                0x80 + code % 64
            )
            assert(
                ns.UI.Emoji.Render(symbol) ~= symbol,
                "unhandled symbol U+" .. string.format("%04X", code)
            )
        end
        local link = "|Hitem:100|h[Espada]|h"
        assert(ns.UI.FormatText(link, nil, true) == link)
        local ref = ns.UI.FormatText(
            "**[[ref:s]]**",
            { s = { kind = "spell", id = 100, label = "Fuego 🔥" } }
        )
        assert(ref:find("|Hspell:100|h[Fuego " .. image("🔥") .. "]|h", 1, true))
        local future = ns.UI.Emoji.Render("😀‍😀")
        assert(
            future == "[emoji U+1F600]",
            "unknown combinations must not split into partial images"
        )
        assert(
            ns.UI.Emoji.Render("☀︎") == "[U+2600]",
            "explicit text presentation uses a font-safe fallback"
        )
        local count = 0
        for emoji, index in pairs(ns.UI.EmojiData) do
            assert(index >= 0 and index < 4009)
            if #emoji > 2 then
                image(emoji)
            end
            count = count + 1
        end
        assert(count > 3900, "the complete catalog must ship")
    end
)
