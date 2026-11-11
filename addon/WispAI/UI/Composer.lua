local _, ns = ...
local box, button = ns.UI.Widgets.Box, ns.UI.Widgets.Button
local inputBox, inputScroll, send, onLayout
local narrow

local function layout()
    local nextNarrow = inputBox:GetWidth() < 380
    if narrow ~= nextNarrow then
        narrow = nextNarrow
        inputBox:SetHeight(narrow and 106 or 78)
        inputScroll:SetPoint("BOTTOMRIGHT", -10, narrow and 56 or 28)
        send:ClearAllPoints()
        send:SetPoint("BOTTOMRIGHT", -7, narrow and 31 or 5)
        onLayout(narrow and 132 or 104)
    end
end

function ns.UI.Composer.Refresh(chat)
    ns.UI.RefreshModelControls()
    layout()
    local sendText = chat and chat.status == "working" and "Stop" or "Send"
    if send.lastText ~= sendText then
        send.lastText = sendText
        send:SetText(sendText)
    end
end

-- onHeightChanged receives the transcript's bottom inset in pixels.
function ns.UI.Composer.Build(chatPanel, onHeightChanged)
    onLayout = onHeightChanged
    inputBox = CreateFrame("Frame", nil, chatPanel, "BackdropTemplate")
    inputBox:SetPoint("BOTTOMLEFT", 9, 22)
    inputBox:SetPoint("BOTTOMRIGHT", -9, 22)
    inputBox:SetHeight(78)
    box(inputBox, { 0.045, 0.04, 0.03, 1 }, 9)
    inputScroll = CreateFrame("ScrollFrame", "WispAIInputScroll", inputBox)
    inputScroll:SetPoint("TOPLEFT", 10, -7)
    inputScroll:SetPoint("BOTTOMRIGHT", -10, 28)
    inputScroll:SetClipsChildren(true)
    ns.draft = CreateFrame("EditBox", "WispAIInput", inputScroll)
    ns.draft:SetMultiLine(true)
    ns.draft:SetAutoFocus(false)
    ns.draft:SetFontObject(ChatFontNormal)
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
    box(inputBar, { 0.08, 0.07, 0.05, 1 }, 2)
    inputBar:SetMinMaxValues(0, 0)
    inputBar:SetValueStep(1)
    if inputBar.SetObeyStepOnDrag then
        inputBar:SetObeyStepOnDrag(false)
    end
    inputBar:SetThumbTexture("Interface\\Buttons\\UI-ScrollBar-Knob")
    inputBar:GetThumbTexture():SetSize(8, 16)
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
    send = button(inputBox, "Send", 75, function()
        local chat = ns.Chat.Current()
        if chat and chat.status == "working" then
            ns.Transport.Send({ type = "cancel", chat = ns.active })
        else
            ns.Chat.Submit()
        end
    end)
    send:SetPoint("BOTTOMRIGHT", -7, 5)
    local modelPicker = ns.UI.CreateModelControls(
        inputBox,
        "WispAIChatModelControls",
        ns.Chat.Current,
        function()
            ns.Chat.NewChat()
            return ns.Chat.Current()
        end
    )
    modelPicker:SetPoint("BOTTOMLEFT", 10, 5)
    if ChatFrameUtil and ChatFrameUtil.InsertLink then
        hooksecurefunc(ChatFrameUtil, "InsertLink", function(link)
            if ns.draft:HasFocus() then
                ns.draft:Insert(link)
            end
        end)
    end
    inputBox:SetScript("OnSizeChanged", layout)
end
