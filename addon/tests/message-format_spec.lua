local helper = require("addon.tests.support")

it(
    "emoji images preserve complete sequences, formatting, localized text and native links",
    function()
        local env = helper.env()
        setfenv(1, env)
        do
            C = {}
        end
        helper.addon("EmojiData.lua", env)
        helper.addon("Emoji.lua", env)
        helper.addon("MessageFormat.lua", env)
        helper.addon("Markdown.lua", env)

        function image(text)
            local rendered = C.Emoji.render(text)
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
        assert(C.Emoji.render("❤") == C.Emoji.render("❤️"))
        assert(
            C.FormatText("te pueden pegar a vos 😄") == "te pueden pegar a vos " .. image("😄")
        )
        local localized = "maná, pingüino, ¿qué? 你好 Привет 123 # * ©"
        assert(C.FormatText(localized) == localized)
        assert(
            C.FormatText("Explosión → Misiles → repetir") == "Explosión -> Misiles -> repetir"
        )
        assert(
            C.FormatText("20–30 DPS • daño × 2 ≠ vida ≤ 50 ≥ 10 ± 2")
                == "20-30 DPS * daño x 2 != vida <= 50 >= 10 +/- 2"
        )
        assert(
            C.FormatText("“maná”… x² + H₂O ∞ √9")
                == '"maná"... x^2 + H_2O infinity sqrt9'
        )
        assert(C.FormatText("A B C​D﻿E") == "A B CDE", "spaces and invisible separators")
        assert(C.FormatText("ＡＢＣ１２３") == "ABC123")
        assert(
            C.FormatText("⧖") == "[U+29D6]",
            "unmapped technical symbols need readable fallback"
        )
        local rotation = C.FormatText("[[ref:a]] → [[ref:b]]", {
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
                C.Emoji.render(symbol) ~= symbol,
                "unhandled symbol U+" .. string.format("%04X", code)
            )
        end
        local link = "|Hitem:100|h[Espada]|h"
        assert(C.FormatText(link, nil, true) == link)
        local ref = C.FormatText(
            "**[[ref:s]]**",
            { s = { kind = "spell", id = 100, label = "Fuego 🔥" } }
        )
        assert(ref:find("|Hspell:100|h[Fuego " .. image("🔥") .. "]|h", 1, true))
        local future = C.Emoji.render("😀‍😀")
        assert(
            future == "[emoji U+1F600]",
            "unknown combinations must not split into partial images"
        )
        assert(
            C.Emoji.render("☀︎") == "[U+2600]",
            "explicit text presentation uses a font-safe fallback"
        )
        local count = 0
        for emoji, index in pairs(C.EmojiData) do
            assert(index >= 0 and index < 4009)
            if #emoji > 2 then
                image(emoji)
            end
            count = count + 1
        end
        assert(count > 3900, "the complete catalog must ship")
    end
)
