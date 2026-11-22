local helper = require("addon.tests.support")

-- Builds the header status beside a stub minimize button and returns its label and dot.
local function buildStatus(env)
    setfenv(1, env)
    helper.fixture("addon/tests/wow-ui-stub.lua", env)
    ns = helper.namespace({ db = {}, connected = true, exhausted = false })
    ns.Transport.needsDesktopSetup = false
    helper.addon("UI/Widgets.lua", env)
    helper.addon("UI/ConversationStatus.lua", env)
    local header = CreateFrame("Frame", "WispAIHeader")
    header.mini = CreateFrame("Button", "WispAIMinimize", header)
    header.title = header:CreateFontString()
    ns.UI.ConversationStatus.Build(CreateFrame("Frame", "WispAIChatPanel"), header)
    local status, mark
    for _, widget in ipairs(UI_TEST.widgets) do
        local _, relative = widget:GetPoint()
        if widget.point and relative == header.mini then
            status = widget
        end
    end
    for _, widget in ipairs(UI_TEST.widgets) do
        local _, relative = widget:GetPoint()
        if widget.kind == "Texture" and widget.point and relative == status then
            mark = widget
        end
    end
    assert(status and mark, "the header must build a status label and its dot")
    return status, mark
end

it("hides the header status dot while the connection is healthy", function()
    local env = helper.env()
    setfenv(1, env)
    local status, mark = buildStatus(env)
    ns.UI.ConversationStatus.Refresh(nil)
    assert(not status:IsShown(), "a healthy connection must not show a status label")
    assert(not mark:IsShown(), "a healthy connection must not show the warning dot")
end)

it("shows the header status dot with the setup text when setup is required", function()
    local env = helper.env()
    setfenv(1, env)
    local status, mark = buildStatus(env)
    ns.Transport.needsDesktopSetup = true
    ns.UI.ConversationStatus.Refresh(nil)
    assert(status:IsShown() and status:GetText() == "Setup required")
    assert(mark:IsShown(), "a setup problem must show the warning dot")
end)
