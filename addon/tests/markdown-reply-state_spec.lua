local helper = require("addon.tests.support")

local function setup()
    local env = helper.env()
    helper.fixture("addon/tests/wow-ui-stub.lua", env)
    env.ns = helper.namespace()
    helper.addon("UI/Window.lua", env)
    return env, env.ns
end

local function reply(source, id)
    return { id = id or "reply", role = "assistant", text = source }
end

local function drain(ns)
    for _ = 1, 2000 do
        local _, pending = ns.Markdown.Cache.Step()
        if pending == 0 then
            return
        end
    end
    error("Markdown did not settle")
end

local tableSource = "A|B\n---|---\nx|y"
local longSuffix = "\n\n" .. string.rep("**dense** `literal` ", 100)

it(
    "reuses completed presentation while taking every metadata field from the current reply",
    function()
        local _, ns = setup()
        local state = ns.Markdown.ReplyView.New()
        local original = reply(tableSource)
        original.rawReply, original.futureMetadata = "old events", { version = 1 }
        local first, firstKey = ns.Markdown.ReplyView.Update(state, "chat", original)
        local replacement = reply(tableSource, "replacement")
        replacement.rawReply, replacement.futureMetadata = "new events", { version = 2 }
        local current, currentKey = ns.Markdown.ReplyView.Update(state, "chat", replacement)
        assert.equal(first.ui, current.ui)
        assert.equal(first.parts, current.parts)
        assert.equal("replacement", current.id)
        assert.equal("new events", current.rawReply)
        assert.equal(replacement.futureMetadata, current.futureMetadata)
        assert.are_not.equal(firstKey, currentKey)
        replacement.rawReply, replacement.futureMetadata = nil, nil
        local latest, latestKey = ns.Markdown.ReplyView.Update(state, "chat", replacement)
        assert.is_nil(latest.rawReply)
        assert.is_nil(latest.futureMetadata)
        assert.equal(currentKey, latestKey)
        local _, otherChatKey = ns.Markdown.ReplyView.Update(state, "other chat", replacement)
        assert.are_not.equal(latestKey, otherChatKey)
    end
)

it("never carries a retained assistant view into a different reply or a user row", function()
    local _, ns = setup()
    local state, original = ns.Markdown.ReplyView.New(), reply(tableSource)
    original.streaming = true
    local stable = ns.Markdown.ReplyView.Update(state, "chat", original)
    original.text = tableSource .. longSuffix
    local waiting = ns.Markdown.ReplyView.Update(state, "chat", original)
    assert.is_true(waiting._markdownPending)
    assert.equal(stable.parts, waiting.parts)
    original.id = "different reply"
    local recycled = ns.Markdown.ReplyView.Update(state, "chat", original)
    assert.is_true(recycled._markdownPending)
    assert.equal(0, #recycled.ui)
    assert.are_not.equal(stable.parts, recycled.parts)
    local user = { id = original.id, role = "user", text = "|Hitem:100|h[Native]|h" }
    assert.equal(user, ns.Markdown.ReplyView.Update(state, "chat", user))
    local nextReply = reply("Fresh text", user.id)
    local fresh = ns.Markdown.ReplyView.Update(state, "chat", nextReply)
    assert.equal("Fresh text", fresh.parts[1].text)
    assert.equal(0, #fresh.ui)
    assert.is_false(fresh._markdownPending)
end)

it("cancels obsolete part sources without cancelling unchanged pending parts", function()
    local _, ns = setup()
    local state, original = ns.Markdown.ReplyView.New(), reply("canonical source remains unchanged")
    original.parts = {
        { type = "text", text = tableSource },
        { type = "text", text = "first" .. longSuffix },
        { type = "text", text = "shared" .. longSuffix },
    }
    local cancelled, cancel = {}, ns.Markdown.Cache.Cancel
    ns.Markdown.Cache.Cancel = function(source, inline)
        cancelled[#cancelled + 1] = source
        return cancel(source, inline)
    end
    local first = ns.Markdown.ReplyView.Update(state, "chat", original)
    assert.is_true(first._markdownPending)
    local old, shared = original.parts[2].text, original.parts[3].text
    original.parts[2].text = "replacement" .. longSuffix
    local changed = ns.Markdown.ReplyView.Update(state, "chat", original)
    assert.is_true(changed._markdownPending)
    assert.same({ old }, cancelled)
    local user = { id = original.id, role = "user", text = "user" }
    ns.Markdown.ReplyView.Update(state, "chat", user)
    assert.same({ old, tableSource, original.parts[2].text, shared }, cancelled)
    drain(ns)
    local completed = ns.Markdown.ReplyView.Update(state, "chat", reply(tableSource))
    assert.equal(1, #completed.ui)
end)

it("retains compatible prefixes and replaces their presentation once syntax completes", function()
    local _, ns = setup()
    local state, original = ns.Markdown.ReplyView.New(), reply("same canonical source")
    original.parts = { { type = "text", text = tableSource } }
    local stable, stableKey = ns.Markdown.ReplyView.Update(state, "chat", original)
    original.parts[1].text = tableSource .. longSuffix
    local waiting, waitingKey = ns.Markdown.ReplyView.Update(state, "chat", original)
    assert.is_true(waiting._markdownPending)
    assert.equal(stable.parts, waiting.parts)
    assert.are_not.equal(stableKey, waitingKey)
    local unchanged, unchangedKey = ns.Markdown.ReplyView.Update(state, "chat", original)
    assert.equal(waiting.parts, unchanged.parts)
    assert.equal(waitingKey, unchangedKey)
    drain(ns)
    local completed, completedKey = ns.Markdown.ReplyView.Update(state, "chat", original)
    assert.is_false(completed._markdownPending)
    assert.are_not.equal(stable.parts, completed.parts)
    assert.are_not.equal(waitingKey, completedKey)
    assert.equal(1, #completed.ui)
    assert.is_truthy(completed.parts[2].text:find("dense", 1, true))
    original.parts[1].text = "different prefix" .. longSuffix
    local unrelated = ns.Markdown.ReplyView.Update(state, "chat", original)
    assert.is_true(unrelated._markdownPending)
    assert.equal(0, #unrelated.ui)
end)

it("refreshes mutable references and item data without reparsing cached syntax", function()
    local env, ns = setup()
    local state, original = ns.Markdown.ReplyView.New(), reply("[[ref:robe]]")
    original.references = { robe = { kind = "item", id = 100, label = "Old robe" } }
    local parse, calls = ns.Markdown.Parse, 0
    ns.Markdown.Parse = function(...)
        calls = calls + 1
        return parse(...)
    end
    local first, firstKey = ns.Markdown.ReplyView.Update(state, "chat", original)
    assert.is_truthy(first.parts[1].text:find("[Old robe]", 1, true))
    original.references.robe.label = "Current robe"
    local changed, changedKey = ns.Markdown.ReplyView.Update(state, "chat", original)
    assert.is_truthy(changed.parts[1].text:find("[Current robe]", 1, true))
    assert.are_not.equal(firstKey, changedKey)
    env.GetItemIcon = function()
        return "LoadedIcon"
    end
    ns.itemRevision = ns.itemRevision + 1
    local loaded, loadedKey = ns.Markdown.ReplyView.Update(state, "chat", original)
    assert.is_truthy(loaded.parts[1].text:find("|TLoadedIcon:", 1, true))
    assert.are_not.equal(changedKey, loadedKey)
    assert.equal(1, calls)
end)

it(
    "does not retain stale reference labels or native components while new syntax is pending",
    function()
        local _, ns = setup()
        local state, original = ns.Markdown.ReplyView.New(), reply("A|B\n---|---\n[[ref:robe]]|y")
        original.references = { robe = { kind = "item", id = 100, label = "Old robe" } }
        original.ui = { { id = "action", kind = "button", label = "Old action" } }
        local stable = ns.Markdown.ReplyView.Update(state, "chat", original)
        original.text = original.text .. longSuffix
        original.references.robe.label = "Current robe"
        original.ui = { { id = "action", kind = "button", label = "Current action" } }
        local waiting = ns.Markdown.ReplyView.Update(state, "chat", original)
        assert.is_true(waiting._markdownPending)
        assert.are_not.equal(stable.parts, waiting.parts)
        assert.equal(1, #waiting.ui)
        assert.equal(original.ui[1], waiting.ui[1])
        drain(ns)
        local current = ns.Markdown.ReplyView.Update(state, "chat", original)
        assert.is_truthy(current.ui[2].rows[1][1]:find("[Current robe]", 1, true))
        assert.equal("Current action", current.ui[1].label)
    end
)

it(
    "keeps stable keys across unrelated syntax work and changes layout without reprojecting",
    function()
        local _, ns = setup()
        local state, original = ns.Markdown.ReplyView.New(), reply(tableSource)
        local first, firstKey = ns.Markdown.ReplyView.Update(state, "chat", original)
        ns.Markdown.ReplyView.Rendered(state, false)
        ns.Markdown.Cache.Get("unrelated" .. longSuffix)
        drain(ns)
        local same, sameKey = ns.Markdown.ReplyView.Update(state, "chat", original)
        assert.equal(firstKey, sameKey)
        assert.equal(first.parts, same.parts)
        ns.Markdown.ReplyView.Invalidate()
        local layout, layoutKey = ns.Markdown.ReplyView.Update(state, "chat", original)
        assert.are_not.equal(sameKey, layoutKey)
        assert.equal(first.parts, layout.parts)
        ns.Markdown.ReplyView.Rendered(state, false)
        local _, unchangedKey = ns.Markdown.ReplyView.Update(state, "chat", original)
        assert.equal(layoutKey, unchangedKey)
    end
)

it("invalidates native inline waits independently without recompiling the document view", function()
    local env, ns = setup()
    local state, original = ns.Markdown.ReplyView.New(), reply(tableSource)
    original.ui = { { id = "label", kind = "text", text = string.rep("**native** ", 100) } }
    local display, firstKey = ns.Markdown.ReplyView.Update(state, "chat", original)
    local host = env.CreateFrame("Frame")
    local _, pending = ns.UI.RenderRichUI(host, {}, display, 300)
    assert.is_true(pending)
    ns.Markdown.ReplyView.Rendered(state, pending)
    local before, beforeKey = ns.Markdown.ReplyView.Update(state, "chat", original)
    assert.equal(firstKey, beforeKey)
    assert.equal(display.parts, before.parts)
    drain(ns)
    local completed, completedKey = ns.Markdown.ReplyView.Update(state, "chat", original)
    assert.are_not.equal(firstKey, completedKey)
    assert.equal(display.parts, completed.parts)
    local _, completePending = ns.UI.RenderRichUI(host, {}, completed, 210)
    assert.is_false(completePending)
    assert.is_truthy(host.widgets.label.title:GetText():find("|cffe3c77enative|r", 1, true))
    ns.Markdown.ReplyView.Rendered(state, completePending)
    ns.Markdown.Cache.Get("another unrelated" .. longSuffix)
    drain(ns)
    local _, settledKey = ns.Markdown.ReplyView.Update(state, "chat", original)
    assert.equal(completedKey, settledKey)
end)
