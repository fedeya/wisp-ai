local helper = require("addon.tests.support")

local function setup(_ENV)
    helper.fixture("addon/tests/wow-ui-stub.lua", _ENV)
end

it("native layout places prose on both sides of a panel", function()
    local _ENV = helper.env()
    setup(_ENV)
    do
        C = {}
        host = CreateFrame("Frame")
    end
    helper.addon("RichUI.lua", _ENV)

    local message = {
        ui = { { id = "panel", kind = "card", title = "Panel" } },
        parts = {
            { type = "text", text = "Before" },
            { type = "ui", id = "panel" },
            { type = "text", text = "After" },
        },
    }
    C.RenderRichUI(host, {}, message, 300)
    assert(host.prose[1].point[5] > host.widgets.panel.point[5])
    assert(host.widgets.panel.point[5] > host.prose[2].point[5])
    message.parts = nil
    C.RenderRichUI(host, {}, message, 300)
    assert(not host.prose[1]:IsShown() and not host.prose[2]:IsShown())
    assert(host.widgets.panel.point[5] == 0)
end)

it(
    "native components preserve local edits across snapshots and dispatch registered button IDs",
    function()
        local _ENV = helper.env()
        setup(_ENV)
        do
            C = { db = {}, workStarted = {} }
            function C.Capture()
                return { fresh = true }
            end
            function C.Send(packet)
                sent = packet
            end
            function C.FormatText(t)
                return t
            end
            chat = { id = "chat", status = "done" }
            message = {
                id = "reply",
                ui = {
                    { id = "panel", kind = "card", title = "Choices" },
                    {
                        id = "toggle",
                        parent = "panel",
                        kind = "toggle",
                        label = "Show",
                        value = true,
                    },
                    {
                        id = "select",
                        parent = "panel",
                        kind = "select",
                        label = "Mode",
                        value = "a",
                        options = { { value = "a", label = "A" }, { value = "b", label = "B" } },
                    },
                    {
                        id = "button",
                        parent = "panel",
                        kind = "button",
                        label = "Continue",
                        action = { kind = "ask", prompt = "Continue" },
                    },
                },
            }
            host = CreateFrame("Frame")
        end
        helper.addon("RichUI.lua", _ENV)

        local height = C.RenderRichUI(host, chat, message, 350)
        assert(height > 60)
        local toggle = host.widgets.toggle.control
        toggle:SetChecked(false)
        toggle.scripts.OnClick(toggle)
        local select = host.widgets.select.control
        select.scripts.OnClick()
        assert(host.values.select == "b")
        local count = #UI_TEST.widgets
        C.RenderRichUI(host, chat, message, 350)
        assert(
            #UI_TEST.widgets == count
                and host.values.toggle == false
                and host.values.select == "b"
                and not toggle:GetChecked(),
            "snapshots must preserve edits and widgets"
        )
        host.widgets.button.control.scripts.OnClick()
        assert(
            sent.type == "ui_action"
                and sent.chat == "chat"
                and sent.messageId == "reply"
                and sent.nodeId == "button"
                and sent.values.toggle == false
                and sent.context.fresh
        )
        assert(chat.status == "working")
        C.RenderRichUI(host, chat, message, 350)
        assert(not host.widgets.button.control.enabled)
    end
)

it("saved panels preserve controls after reload and can regroup or replace nodes", function()
    local _ENV = helper.env()
    setup(_ENV)
    do
        C = {}
        host = CreateFrame("Frame")
        host.values = { choice = false }
        host.sourceValues = { choice = true }
        chat = { status = "idle" }
        message = {
            ui = {
                { id = "root", kind = "column" },
                {
                    id = "choice",
                    parent = "root",
                    kind = "toggle",
                    label = "Enabled",
                    value = true,
                },
            },
        }
    end
    helper.addon("RichUI.lua", _ENV)

    C.RenderRichUI(host, chat, message, 300)
    assert(
        not host.widgets.choice.control:GetChecked(),
        "saved choice must survive widget creation"
    )
    message.ui = {
        { id = "root", kind = "column" },
        { id = "group", parent = "root", kind = "card" },
        { id = "choice", parent = "group", kind = "toggle", label = "Enabled", value = true },
    }
    C.RenderRichUI(host, chat, message, 300)
    assert(
        host.widgets.choice:GetParent() == host.widgets.group
            and not host.widgets.choice.control:GetChecked()
    )
    local old = host.widgets.choice
    message.ui[3] =
        { id = "choice", parent = "group", kind = "stat", label = "State", value = "Updated" }
    C.RenderRichUI(host, chat, message, 300)
    assert(
        host.widgets.choice ~= old and not old:IsShown() and host.widgets.choice.nodeKind == "stat"
    )
end)
