local _, ns = ...
local L = ns.L

-- Palette. Neutrals carry a faint blue-green tint; the wisp accent is reserved
-- for live state, selection and Wisp's own links. As in the Polestar addon
-- (fitzforge/polestar), the grounds are a mid-dark rather than near-black, so
-- light text reads soft instead of glaring, and borders, hover and selection
-- are white washes that sit right on any ground.
local COLORS = {
    window = { 0.086, 0.110, 0.129, 0.97 }, -- #161C21
    sidebar = { 0.067, 0.086, 0.102, 1 }, -- #11161A, also the header bar and code blocks
    raised = { 0.110, 0.137, 0.161, 1 }, -- #1C2329, user bubbles and cards
    selected = { 1, 1, 1, 0.10 }, -- white wash
    line = { 1, 1, 1, 0.08 }, -- hairlines
    lineStrong = { 1, 1, 1, 0.14 }, -- control borders
    -- Text ladder.
    text = { 0.961, 0.973, 0.973 }, -- #F5F8F8
    secondary = { 0.769, 0.808, 0.820 }, -- #C4CED1
    muted = { 0.604, 0.655, 0.675 }, -- #9AA7AC, labels and timestamps
    shade = { 0, 0, 0.02 }, -- text shadows
    accent = { 0.467, 0.859, 0.776 }, -- #77DBC6
    accentDim = { 0.078, 0.188, 0.176, 1 }, -- #14302D
    accentLine = { 0.165, 0.369, 0.341, 1 }, -- #2A5E57
    success = { 0.498, 0.718, 0.494 }, -- #7FB77E
    warning = { 0.890, 0.725, 0.373 }, -- #E3B95F
    danger = { 0.941, 0.706, 0.667 }, -- #F0B4AA
    dangerBg = { 0.200, 0.145, 0.133, 1 }, -- #332522
}
local TEXT, SECONDARY, ACCENT = COLORS.text, COLORS.secondary, COLORS.accent
local FLAT = "Interface\\Buttons\\WHITE8X8"
local TEXTURES = "Interface\\AddOns\\WispAI\\Textures\\"

-- Inter covers Latin, Greek and Cyrillic. Clients whose UI uses CJK or Hangul
-- keep the localized game fonts, and a failed load falls back to them as well.
-- Type follows the approach of the Polestar addon (fitzforge/polestar) for this
-- client: Inter Medium for running text and SemiBold for titles and labels, at
-- sizes set per role, with a soft dark shadow. On a near-black ground, Regular
-- strokes read thin in the game's renderer; Medium keeps long replies legible.
local FONT_DIR = "Interface\\AddOns\\WispAI\\Fonts\\"
local INTER = FONT_DIR .. "Inter-Medium.ttf"
local INTER_STRONG = FONT_DIR .. "Inter-SemiBold.ttf"
-- Inter covers Latin, Greek and Cyrillic. When the UI language uses CJK or
-- Hangul, UI chrome keeps the game font (Latin content still takes Inter, see
-- interSupports), and a failed Inter load falls back to it too.
local LOCALIZED_ONLY = { zhCN = true, zhTW = true, koKR = true }
-- Game fonts for scripts the client's own font may lack. Every client ships
-- them, so a language chosen in Settings renders even when the game runs in
-- another one (Korean on an English client would otherwise show boxes).
local SCRIPT_FONTS = {
    koKR = "Fonts\\2002.TTF",
    zhCN = "Fonts\\ARKai_T.ttf",
    zhTW = "Fonts\\bLEI00D.ttf",
    ruRU = "Fonts\\FRIZQT___CYR.TTF",
}
local function gameLocale()
    return GetLocale and GetLocale() or "enUS"
end
-- Follows the game until ApplyFonts sets the UI language.
local useInter = not LOCALIZED_ONLY[gameLocale()]
local scriptFont -- face for CJK/Hangul text when the UI language differs from the game's
-- The same for the chat language, and whether an empty draft takes Inter.
local chatScriptFont
local chatInter = useInter
--- True when `text` stays within Latin, Greek and Cyrillic (UTF-8 lead bytes
--- below 0xD4) plus General Punctuation (U+2000–U+206F: “ ” ’ … · – —), which
--- Inter and JetBrains Mono both draw. Tool labels quote their queries, so
--- without the punctuation range they would drop to the game font.
local function latinScript(text)
    return not (text or ""):gsub("\226[\128\129][\128-\191]", ""):find("[\212-\255]")
end
--- True when `text` should take Inter. Latin text does in every UI language:
--- the CJK faces (ARKai_T, bLEI00D) lack or badly space Latin-1 letters such as
--- á, ó and ¿. Empty text (an edit box before typing) follows the UI language.
local function interSupports(text)
    if text == nil or text == "" then
        return useInter
    end
    return latinScript(text)
end
--- Soft shadow under Inter text: one pixel down-right in the palette's shade.
local function softShadow(font)
    font:SetShadowOffset(1, -1)
    font:SetShadowColor(COLORS.shade[1], COLORS.shade[2], COLORS.shade[3], 0.6)
end
local fontRoles = {}
local roleOf = {} -- role font object -> role
-- Paints a role's font: Inter when the UI language allows it, otherwise the
-- game font, swapped for the language's script font when the game lacks it.
local function paintFont(role)
    local font, base = role.font, role.base
    font:SetFontObject(base)
    if useInter and font:SetFont(role.path, role.size, "") then
        softShadow(font)
        return
    end
    font:SetFontObject(base)
    if scriptFont then
        local _, size, flags = base:GetFont()
        font:SetFont(scriptFont, size or role.size, flags or "")
    end
end
local function makeFont(name, path, size, fallback)
    local base = _G[fallback]
    if not CreateFont or not base then
        return base
    end
    local role = { font = CreateFont(name), path = path, size = size, base = base }
    fontRoles[#fontRoles + 1] = role
    roleOf[role.font] = role
    paintFont(role)
    return role.font
end
-- Sizes per role, in UI units. Conversation text follows the player's chat font
-- size instead (chatFont below), as a chat should.
local FONTS = {
    heading = makeFont("WispAIFontHeading", INTER_STRONG, 18, "GameFontNormalHuge"), -- page titles
    title = makeFont("WispAIFontTitle", INTER_STRONG, 14, "GameFontNormalLarge"), -- window title
    body = makeFont("WispAIFontBody", INTER, 12, "GameFontHighlight"), -- rows and labels
    strong = makeFont("WispAIFontStrong", INTER_STRONG, 12, "GameFontHighlight"), -- emphasis
    small = makeFont("WispAIFontSmall", INTER, 11, "GameFontHighlightSmall"), -- secondary lines
    button = makeFont("WispAIFontButton", INTER, 12, "GameFontHighlightSmall"), -- controls
    caption = makeFont("WispAIFontCaption", INTER_STRONG, 11, "GameFontHighlightSmall"), -- section labels
}
-- Inter runs larger than the game fonts at the same pixel size, so chat-sized
-- Inter text is scaled down to keep the player's chat font size visually equal.
local INTER_CHAT_SCALE = 0.85
local function interSize(size)
    return math.max(8, math.floor(size * INTER_CHAT_SCALE + 0.5))
end
--- Puts `fontObject`'s face and shadow back on `font`. An explicit SetFont
--- outlives a later SetFontObject, so leaving an override needs this.
local function restoreFace(font, fontObject)
    if type(fontObject) ~= "table" or not fontObject.GetFont then
        return
    end
    local path, size, flags = fontObject:GetFont()
    if path then
        font:SetFont(path, size, flags or "")
    end
    if fontObject.GetShadowOffset then
        local x, y = fontObject:GetShadowOffset()
        if x then
            font:SetShadowOffset(x, y)
        end
        local r, g, b, a = fontObject:GetShadowColor()
        if r then
            font:SetShadowColor(r, g, b, a)
        end
    end
end
--- The script face for non-Latin `text`: of the UI's and the chat language's
--- faces, the one for its script (Korean for Hangul, Chinese for other CJK), the
--- UI's first, else the UI's. Nil leaves the game font, which covers the
--- client's own script.
local function scriptFaceFor(text)
    -- Hangul syllables are U+AC00–U+D7A3: UTF-8 lead bytes 0xEA–0xED.
    local korean = (text or ""):find("[\234-\237][\128-\191][\128-\191]") ~= nil
    for _, face in ipairs({ scriptFont or false, chatScriptFont or false }) do
        if face and (face == SCRIPT_FONTS.koKR) == korean then
            return face
        end
    end
    return scriptFont
end

--- Applies Inter at the player's chat size, or the chat font itself when Inter
--- cannot render `text` (or, for empty text such as a draft, the chat language
--- is CJK/Hangul). CJK/Hangul text takes the face for its script.
local function chatFont(font, text, strong)
    font:SetFontObject(ChatFontNormal)
    local _, size, flags = ChatFontNormal:GetFont()
    local override = false
    local empty = text == nil or text == ""
    local face = empty and chatScriptFont or not empty and scriptFaceFor(text)
    if empty and chatInter or not empty and latinScript(text) then
        override = font:SetFont(strong and INTER_STRONG or INTER, interSize(size), flags)
        if override then
            softShadow(font)
        end
    elseif face then
        override = font:SetFont(face, size, flags)
    end
    if not override and font._wispOverride then
        -- A recycled row that showed Inter text keeps it until reset explicitly.
        restoreFace(font, ChatFontNormal)
    end
    font._wispOverride = override or nil
end

-- The face for `locale`'s CJK/Hangul script when the game's font lacks it.
local function localizedFace(locale)
    return LOCALIZED_ONLY[locale] and locale ~= gameLocale() and SCRIPT_FONTS[locale] or nil
end

--- Sets fonts for the UI language `locale` (from `ns.ActiveLocale`) and the chat
--- language `chatLocale` (from `ns.ChatLocale`, the UI's when omitted). The window
--- calls it before building, once saved variables have loaded; a language change
--- takes effect on reload.
local function applyFonts(locale, chatLocale)
    chatLocale = chatLocale or locale
    -- On a CJK/Hangul client, game names (players, zones) are in that script, so
    -- the game font stays even when the UI language is Latin or Cyrillic.
    useInter = not LOCALIZED_ONLY[locale] and not LOCALIZED_ONLY[gameLocale()]
    scriptFont = localizedFace(locale)
    chatInter = not LOCALIZED_ONLY[chatLocale] and not LOCALIZED_ONLY[gameLocale()]
    chatScriptFont = localizedFace(chatLocale)
    for _, role in ipairs(fontRoles) do
        paintFont(role)
    end
end

--- The face for CJK/Hangul text when the UI language's script is not the
--- game's, or nil when the game font already covers it.
local function scriptFace()
    return scriptFont
end

--- Gives `font` a game font that covers `locale`'s script when the game runs in
--- another language, keeping its size, so a language's own name renders in a list.
local function useLanguageFace(font, locale)
    local face = locale ~= gameLocale() and SCRIPT_FONTS[locale]
    if face and font and font.SetFont then
        local _, size, flags = font:GetFont()
        font:SetFont(face, size or 12, flags or "")
    end
end

local function label(parent, text, tint, fontObject)
    local font = parent:CreateFontString(nil, "OVERLAY", "GameFontNormal")
    if fontObject or FONTS.body then
        font:SetFontObject(fontObject or FONTS.body)
    end
    font:SetText(text)
    font:SetTextColor(unpack(tint or TEXT))
    font:SetJustifyH("LEFT")
    return font
end
--- Small, muted, sentence-case section label, e.g. "Recents".
local function caption(parent, text)
    return label(parent, text, COLORS.muted, FONTS.caption)
end
-- Whole calendar days from `milliseconds` back to today: 0 today, 1 yesterday.
-- Days are compared at noon so daylight-saving shifts never skip or repeat one.
local function daysAgo(milliseconds)
    local function noon(seconds)
        local day = date("*t", seconds)
        return time({ year = day.year, month = day.month, day = day.day, hour = 12 })
    end
    return math.floor((noon(time()) - noon(math.floor(milliseconds / 1000))) / 86400 + 0.5)
end

--- Day heading for a time in milliseconds: "Today", "Yesterday" or a short
--- date such as "05 Nov"; "Earlier" when there is no time to go by.
local function dayLabel(milliseconds)
    if not milliseconds or milliseconds <= 0 or not date or not time then
        return L["time.earlier"]
    end
    local ago = daysAgo(milliseconds)
    if ago <= 0 then
        return L["time.today"]
    elseif ago == 1 then
        return L["time.yesterday"]
    end
    return date("%d %b", math.floor(milliseconds / 1000))
end

--- Coarser day heading for long lists in narrow columns: "Today", "Yesterday",
--- "Previous 7 days", "Previous 30 days" or "Older".
local function dayBucket(milliseconds)
    if not milliseconds or milliseconds <= 0 or not date or not time then
        return L["time.older"]
    end
    local ago = daysAgo(milliseconds)
    if ago <= 0 then
        return L["time.today"]
    elseif ago == 1 then
        return L["time.yesterday"]
    elseif ago < 7 then
        return L["time.previous7Days"]
    elseif ago < 30 then
        return L["time.previous30Days"]
    end
    return L["time.older"]
end
local function setText(font, value)
    if font._wispText ~= value then
        font._wispText = value
        font:SetText(value)
    end
end
--- Shows user or game text (chat titles, character and zone names, model output)
--- in `fontObject`. A Wisp role painted in a CJK/Hangul face for the UI language
--- still draws Latin text in its Inter face, so accented letters stay readable;
--- other scripts keep the role's face, which covers the UI language.
local function setContentText(font, text, fontObject)
    text = text or ""
    if fontObject then
        font:SetFontObject(fontObject)
        local role = roleOf[fontObject]
        local inter = role
            and not useInter
            and interSupports(text)
            and font:SetFont(role.path, role.size, "")
        -- CJK/Hangul text whose script the role's face (painted for the UI) lacks.
        local face = not inter and role and not latinScript(text) and scriptFaceFor(text)
        local script = face
            and face ~= scriptFont
            and font:SetFont(face, select(2, fontObject:GetFont()) or role.size, "")
        if inter then
            softShadow(font)
        elseif not script and font._wispOverride then
            -- A recycled string that showed Latin text keeps that Inter face.
            restoreFace(font, fontObject)
        end
        font._wispOverride = (inter or script) or nil
    end
    setText(font, text)
end
--- One physical pixel in `region`'s units (UIParent's when omitted), so hairlines
--- stay one crisp pixel at any UI scale. Uses the client's PixelUtil when present.
local function onePixel(region)
    local scale = region and region.GetEffectiveScale and region:GetEffectiveScale()
        or (UIParent and UIParent.GetEffectiveScale and UIParent:GetEffectiveScale())
    if PixelUtil and PixelUtil.GetNearestPixelSize and scale and scale > 0 then
        local ok, size = pcall(PixelUtil.GetNearestPixelSize, 1, scale, 1)
        if ok and size and size > 0 then
            return size
        end
    end
    local height = GetPhysicalScreenSize and select(2, GetPhysicalScreenSize())
    local units = UIParent and UIParent.GetHeight and UIParent:GetHeight()
    if not height or height <= 0 or not units or units <= 0 then
        return 1
    end
    return units / height
end
--- Paints a flat surface with a one-pixel hairline, as the Polestar addon draws
--- its borders: a fill and four edge textures, each edge exactly one physical
--- pixel and laid inside the frame. Backdrops build edges from tiled slices
--- that can collapse to nothing at a fractional position, so borders blinked
--- in and out. The frame gets its own SetBackdropColor/SetBackdropBorderColor
--- that repaint these textures, so callers can recolor it as before.
local function box(frame, bg, border)
    local parts = frame._wispBox
    if not parts then
        parts = { edges = {} }
        parts.fill = frame:CreateTexture(nil, "BACKGROUND", nil, -8)
        parts.fill:SetTexture(FLAT)
        parts.fill:SetAllPoints()
        for index = 1, 4 do
            local edge = frame:CreateTexture(nil, "BORDER", nil, 7)
            edge:SetTexture(FLAT)
            parts.edges[index] = edge
        end
        frame._wispBox = parts
        function frame.SetBackdropColor(_, r, g, b, a)
            parts.fill:SetVertexColor(r, g, b, a or 1)
        end
        function frame.SetBackdropBorderColor(_, r, g, b, a)
            for _, edge in ipairs(parts.edges) do
                edge:SetVertexColor(r, g, b, a or 1)
            end
        end
    end
    local pixel = onePixel(frame)
    if parts.pixel ~= pixel then
        parts.pixel = pixel
        local top, bottom, left, right = unpack(parts.edges)
        top:ClearAllPoints()
        top:SetPoint("TOPLEFT")
        top:SetPoint("TOPRIGHT")
        top:SetHeight(pixel)
        bottom:ClearAllPoints()
        bottom:SetPoint("BOTTOMLEFT")
        bottom:SetPoint("BOTTOMRIGHT")
        bottom:SetHeight(pixel)
        left:ClearAllPoints()
        left:SetPoint("TOPLEFT", top, "BOTTOMLEFT")
        left:SetPoint("BOTTOMLEFT", bottom, "TOPLEFT")
        left:SetWidth(pixel)
        right:ClearAllPoints()
        right:SetPoint("TOPRIGHT", top, "BOTTOMRIGHT")
        right:SetPoint("BOTTOMRIGHT", bottom, "TOPRIGHT")
        right:SetWidth(pixel)
    end
    frame:SetBackdropColor(unpack(bg))
    frame:SetBackdropBorderColor(unpack(border or COLORS.line))
end
local BUTTON_STYLES = {
    secondary = { bg = COLORS.raised, border = COLORS.lineStrong, text = TEXT },
    -- The one filled control: the accent with dark ink, and no text shadow (a
    -- dark shadow on a light fill smears the glyphs).
    primary = {
        bg = { ACCENT[1], ACCENT[2], ACCENT[3], 1 },
        border = { ACCENT[1], ACCENT[2], ACCENT[3], 1 },
        text = { 0.039, 0.078, 0.071 }, -- #0A1412
        flat = true,
    },
    ghost = { bg = { 0, 0, 0, 0 }, border = { 0, 0, 0, 0 }, text = SECONDARY },
}
local function dimWhenDisabled(b)
    b:SetAlpha((not b.IsEnabled or b:IsEnabled()) and 1 or 0.45)
end
--- Flat button. `variant` is "secondary" (default), "primary" or "ghost"; `name` is optional.
--- Hover uses the HIGHLIGHT layer, so callers may still set their own OnEnter/OnLeave.
--- The white wash a control shows under the pointer. `alpha` defaults to the
--- control strength (0.06); rows and cards use 0.04. `inset` keeps a border clear.
local function hover(frame, alpha, inset)
    inset = inset or 0
    local wash = frame:CreateTexture(nil, "HIGHLIGHT")
    wash:SetPoint("TOPLEFT", inset, -inset)
    wash:SetPoint("BOTTOMRIGHT", -inset, inset)
    wash:SetColorTexture(1, 1, 1, alpha or 0.06)
    return wash
end

local function button(parent, text, width, click, variant, name)
    local b = CreateFrame("Button", name, parent, "BackdropTemplate")
    local style = BUTTON_STYLES[variant] or BUTTON_STYLES.secondary
    b:SetSize(width, 24)
    box(b, style.bg, style.border)
    hover(b, variant == "primary" and 0.12 or 0.06, 1)
    local font = b:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
    if FONTS.button then
        font:SetFontObject(FONTS.button)
    end
    font:SetPoint("LEFT", 6, 0)
    font:SetPoint("RIGHT", -6, 0)
    font:SetTextColor(unpack(style.text))
    if style.flat then
        font:SetShadowColor(0, 0, 0, 0)
    end
    font:SetWordWrap(false)
    b:SetFontString(font)
    b:SetText(text)
    b:SetScript("OnClick", click)
    b:HookScript("OnEnable", dimWhenDisabled)
    b:HookScript("OnDisable", dimWhenDisabled)
    return b
end

--- Flat on/off switch. It is a CheckButton, so callers keep using
--- SetChecked/GetChecked and OnClick; the switch repaints after each change.
local function paintToggle(t)
    local on = t:GetChecked() and true or false
    t.track:SetColorTexture(unpack(on and COLORS.accentLine or COLORS.selected))
    t.knob:ClearAllPoints()
    t.knob:SetPoint(on and "RIGHT" or "LEFT", on and -2 or 2, 0)
    t.knob:SetColorTexture(unpack(on and ACCENT or SECONDARY))
end
local function toggle(parent, name)
    local t = CreateFrame("CheckButton", name, parent)
    t:SetSize(30, 16)
    t.track = t:CreateTexture(nil, "BACKGROUND")
    t.track:SetAllPoints()
    t.knob = t:CreateTexture(nil, "ARTWORK")
    t.knob:SetSize(12, 12)
    local setChecked = t.SetChecked
    function t.SetChecked(self, value)
        setChecked(self, value)
        paintToggle(self)
    end
    t:SetScript("PostClick", paintToggle)
    t:HookScript("OnEnable", dimWhenDisabled)
    t:HookScript("OnDisable", dimWhenDisabled)
    paintToggle(t)
    return t
end

--- Paints a texture (a hairline, a fill) as a white texture tinted by vertex
--- color, the way Box draws its edges.
local function tint(texture, color)
    texture:SetTexture(FLAT)
    texture:SetVertexColor(unpack(color))
end

--- Scrolls `scroll` to `value` rounded to the physical pixel grid. A fractional
--- offset puts one-pixel hairlines between pixels, where the renderer drops
--- them, so borders would blink in and out as content scrolls.
local function setScroll(scroll, value)
    local pixel = onePixel(scroll)
    scroll:SetVerticalScroll(math.max(0, math.floor(value / pixel + 0.5) * pixel))
end

--- Plain scroll area without Blizzard's scroll bar art; the mouse wheel scrolls it.
local function scrollArea(parent)
    local scroll = CreateFrame("ScrollFrame", nil, parent)
    scroll:SetClipsChildren(true)
    local content = CreateFrame("Frame", nil, scroll)
    content:SetSize(1, 1)
    scroll:SetScrollChild(content)
    scroll:EnableMouseWheel(true)
    scroll:SetScript("OnMouseWheel", function(self, delta)
        local range = self:GetVerticalScrollRange()
        setScroll(self, math.max(0, math.min(range, self:GetVerticalScroll() - delta * 40)))
    end)
    return scroll, content
end

--- Quiet "back" link: a chevron and a muted label that brighten on hover.
local BACK_ICON = "Interface\\AddOns\\WispAI\\Textures\\Back.tga"
local function backLink(parent, text, click)
    local link = CreateFrame("Button", nil, parent)
    link:SetHeight(20)
    link.icon = link:CreateTexture(nil, "ARTWORK")
    link.icon:SetTexture(BACK_ICON)
    link.icon:SetSize(10, 10)
    link.icon:SetPoint("LEFT", 0, 0)
    link.icon:SetVertexColor(unpack(SECONDARY))
    link.label = label(link, text, SECONDARY)
    link.label:SetPoint("LEFT", link.icon, "RIGHT", 6, 0)
    link:SetWidth(math.max(40, (link.label:GetStringWidth() or 0) + 20))
    local function paint(color)
        link.icon:SetVertexColor(unpack(color))
        link.label:SetTextColor(unpack(color))
    end
    link:SetScript("OnEnter", function()
        paint(TEXT)
    end)
    link:SetScript("OnLeave", function()
        paint(SECONDARY)
    end)
    link:SetScript("OnClick", click)
    return link
end

--- Small square status mark, used for Wisp's live state and unread chats.
local function dot(parent, size, color)
    local mark = parent:CreateTexture(nil, "OVERLAY")
    mark:SetSize(size or 6, size or 6)
    -- A white disc tinted by vertex color, so live-state marks read round.
    mark:SetTexture(TEXTURES .. "Dot.tga")
    mark:SetVertexColor(unpack(color or ACCENT))
    return mark
end

--- Full-width sidebar row: left-aligned label, hover wash, and a selected state
--- shown by its fill (and an accent bar when row.accentBar is set). Call
--- `SetSelected(row, value)` to change the state.
local function setSelected(row, selected)
    if row._wispSelected == selected then
        return
    end
    row._wispSelected = selected
    row.fill:SetShown(selected)
    row.bar:SetShown(selected and row.accentBar == true)
    row.label:SetTextColor(unpack(selected and TEXT or SECONDARY))
    if row.icon then
        row.icon:SetVertexColor(unpack(selected and TEXT or SECONDARY))
    end
end
--- `icon`, when given, is a texture path drawn before the label.
local function navItem(parent, text, height, click, icon)
    local row = CreateFrame("Button", nil, parent)
    row:SetHeight(height or 26)
    row.fill = row:CreateTexture(nil, "BACKGROUND")
    row.fill:SetAllPoints()
    row.fill:SetColorTexture(unpack(COLORS.selected))
    -- Navigation rows also mark the current section with an accent bar on the
    -- left (set row.accentBar); list rows use the fill alone.
    row.bar = row:CreateTexture(nil, "ARTWORK")
    row.bar:SetPoint("TOPLEFT")
    row.bar:SetPoint("BOTTOMLEFT")
    row.bar:SetWidth(2)
    row.bar:SetColorTexture(unpack(ACCENT))
    hover(row, 0.04)
    row.label = label(row, text, SECONDARY)
    if icon then
        row.icon = row:CreateTexture(nil, "ARTWORK")
        row.icon:SetTexture(icon)
        row.icon:SetSize(14, 14)
        row.icon:SetPoint("LEFT", 10, 0)
    end
    row.label:SetPoint("LEFT", icon and 32 or 10, 0)
    row.label:SetPoint("RIGHT", -10, 0)
    row.label:SetWordWrap(false)
    row:SetScript("OnClick", click)
    row._wispSelected = true
    setSelected(row, false)
    return row
end

--- A box with rounded corners, built from pieces since frames have no corner
--- radius: three fill strips and four corner discs, a one-pixel edge between
--- four corner arcs. Returns a handle whose SetColors(bg, border) repaints it.
--- The corners are CORNER_RADIUS physical pixels, drawn 1:1 from 16 px
--- textures (see scripts/generate-icons.ts): the client makes no mipmaps, so a
--- texture shrunk a lot would leave jagged steps along the curve.
local CORNER_TEXTURE, CORNER_RADIUS = 16, 10
local CROP = 1 - CORNER_RADIUS / CORNER_TEXTURE -- where the quarter circle starts
local CORNERS = {
    TOPLEFT = { CROP, 1, CROP, 1 },
    TOPRIGHT = { 1, CROP, CROP, 1 },
    BOTTOMLEFT = { CROP, 1, 1, CROP },
    BOTTOMRIGHT = { 1, CROP, 1, CROP },
}
local function roundedBox(frame, bg, border)
    local radius = CORNER_RADIUS * onePixel(frame)
    local shape = { fills = {}, fillCorners = {}, edges = {}, edgeCorners = {} }
    -- Every piece is a white texture tinted by vertex color, like Box above.
    local function strip(list, layer)
        local t = frame:CreateTexture(nil, layer)
        t:SetTexture(FLAT)
        list[#list + 1] = t
        return t
    end
    local center = strip(shape.fills, "BACKGROUND")
    center:SetPoint("TOPLEFT", radius, 0)
    center:SetPoint("BOTTOMRIGHT", -radius, 0)
    local left = strip(shape.fills, "BACKGROUND")
    left:SetPoint("TOPLEFT", 0, -radius)
    left:SetPoint("BOTTOMLEFT", 0, radius)
    left:SetWidth(radius)
    local right = strip(shape.fills, "BACKGROUND")
    right:SetPoint("TOPRIGHT", 0, -radius)
    right:SetPoint("BOTTOMRIGHT", 0, radius)
    right:SetWidth(radius)
    for corner, coords in pairs(CORNERS) do
        local fill = strip(shape.fillCorners, "BACKGROUND")
        fill:SetTexture(TEXTURES .. "CornerFill.tga")
        fill:SetTexCoord(unpack(coords))
        fill:SetSize(radius, radius)
        fill:SetPoint(corner)
        local arc = strip(shape.edgeCorners, "BORDER")
        arc:SetTexture(TEXTURES .. "CornerEdge.tga")
        arc:SetTexCoord(unpack(coords))
        arc:SetSize(radius, radius)
        arc:SetPoint(corner)
    end
    local pixel = onePixel(frame)
    local top = strip(shape.edges, "BORDER")
    top:SetPoint("TOPLEFT", radius, 0)
    top:SetPoint("TOPRIGHT", -radius, 0)
    top:SetHeight(pixel)
    local bottom = strip(shape.edges, "BORDER")
    bottom:SetPoint("BOTTOMLEFT", radius, 0)
    bottom:SetPoint("BOTTOMRIGHT", -radius, 0)
    bottom:SetHeight(pixel)
    local leftEdge = strip(shape.edges, "BORDER")
    leftEdge:SetPoint("TOPLEFT", 0, -radius)
    leftEdge:SetPoint("BOTTOMLEFT", 0, radius)
    leftEdge:SetWidth(pixel)
    local rightEdge = strip(shape.edges, "BORDER")
    rightEdge:SetPoint("TOPRIGHT", 0, -radius)
    rightEdge:SetPoint("BOTTOMRIGHT", 0, radius)
    rightEdge:SetWidth(pixel)
    function shape.SetColors(fill, edge)
        for _, t in ipairs(shape.fills) do
            t:SetVertexColor(unpack(fill))
        end
        for _, t in ipairs(shape.fillCorners) do
            t:SetVertexColor(unpack(fill))
        end
        for _, t in ipairs(shape.edges) do
            t:SetVertexColor(unpack(edge))
        end
        for _, t in ipairs(shape.edgeCorners) do
            t:SetVertexColor(unpack(edge))
        end
    end
    shape.SetColors(bg, border or COLORS.line)
    return shape
end

local function showCopyUrl(url)
    StaticPopupDialogs.WISPAI_COPY_URL = StaticPopupDialogs.WISPAI_COPY_URL
        or {
            text = L["copy.urlTitle"],
            button2 = L["common.close"],
            hasEditBox = true,
            maxLetters = 2048,
            OnShow = function(popup, value)
                local edit = popup.GetEditBox and popup:GetEditBox() or popup.editBox
                edit:SetText(value)
                edit:SetFocus()
                edit:HighlightText()
            end,
            timeout = 0,
            whileDead = true,
            hideOnEscape = true,
        }
    StaticPopup_Show("WISPAI_COPY_URL", nil, nil, url)
end

-- The client has no clipboard API: longer text opens in a read-only, multi-line
-- box with everything selected, ready for Ctrl+C. Built on first use.
local copyDialog
local function buildCopyDialog()
    local frame = CreateFrame("Frame", "WispAICopyText", UIParent, "BackdropTemplate")
    frame:SetSize(480, 320)
    frame:SetPoint("CENTER")
    frame:SetFrameStrata("DIALOG")
    frame:SetToplevel(true)
    frame:EnableMouse(true)
    box(frame, COLORS.window, COLORS.lineStrong)
    if UISpecialFrames then
        table.insert(UISpecialFrames, "WispAICopyText")
    end
    frame.title = label(frame, "", TEXT, FONTS.title)
    frame.title:SetPoint("TOPLEFT", 16, -14)
    frame.hint = label(frame, L["copy.hint"], COLORS.muted, FONTS.small)
    frame.hint:SetPoint("TOPRIGHT", -16, -16)
    local scroll = CreateFrame("ScrollFrame", nil, frame)
    scroll:SetPoint("TOPLEFT", 16, -42)
    scroll:SetPoint("BOTTOMRIGHT", -16, 48)
    scroll:SetClipsChildren(true)
    local edit = CreateFrame("EditBox", nil, scroll)
    edit:SetMultiLine(true)
    edit:SetAutoFocus(false)
    edit:SetMaxLetters(0)
    edit:SetFontObject(FONTS.body or "GameFontHighlight")
    edit:SetTextColor(unpack(SECONDARY))
    edit:SetWidth(448)
    edit:SetPoint("TOPLEFT")
    scroll:SetScrollChild(edit)
    scroll:EnableMouseWheel(true)
    scroll:SetScript("OnMouseWheel", function(self, delta)
        local range = self:GetVerticalScrollRange()
        setScroll(self, math.max(0, math.min(range, self:GetVerticalScroll() - delta * 40)))
    end)
    -- Read-only: typing restores the text and the selection.
    edit:SetScript("OnTextChanged", function(self, userInput)
        if userInput then
            self:SetText(self.source or "")
            self:HighlightText()
        end
    end)
    edit:SetScript("OnEscapePressed", function()
        frame:Hide()
    end)
    frame.edit, frame.scroll = edit, scroll
    local close = button(frame, L["common.close"], 80, function()
        frame:Hide()
    end)
    close:SetPoint("BOTTOMRIGHT", -16, 14)
    frame:Hide()
    return frame
end

--- Shows `text` selected in a copy dialog titled `title`. Escape codes in `text`
--- display literally; callers pass plain text.
local function showCopyText(title, text)
    copyDialog = copyDialog or buildCopyDialog()
    local source = tostring(text or ""):gsub("|", "||")
    copyDialog.title:SetText(title or L["copy.action"])
    copyDialog.edit.source = source
    copyDialog.edit:SetText(source)
    copyDialog:Show()
    copyDialog.scroll:SetVerticalScroll(0)
    copyDialog.edit:SetFocus()
    copyDialog.edit:HighlightText()
    return copyDialog
end

ns.UI.Widgets = {
    Label = label,
    SetText = setText,
    SetContentText = setContentText,
    Box = box,
    Button = button,
    Hover = hover,
    Caption = caption,
    DayLabel = dayLabel,
    DayBucket = dayBucket,
    BackLink = backLink,
    Toggle = toggle,
    ScrollArea = scrollArea,
    Dot = dot,
    NavItem = navItem,
    RoundedBox = roundedBox,
    TEXTURES = TEXTURES,
    SetSelected = setSelected,
    ChatFont = chatFont,
    SoftShadow = softShadow,
    InterSize = interSize,
    InterSupports = interSupports,
    LatinScript = latinScript,
    ApplyFonts = applyFonts,
    ScriptFace = scriptFace,
    UseLanguageFace = useLanguageFace,
    ShowCopyUrl = showCopyUrl,
    ShowCopyText = showCopyText,
    OnePixel = onePixel,
    SetScroll = setScroll,
    Tint = tint,
    FONTS = FONTS,
    COLORS = COLORS,
    ACCENT = ACCENT,
    TEXT = TEXT,
    MUTED = SECONDARY,
}
