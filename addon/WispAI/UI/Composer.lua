local _, ns = ...
local L = ns.L
local widgets = ns.UI.Widgets
local COLORS = widgets.COLORS
local TEXTURES = widgets.TEXTURES
local SEND_ICON, STOP_ICON = TEXTURES .. "Send.tga", TEXTURES .. "Stop.tga"
local CIRCLE = TEXTURES .. "Circle.tga"
local INK = { 0.039, 0.078, 0.071 } -- dark ink on the accent
-- The composer follows the chat apps: a rounded field that starts one line
-- tall with a round send button inside, and grows upward with its text up to
-- MAX_HEIGHT, then scrolls. Model choices and the context meter sit in a quiet
-- row below the field.
local MARGIN, PAD_X, SEND_SIZE = 14, 14, 24
local MIN_HEIGHT, MAX_HEIGHT = 40, 168
local BELOW = 30 -- the row under the field, with breathing room above it
local METER_MIN_WIDTH = 400 -- below this field width the meter yields to the model choices
local inputBox, frameShape, inputScroll, send, placeholder, meter, onLayout
local fieldHeight, padY

-- The vertical padding that centers one line of the draft's font in the
-- one-line field, so its text lines up with the send button's center.
local function placeText()
    local _, size = ns.draft:GetFont()
    local nextPad = math.max(6, math.floor((MIN_HEIGHT - (size or 12)) / 2 + 0.5))
    if padY ~= nextPad then
        padY = nextPad
        inputScroll:SetPoint("TOPLEFT", PAD_X, -padY)
        inputScroll:SetPoint("BOTTOMRIGHT", -(SEND_SIZE + 18), padY)
        fieldHeight = nil
    end
end

-- Fits the field to its text, from one line up to MAX_HEIGHT, and moves the
-- transcript's bottom edge with it.
local function fit()
    placeText()
    local textHeight = ns.draft:GetHeight() or 0
    local height = math.max(MIN_HEIGHT, math.min(MAX_HEIGHT, math.ceil(textHeight) + padY * 2))
    if fieldHeight ~= height then
        fieldHeight = height
        inputBox:SetHeight(height)
        onLayout(height + MARGIN + BELOW + 6)
    end
    if meter then
        meter:SetShown(inputBox:GetWidth() >= METER_MIN_WIDTH)
    end
end

-- Send reads as ready only with something to send; while Wisp replies it is Stop.
local function paintSend()
    local working = send.working
    local ready = working or ns.draft:GetText():find("%S") ~= nil
    if send.ready == ready and send.paintedWorking == working then
        return
    end
    send.ready, send.paintedWorking = ready, working
    send.icon:SetTexture(working and STOP_ICON or SEND_ICON)
    if ready then
        send.circle:SetVertexColor(COLORS.accent[1], COLORS.accent[2], COLORS.accent[3], 1)
        send.icon:SetVertexColor(unpack(INK))
    else
        send.circle:SetVertexColor(1, 1, 1, 0.10)
        send.icon:SetVertexColor(unpack(COLORS.muted))
    end
end

local function refreshDraft()
    placeholder:SetShown(ns.draft:GetText() == "")
    paintSend()
    fit()
end

-- A new conversation puts the field in the middle of the panel, under the
-- greeting, the way chat apps open; it docks at the bottom once the chat starts.
local CENTERED_WIDTH, CENTERED_MIN_HEIGHT = 560, 400
local centered = false

local function placeField()
    local panel = inputBox:GetParent()
    inputBox:ClearAllPoints()
    if centered then
        local width = math.min(CENTERED_WIDTH, (panel:GetWidth() or 0) - MARGIN * 4)
        inputBox:SetWidth(math.max(240, width))
        -- Anchored by its bottom so a longer draft grows upward.
        inputBox:SetPoint("BOTTOM", panel, "CENTER", 0, -MIN_HEIGHT / 2 + 10)
    else
        inputBox:SetPoint("BOTTOMLEFT", MARGIN, MARGIN + BELOW)
        inputBox:SetPoint("BOTTOMRIGHT", -MARGIN, MARGIN + BELOW)
    end
end

--- True when the panel is tall enough to open a new chat with the field centered.
function ns.UI.Composer.CanCenter()
    local panel = inputBox and inputBox:GetParent()
    return panel ~= nil and (panel:GetHeight() or 0) >= CENTERED_MIN_HEIGHT
end

function ns.UI.Composer.SetCentered(value)
    value = value == true
    if centered == value then
        return
    end
    centered = value
    placeField()
end

--- The rounded field, for laying out the new-chat greeting around it.
function ns.UI.Composer.Field()
    return inputBox
end

function ns.UI.Composer.Refresh(chat)
    ns.UI.RefreshModelControls()
    fit()
    send:SetEnabled(not ns.Transport.needsDesktopSetup)
    send.working = chat and chat.status == "working" or false
    paintSend()
end

--- Round button with an icon: send, or stop while Wisp is replying.
local function makeSend(parent, click)
    local b = CreateFrame("Button", "WispAISendButton", parent)
    b:SetSize(SEND_SIZE, SEND_SIZE)
    b.circle = b:CreateTexture(nil, "BACKGROUND")
    b.circle:SetAllPoints()
    b.circle:SetTexture(CIRCLE)
    b.icon = b:CreateTexture(nil, "ARTWORK")
    b.icon:SetSize(11, 11)
    b.icon:SetPoint("CENTER")
    b.icon:SetTexture(SEND_ICON)
    local hover = b:CreateTexture(nil, "HIGHLIGHT")
    hover:SetAllPoints()
    hover:SetTexture(CIRCLE)
    hover:SetVertexColor(1, 1, 1, 0.15)
    b:SetScript("OnClick", click)
    b:SetScript("OnEnter", function(self)
        GameTooltip:SetOwner(self, "ANCHOR_TOP")
        GameTooltip:SetText(self.working and L["composer.stop"] or L["composer.sendHint"])
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
    inputBox = CreateFrame("Frame", nil, chatPanel)
    inputBox:SetPoint("BOTTOMLEFT", MARGIN, MARGIN + BELOW)
    inputBox:SetPoint("BOTTOMRIGHT", -MARGIN, MARGIN + BELOW)
    inputBox:SetHeight(MIN_HEIGHT)
    frameShape = widgets.RoundedBox(inputBox, COLORS.raised, COLORS.lineStrong)
    send = makeSend(inputBox, function()
        local chat = ns.Chat.Current()
        if chat and chat.status == "working" then
            ns.Transport.Send({ type = "cancel", chat = ns.active })
        else
            ns.Chat.Submit()
        end
    end)
    send:SetPoint("BOTTOMRIGHT", -8, 8)
    inputScroll = CreateFrame("ScrollFrame", "WispAIInputScroll", inputBox)
    -- Placeholder padding; placeText() centers it on the draft font once it exists.
    inputScroll:SetPoint("TOPLEFT", PAD_X, -14)
    inputScroll:SetPoint("BOTTOMRIGHT", -(SEND_SIZE + 18), 14)
    inputScroll:SetClipsChildren(true)
    placeholder = widgets.Label(inputBox, L["composer.placeholder"], COLORS.muted)
    widgets.ChatFont(placeholder, L["composer.placeholder"])
    placeholder:SetPoint("TOPLEFT", inputScroll, "TOPLEFT", 0, 0)
    ns.draft = CreateFrame("EditBox", "WispAIInput", inputScroll)
    ns.draft:SetMultiLine(true)
    ns.draft:SetAutoFocus(false)
    widgets.ChatFont(ns.draft, "")
    ns.draft:SetMaxLetters(4000)
    ns.draft:SetPoint("TOPLEFT", inputScroll, "TOPLEFT")
    ns.draft:SetSize(inputScroll:GetWidth(), 1)
    inputScroll:SetScrollChild(ns.draft)
    local inputBar = CreateFrame("Slider", "WispAIInputScrollBar", inputBox, "BackdropTemplate")
    inputBar:SetOrientation("VERTICAL")
    inputBar:SetPoint("TOPLEFT", inputScroll, "TOPRIGHT", 4, 0)
    inputBar:SetPoint("BOTTOMLEFT", inputScroll, "BOTTOMRIGHT", 4, 0)
    inputBar:SetWidth(6)
    inputBar:SetFrameLevel(inputScroll:GetFrameLevel() + 1)
    widgets.Box(inputBar, { 0, 0, 0, 0 }, { 0, 0, 0, 0 })
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
        refreshDraft()
    end)
    inputScroll:SetScript("OnSizeChanged", function(_, width)
        ns.draft:SetWidth(width)
        inputScroll:UpdateScrollChildRect()
        scrollInput(inputScroll:GetVerticalScroll())
    end)
    inputScroll:SetScript("OnScrollRangeChanged", function()
        scrollInput(inputScroll:GetVerticalScroll())
        fit()
    end)
    inputScroll:EnableMouseWheel(true)
    inputScroll:SetScript("OnMouseWheel", function(_, delta)
        scrollInput(inputScroll:GetVerticalScroll() - delta * 32)
    end)
    -- A click anywhere in the field, padding included, focuses the draft.
    local function focusDraft()
        ns.draft:SetFocus()
    end
    inputScroll:EnableMouse(true)
    inputScroll:SetScript("OnMouseDown", focusDraft)
    inputBox:EnableMouse(true)
    inputBox:SetScript("OnMouseDown", focusDraft)
    ns.draft:SetScript("OnEnterPressed", function(self)
        if IsShiftKeyDown() then
            self:Insert("\n")
        else
            ns.Chat.Submit()
        end
    end)
    ns.draft:SetScript("OnEscapePressed", function(self)
        self:ClearFocus()
        if not ns.UI.GoBack() then
            ns.UI.SetMinimized(true)
        end
    end)
    ns.draft:SetScript("OnEditFocusGained", function()
        frameShape.SetColors(COLORS.raised, COLORS.accentLine)
    end)
    ns.draft:SetScript("OnEditFocusLost", function()
        frameShape.SetColors(COLORS.raised, COLORS.lineStrong)
    end)
    -- The quiet row below the field: model choices left, context right.
    local modelPicker = ns.UI.CreateModelControls(
        chatPanel,
        "WispAIChatModelControls",
        ns.Chat.Current,
        function()
            ns.Chat.NewChat()
            return ns.Chat.Current()
        end
    )
    modelPicker:SetPoint("TOPLEFT", inputBox, "BOTTOMLEFT", 2, -8)
    meter = ns.UI.ConversationStatus.ContextMeter()
    if meter then
        meter:SetParent(chatPanel)
        meter:ClearAllPoints()
        meter:SetPoint("TOPRIGHT", inputBox, "BOTTOMRIGHT", -6, -11)
        meter.text:SetJustifyH("RIGHT")
    end
    if ChatFrameUtil and ChatFrameUtil.InsertLink then
        hooksecurefunc(ChatFrameUtil, "InsertLink", function(link)
            if ns.draft:HasFocus() then
                ns.draft:Insert(link)
            end
        end)
    end
    inputBox:SetScript("OnSizeChanged", fit)
    chatPanel:HookScript("OnSizeChanged", function()
        if centered then
            placeField()
        end
    end)
    fit()
end
