local _, ns = ...
local textures = {}
local function texture(index)
    if not textures[index] then
        local cell = index % 1024
        -- Include the transparent border so filtering keeps round edges intact.
        local x, y = (cell % 32) * 32, math.floor(cell / 32) * 32
        textures[index] = string.format(
            "|TInterface\\AddOns\\WispAI\\Textures\\Emoji\\Emoji%d.tga:14:14:0:-2:1024:1024:%d:%d:%d:%d|t",
            math.floor(index / 1024),
            x,
            x + 32,
            y,
            y + 32
        )
    end
    return textures[index]
end
local function codepoint(char)
    local a, b, c, d = char:byte(1, 4)
    if d then
        return (a - 240) * 262144 + (b - 128) * 4096 + (c - 128) * 64 + d - 128
    elseif c then
        return (a - 224) * 4096 + (b - 128) * 64 + c - 128
    elseif b then
        return (a - 192) * 64 + b - 128
    end
    return a
end
local function regional(code)
    return code >= 0x1F1E6 and code <= 0x1F1FF
end
local function extension(code)
    return code == 0xFE0F
        or code == 0xFE0E
        or code == 0x20E3
        or (code >= 0x1F3FB and code <= 0x1F3FF)
        or (code >= 0xE0020 and code <= 0xE007F)
end
-- Chat fonts vary by client/locale. Keep prose in its original language, but
-- give technical Unicode symbols a readable representation independent of fonts.
local symbols = {}
local function aliases(chars, replacement)
    for char in chars:gmatch("[%z\1-\127\194-\244][\128-\191]*") do
        symbols[char] = replacement
    end
end
aliases("‐‑‒–—―−﹘﹣－", "-")
aliases("‘’‚‛′‵＇", "'")
aliases("“”„‟″‶＂", '"')
aliases("…⋯", "...")
aliases("•‣⁃∙⋅●○◦▪▫■□◆◇▶▷►▸", "*")
aliases(
    "→➔➜➝➞➟➠➢➣➤➥➦➧➨➩➪➫➬➭➮➯➱⟶⇒⟹↦↪⇢⇨",
    "->"
)
aliases("←⟵⇐⟸↤↩⇠⇦", "<-")
aliases("↔⟷⇔⟺⇄⇆⇋⇌", "<->")
aliases("↑⇑⇧", "(up)")
aliases("↓⇓⇩", "(down)")
aliases("↗↖↘↙", "(diagonal)")
aliases("×✕✖⨯", "x")
aliases("÷∕⁄", "/")
aliases("≤≦⩽", "<=")
aliases("≥≧⩾", ">=")
aliases("≠≢", "!=")
aliases("≈≃≅≍∼", "~")
aliases("±", "+/-")
aliases("∓", "-/+")
aliases("∞", "infinity")
aliases("√", "sqrt")
aliases("∛", "cbrt")
aliases("∑", "sum")
aliases("∏", "product")
aliases("∫", "integral")
aliases("∂", "d")
aliases("∆∇", "delta")
aliases("∈", " in ")
aliases("∉", " not in ")
aliases("⊂⊆", " subset of ")
aliases("⊃⊇", " superset of ")
aliases("∪", " union ")
aliases("∩", " intersection ")
aliases("∅", "(empty)")
aliases("∧", " and ")
aliases("∨", " or ")
aliases("¬", "not ")
aliases("∀", "for all ")
aliases("∃", "exists ")
aliases("∴", "therefore ")
aliases("∵", "because ")
aliases("∝", " proportional to ")
aliases("∥", " parallel to ")
aliases("⊥", " perpendicular to ")
aliases("‖", "||")
aliases("‰", " per mille")
aliases("‱", " per ten thousand")
aliases("⟨〈", "<")
aliases("⟩〉", ">")
aliases("【〔〖〘〚", "[")
aliases("】〕〗〙〛", "]")
aliases("✓✔", "[ok]")
aliases("✗✘", "[x]")
local superscripts = { "⁰", "¹", "²", "³", "⁴", "⁵", "⁶", "⁷", "⁸", "⁹" }
local subscripts = { "₀", "₁", "₂", "₃", "₄", "₅", "₆", "₇", "₈", "₉" }
for i = 1, 10 do
    symbols[superscripts[i]] = "^" .. (i - 1)
    symbols[subscripts[i]] = "_" .. (i - 1)
end
aliases("⁺", "^+")
aliases("⁻", "^-")
aliases("⁼", "^=")
aliases("⁽", "^(")
aliases("⁾", "^)")
aliases("₊", "_+")
aliases("₋", "_-")
aliases("₌", "_=")
aliases("₍", "_(")
aliases("₎", "_)")
local function compatible(char, code)
    if symbols[char] then
        return symbols[char]
    end
    if
        code == 0xA0
        or code == 0x1680
        or (code >= 0x2000 and code <= 0x200A)
        or code == 0x202F
        or code == 0x205F
        or code == 0x3000
    then
        return " "
    end
    if code == 0x2028 or code == 0x2029 then
        return "\n"
    end
    -- Formatting controls have no visible glyph; emoji joiners are consumed
    -- before reaching here. Preserve language-specific shaping controls.
    if
        code == 0xAD
        or code == 0x200B
        or code == 0x2060
        or code == 0xFEFF
        or code == 0xFE0E
        or code == 0xFE0F
    then
        return ""
    end
    if code >= 0xFF01 and code <= 0xFF5E then
        local ascii = string.char(code - 0xFEE0)
        return ascii == "|" and "||" or ascii
    end
    -- Unmapped symbols remain identifiable instead of becoming missing-glyph
    -- boxes. Do not apply this to alphabets, accents or CJK text.
    if
        (code >= 0x2070 and code <= 0x2BFF)
        or (code >= 0x1D000 and code <= 0x1D7FF)
        or (code >= 0x1F000 and code <= 0x1FAFF)
    then
        return string.format("[U+%04X]", code)
    end
    return char
end
local function render(text)
    if not text:find("[\194-\244]") then
        return text
    end
    local chars, codes = {}, {}
    for char in text:gmatch("[%z\1-\127\194-\244][\128-\191]*") do
        chars[#chars + 1] = char
        codes[#codes + 1] = codepoint(char)
    end
    local result, i = {}, 1
    while i <= #chars do
        local last = i
        local candidate = ns.UI.EmojiData[chars[i]] ~= nil
            or (codes[i] >= 0x1F000 and codes[i] <= 0x1FAFF)
            or (chars[i]:match("^[%d#*]$") and (codes[i + 1] == 0xFE0F or codes[i + 1] == 0x20E3))
        if regional(codes[i]) and codes[i + 1] and regional(codes[i + 1]) then
            last = i + 1
        end
        while candidate and codes[last + 1] do
            if extension(codes[last + 1]) then
                last = last + 1
            elseif codes[last + 1] == 0x200D and codes[last + 2] then
                last = last + 2
            else
                break
            end
        end
        local raw = table.concat(chars, "", i, last)
        local normalized = raw:gsub("\239\184\143", "")
        local index = ns.UI.EmojiData[normalized]
        if raw:find("\239\184\142", 1, true) then
            -- Explicit text presentation wins over emoji presentation.
            result[#result + 1] = compatible(chars[i], codes[i])
        elseif index and (codes[i] > 255 or last > i) then
            result[#result + 1] = texture(index)
        elseif (codes[i] >= 0x1F000 and codes[i] <= 0x1FAFF) or (last > i and index == nil) then
            -- Future/unrecognized sequences stay one readable unit.
            result[#result + 1] = string.format("[emoji U+%X]", codes[i])
        else
            result[#result + 1] = compatible(raw, codes[i])
        end
        i = last + 1
    end
    return table.concat(result)
end
ns.UI.Emoji = { Render = render }
