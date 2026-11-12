local helper = require("addon.tests.support")

local function setup(env)
    setfenv(1, env)
    helper.fixture("addon/tests/wow-ui-stub.lua", env)
end

it("native layout places prose on both sides of a panel", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)
    do
        ns = helper.namespace()
        host = CreateFrame("Frame")
    end
    helper.addon("UI/RichUI.lua", env)

    local message = {
        ui = { { id = "panel", kind = "card", title = "Panel" } },
        parts = {
            { type = "text", text = "Before" },
            { type = "ui", id = "panel" },
            { type = "text", text = "After" },
        },
    }
    ns.UI.RenderRichUI(host, {}, message, 300)
    assert(host.prose[1].point[5] > host.widgets.panel.point[5])
    assert(host.widgets.panel.point[5] > host.prose[2].point[5])
    message.parts = nil
    ns.UI.RenderRichUI(host, {}, message, 300)
    assert(not host.prose[1]:IsShown() and not host.prose[2]:IsShown())
    assert(host.widgets.panel.point[5] == 0)
end)

it("fades each live native panel once while preserving its layout", function()
    local env = helper.env()
    setup(env)
    env.ns = helper.namespace()
    helper.addon("UI/Window.lua", env)

    local row = env.ns.UI.MakeMessageRow(env.CreateFrame("Frame"))
    local chat = { id = "chat", status = "working" }
    local message = {
        id = "reply",
        role = "assistant",
        text = "A|B\n---|---\nx|y",
        ui = { { id = "history", kind = "card", title = "History" } },
    }
    env.ns.UI.RenderMessageRow(row, chat, message, 300, false)
    message.ui[2] = { id = "panel", kind = "card", title = "New panel" }
    env.ns.UI.RenderMessageRow(row, chat, message, 300, false, true)
    local host, height = row.rich, row.height
    local panel = host.widgets.panel
    local anchor = panel.point[5]
    local fade = panel.entranceFade
    assert.is_true(fade:IsPlaying())
    assert.equal("Alpha", fade.animation.kind)
    assert.equal(0, fade.animation.fromAlpha)
    assert.equal(1, fade.animation.toAlpha)
    assert.equal(0.18, fade.animation.duration)
    assert.is_nil(host.widgets.history.entranceFade)
    assert.is_nil(host.widgets.markdown_table_1.entranceFade)

    message.ui[2].title = "Updated panel"
    env.ns.UI.RenderMessageRow(row, chat, message, 300, false, true)
    assert.equal(height, row.height)
    assert.equal(anchor, panel.point[5])
    assert.equal(1, fade.playCount)

    message.streaming = true
    message.text = message.text .. "\n\nMore prose."
    env.ns.UI.RenderMessageRow(row, chat, message, 300, false, true)
    assert.is_true(row.height > height)
    assert.is_true(fade:IsPlaying())
    assert.equal(1, fade.playCount)

    panel.scripts.OnHide(panel)
    assert.is_false(fade:IsPlaying())
    assert.equal(1, panel:GetAlpha())
    env.ns.UI.RenderMessageRow(row, chat, message, 320, false, true)
    assert.is_false(fade:IsPlaying())

    message.ui[3] = { id = "second", kind = "card", title = "Another panel" }
    env.ns.UI.RenderMessageRow(row, chat, message, 320, false, true)
    assert.is_true(host.widgets.second.entranceFade:IsPlaying())
end)

it(
    "native components preserve local edits across snapshots and dispatch registered button IDs",
    function()
        local env = helper.env()
        setfenv(1, env)
        setup(env)
        do
            ns = helper.namespace({ db = {}, workStarted = {} })
            function ns.Character.Capture()
                return { fresh = true }
            end
            function ns.Transport.Send(packet)
                sent = packet
            end
            function ns.UI.FormatText(t)
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
        helper.addon("UI/RichUI.lua", env)

        local height = ns.UI.RenderRichUI(host, chat, message, 350)
        assert(height > 60)
        local toggle = host.widgets.toggle.control
        toggle:SetChecked(false)
        toggle.scripts.OnClick(toggle)
        local select = host.widgets.select.control
        select.scripts.OnClick()
        assert(host.values.select == "b")
        local count = #UI_TEST.widgets
        ns.UI.RenderRichUI(host, chat, message, 350)
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
        ns.UI.RenderRichUI(host, chat, message, 350)
        assert(not host.widgets.button.control.enabled)
    end
)

it("saved panels preserve controls after reload and can regroup or replace nodes", function()
    local env = helper.env()
    setfenv(1, env)
    setup(env)
    do
        ns = helper.namespace()
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
    helper.addon("UI/RichUI.lua", env)

    ns.UI.RenderRichUI(host, chat, message, 300)
    assert(
        not host.widgets.choice.control:GetChecked(),
        "saved choice must survive widget creation"
    )
    message.ui = {
        { id = "root", kind = "column" },
        { id = "group", parent = "root", kind = "card" },
        { id = "choice", parent = "group", kind = "toggle", label = "Enabled", value = true },
    }
    ns.UI.RenderRichUI(host, chat, message, 300)
    assert(
        host.widgets.choice:GetParent() == host.widgets.group
            and not host.widgets.choice.control:GetChecked()
    )
    local old = host.widgets.choice
    message.ui[3] =
        { id = "choice", parent = "group", kind = "stat", label = "State", value = "Updated" }
    ns.UI.RenderRichUI(host, chat, message, 300)
    assert(
        host.widgets.choice ~= old and not old:IsShown() and host.widgets.choice.nodeKind == "stat"
    )
end)
