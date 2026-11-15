local _, ns = ...
local label, setText, MUTED = ns.UI.Widgets.Label, ns.UI.Widgets.SetText, ns.UI.Widgets.MUTED
local sessionTitle, status, contextMeter

function ns.UI.ConversationStatus.Refresh(chat)
    setText(
        status,
        ns.Transport.needsDesktopSetup and "Setup required"
            or ns.exhausted and "Channels exhausted: /reload"
            or (ns.connected and "Connected" or "Open Wisp Desktop")
    )
    local usage = chat and chat.usage
    local window = ns.contextPolicy and ns.contextPolicy.windowTokens
    local measured = usage and usage.contextTokens
    local meterText = usage and usage.compacting and "Compacting..."
        or (measured and window and string.format("Context ~%.0f%%", measured / window * 100))
        or "Context --"
    setText(contextMeter.text, meterText)
    setText(sessionTitle, chat and chat.title or "New conversation")
end

function ns.UI.ConversationStatus.Build(chatPanel)
    sessionTitle = label(chatPanel, "New conversation", MUTED)
    sessionTitle:SetPoint("TOPLEFT", 12, -9)
    sessionTitle:SetPoint("RIGHT", -12, 0)
    sessionTitle:SetWordWrap(false)
    status = label(chatPanel, "Open Wisp Desktop", MUTED)
    status:SetPoint("BOTTOMLEFT", 12, 6)
    contextMeter = CreateFrame("Button", "WispAIContextUsage", chatPanel)
    contextMeter:SetSize(112, 16)
    contextMeter:SetPoint("BOTTOMRIGHT", -22, 3)
    contextMeter.text = label(contextMeter, "Context --", MUTED)
    contextMeter.text:SetAllPoints(contextMeter)
    contextMeter.text:SetJustifyH("RIGHT")
    contextMeter:SetScript("OnEnter", function(self)
        local chat = ns.Chat.Current()
        local usage = chat and chat.usage
        local policy = ns.contextPolicy or {}
        GameTooltip:SetOwner(self, "ANCHOR_TOP")
        GameTooltip:AddLine("Conversation context")
        if usage and usage.contextTokens then
            GameTooltip:AddLine(
                string.format("Last measured context: %d tokens", usage.contextTokens),
                1,
                1,
                1
            )
        else
            GameTooltip:AddLine("Context size not measured yet", 1, 1, 1)
        end
        if policy.windowTokens then
            GameTooltip:AddLine(
                string.format("Model capacity: %d tokens", policy.windowTokens),
                1,
                1,
                1
            )
        end
        if policy.compactAt then
            GameTooltip:AddLine(
                string.format(
                    "Auto compact: %.0f%% (includes summary overhead)",
                    policy.compactAt * 100
                ),
                1,
                1,
                1
            )
        end
        if usage then
            GameTooltip:AddLine(
                string.format(
                    "Observed input / output: %d / %d",
                    usage.inputTokens or 0,
                    usage.outputTokens or 0
                ),
                1,
                1,
                1
            )
            GameTooltip:AddLine(
                string.format(
                    "Cached input: %d | Compactions: %d",
                    usage.cacheReadTokens or 0,
                    usage.compactions or 0
                ),
                1,
                1,
                1
            )
        end
        GameTooltip:AddLine(
            "Context is approximate between model calls. Totals count repeated input and exclude separate search requests.",
            0.7,
            0.7,
            0.7,
            true
        )
        GameTooltip:AddLine(
            "This is conversation space, not your subscription allowance. Older context is summarized; chat messages stay visible.",
            0.7,
            0.7,
            0.7,
            true
        )
        GameTooltip:Show()
    end)
    contextMeter:SetScript("OnLeave", function()
        GameTooltip:Hide()
    end)
end
