local _, ns = ...
local widgets = ns.UI.Widgets
local COLORS = widgets.COLORS
local box = widgets.Box
local TEXTURES = "Interface\\AddOns\\WispAI\\Textures\\"
local SEND_ICON, STOP_ICON = TEXTURES .. "Send.tga", TEXTURES .. "Stop.tga"
-- The composer is a text area over a toolbar: model choices on the left, the
-- context meter and a square send button on the right. Narrow, the meter and
-- send move up a row so the model choices keep their width.
local MARGIN, PAD, TOOLBAR, SEND_SIZE = 14, 14, 40, 28
local WIDE_HEIGHT, NARROW_HEIGHT = 96, 124
local inputBox, inputScroll, send, placeholder, onLayout
local narrow

local function layout()
    local nextNarrow = inputBox:GetWidth() < 470
    if narrow ~= nextNarrow then
        narrow = nextNarrow
        local height = narrow and NARROW_HEIGHT or WIDE_HEIGHT
        local textBottom = narrow and TOOLBAR + 28 or TOOLBAR
        inputBox:SetHeight(height)
        inputScroll:SetPoint("BOTTOMRIGHT", -PAD, textBottom)
        send:ClearAllPoints()
        send:SetPoint("BOTTOMRIGHT", -8, narrow and 36 or 6)
        onLayout(height + MARGIN + 8)
    end
end

local function refreshPlaceholder()
    placeholder:SetShown(ns.draft:GetText() == "")
end

function ns.UI.Composer.Refresh(chat)
    ns.UI.RefreshModelControls()
    layout()
    send:SetEnabled(not ns.Transport.needsDesktopSetup)
    local working = chat and chat.status == "working"
    if send.working ~= working then
        send.working = working
        send.icon:SetTexture(working and STOP_ICON or SEND_ICON)
    end
end

--- Square accent button with an icon: send, or stop while Wisp is replying.
local function makeSend(parent, click)
    local b = CreateFrame("Button", "WispAISendButton", parent, "BackdropTemplate")
    b:SetSize(SEND_SIZE, SEND_SIZE)
    box(b, { COLORS.accent[1], COLORS.accent[2], COLORS.accent[3], 1 }, {
        COLORS.accent[1],
        COLORS.accent[2],
        COLORS.accent[3],
        1,
    })
    b.icon = b:CreateTexture(nil, "ARTWORK")
    b.icon:SetSize(14, 14)
    b.icon:SetPoint("CENTER")
    b.icon:SetTexture(SEND_ICON)
    b.icon:SetVertexColor(0.039, 0.078, 0.071)
    local hover = b:CreateTexture(nil, "HIGHLIGHT")
    hover:SetAllPoints()
    hover:SetColorTexture(1, 1, 1, 0.15)
    b:SetScript("OnClick", click)
    b:SetScript("OnEnter", function(self)
        GameTooltip:SetOwner(self, "ANCHOR_TOP")
        GameTooltip:SetText(self.working and "Stop" or "Send (Enter)")
        GameTooltip:Show()
    end)
    b:SetScript("OnLeave", function()
        GameTooltip:Hide()
    end)
    local function dim(self)
        self:SetAlpha(self:IsEnabled() and 1 or 0.4)
    end
    b:HookScript("OnEnable", dim)
    b:HookScript("OnDisable", dim)
    return b
end

-- onHeightChanged receives the transcript's bottom inset in pixels.
function ns.UI.Composer.Build(chatPanel, onHeightChanged)
    onLayout = onHeightChanged
    inputBox = CreateFrame("Frame", nil, chatPanel, "BackdropTemplate")
    inputBox:SetPoint("BOTTOMLEFT", MARGIN, MARGIN)
    inputBox:SetPoint("BOTTOMRIGHT", -MARGIN, MARGIN)
    inputBox:SetHeight(WIDE_HEIGHT)
    box(inputBox, COLORS.raised, COLORS.lineStrong)
    inputScroll = CreateFrame("ScrollFrame", "WispAIInputScroll", inputBox)
    inputScroll:SetPoint("TOPLEFT", PAD, -12)
    inputScroll:SetPoint("BOTTOMRIGHT", -PAD, TOOLBAR)
    inputScroll:SetClipsChildren(true)
    placeholder = widgets.Label(inputBox, "Ask Wisp anything", COLORS.muted)
    widgets.ChatFont(placeholder, "Ask Wisp anything")
    placeholder:SetPoint("TOPLEFT", inputScroll, "TOPLEFT", 0, 0)
    ns.draft = CreateFrame("EditBox", "WispAIInput", inputScroll)
    ns.draft:SetMultiLine(true)
    ns.draft:SetAutoFocus(false)
    ns.UI.Widgets.ChatFont(ns.draft, "")
    ns.draft:SetMaxLetters(4000)
    ns.draft:SetPoint("TOPLEFT", inputScroll, "TOPLEFT")
    ns.draft:SetSize(inputScroll:GetWidth(), 1)
    inputScroll:SetScrollChild(ns.draft)
    local inputBar = CreateFrame("Slider", "WispAIInputScrollBar", inputBox, "BackdropTemplate")
    inputBar:SetOrientation("VERTICAL")
    inputBar:SetPoint("TOPLEFT", inputScroll, "TOPRIGHT", 1, 0)
    inputBar:SetPoint("BOTTOMLEFT", inputScroll, "BOTTOMRIGHT", 1, 0)
    inputBar:SetWidth(8)
    inputBar:SetFrameLevel(inputScroll:GetFrameLevel() + 1)
    box(inputBar, COLORS.window, COLORS.line)
    inputBar:SetMinMaxValues(0, 0)
    inputBar:SetValueStep(1)
    if inputBar.SetObeyStepOnDrag then
        inputBar:SetObeyStepOnDrag(false)
    end
    inputBar:SetThumbTexture("Interface\\Buttons\\WHITE8X8")
    inputBar:GetThumbTexture():SetSize(3, 16)
    inputBar:GetThumbTexture():SetVertexColor(unpack(COLORS.lineStrong))
    inputBar:SetScript("OnValueChanged", function(_, value)
        inputScroll:SetVerticalScroll(value)
    end)
    inputBar:Hide()
    local function scrollInput(value)
        local range = inputScroll:GetVerticalScrollRange()
        inputBar:SetMinMaxValues(0, range)
        inputBar:SetShown(range > 0)
        inputBar:SetValue(math.max(0, math.min(range, value)))
    end
    inputScroll:SetScript("OnVerticalScroll", function(_, value)
        if inputBar:GetValue() ~= value then
            inputBar:SetValue(value)
        end
    end)
    local function revealCursor(_, _, y, _, height)
        inputScroll:UpdateScrollChildRect()
        local top = -y
        local offset = inputScroll:GetVerticalScroll()
        if top < offset then
            scrollInput(top)
        elseif top + height > offset + inputScroll:GetHeight() then
            scrollInput(top + height - inputScroll:GetHeight())
        end
    end
    ns.draft:SetScript("OnCursorChanged", revealCursor)
    ns.draft:SetScript("OnTextChanged", function(self)
        inputScroll:UpdateScrollChildRect()
        scrollInput(self:GetText() == "" and 0 or inputScroll:GetVerticalScroll())
        refreshPlaceholder()
    end)
    inputScroll:SetScript("OnSizeChanged", function(_, width)
        ns.draft:SetWidth(width)
        inputScroll:UpdateScrollChildRect()
        scrollInput(inputScroll:GetVerticalScroll())
    end)
    inputScroll:SetScript("OnScrollRangeChanged", function()
        scrollInput(inputScroll:GetVerticalScroll())
    end)
    inputScroll:EnableMouseWheel(true)
    inputScroll:SetScript("OnMouseWheel", function(_, delta)
        scrollInput(inputScroll:GetVerticalScroll() - delta * 32)
    end)
    inputScroll:EnableMouse(true)
    inputScroll:SetScript("OnMouseDown", function()
        ns.draft:SetFocus()
    end)
    ns.draft:SetScript("OnEnterPressed", function(self)
        if IsShiftKeyDown() then
            self:Insert("\n")
        else
            ns.Chat.Submit()
        end
    end)
    ns.draft:SetScript("OnEscapePressed", function(self)
        self:ClearFocus()
        ns.UI.SetMinimized(true)
    end)
    send = makeSend(inputBox, function()
        local chat = ns.Chat.Current()
        if chat and chat.status == "working" then
            ns.Transport.Send({ type = "cancel", chat = ns.active })
        else
            ns.Chat.Submit()
        end
    end)
    ns.draft:SetScript("OnEditFocusGained", function()
        inputBox:SetBackdropBorderColor(unpack(COLORS.accentLine))
    end)
    ns.draft:SetScript("OnEditFocusLost", function()
        inputBox:SetBackdropBorderColor(unpack(COLORS.lineStrong))
    end)
    send:SetPoint("BOTTOMRIGHT", -8, 6)
    local meter = ns.UI.ConversationStatus.ContextMeter()
    if meter then
        meter:SetParent(inputBox)
        meter:ClearAllPoints()
        meter:SetPoint("RIGHT", send, "LEFT", -10, 0)
        meter.text:SetJustifyH("RIGHT")
    end
    local modelPicker = ns.UI.CreateModelControls(
        inputBox,
        "WispAIChatModelControls",
        ns.Chat.Current,
        function()
            ns.Chat.NewChat()
            return ns.Chat.Current()
        end
    )
    modelPicker:SetPoint("BOTTOMLEFT", 8, 9)
    if ChatFrameUtil and ChatFrameUtil.InsertLink then
        hooksecurefunc(ChatFrameUtil, "InsertLink", function(link)
            if ns.draft:HasFocus() then
                ns.draft:Insert(link)
            end
        end)
    end
    inputBox:SetScript("OnSizeChanged", layout)
end
