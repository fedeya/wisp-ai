local helper = require("addon.tests.support")

local function setup()
    local env = helper.env()
    helper.fixture("addon/tests/wow-ui-stub.lua", env)
    env.C = {}
    helper.addon("UI.lua", env)
    return env, env.C
end

local function reply(source, id)
    return { id = id or "reply", role = "assistant", text = source }
end

local function drain(C)
    for _ = 1, 2000 do
        local _, pending = C.Markdown.Cache.step()
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
        local _, C = setup()
        local state = C.Markdown.ReplyView.new()
        local original = reply(tableSource)
        original.rawReply, original.futureMetadata = "old events", { version = 1 }
        local first, firstKey = C.Markdown.ReplyView.update(state, "chat", original)
        local replacement = reply(tableSource, "replacement")
        replacement.rawReply, replacement.futureMetadata = "new events", { version = 2 }
        local current, currentKey = C.Markdown.ReplyView.update(state, "chat", replacement)
        assert.equal(first.ui, current.ui)
        assert.equal(first.parts, current.parts)
        assert.equal("replacement", current.id)
        assert.equal("new events", current.rawReply)
        assert.equal(replacement.futureMetadata, current.futureMetadata)
        assert.are_not.equal(firstKey, currentKey)
        replacement.rawReply, replacement.futureMetadata = nil, nil
        local latest, latestKey = C.Markdown.ReplyView.update(state, "chat", replacement)
        assert.is_nil(latest.rawReply)
        assert.is_nil(latest.futureMetadata)
        assert.equal(currentKey, latestKey)
        local _, otherChatKey = C.Markdown.ReplyView.update(state, "other chat", replacement)
        assert.are_not.equal(latestKey, otherChatKey)
    end
)

it("never carries a retained assistant view into a different reply or a user row", function()
    local _, C = setup()
    local state, original = C.Markdown.ReplyView.new(), reply(tableSource)
    original.streaming = true
    local stable = C.Markdown.ReplyView.update(state, "chat", original)
    original.text = tableSource .. longSuffix
    local waiting = C.Markdown.ReplyView.update(state, "chat", original)
    assert.is_true(waiting._markdownPending)
    assert.equal(stable.parts, waiting.parts)
    original.id = "different reply"
    local recycled = C.Markdown.ReplyView.update(state, "chat", original)
    assert.is_true(recycled._markdownPending)
    assert.equal(0, #recycled.ui)
    assert.are_not.equal(stable.parts, recycled.parts)
    local user = { id = original.id, role = "user", text = "|Hitem:100|h[Native]|h" }
    assert.equal(user, C.Markdown.ReplyView.update(state, "chat", user))
    local nextReply = reply("Fresh text", user.id)
    local fresh = C.Markdown.ReplyView.update(state, "chat", nextReply)
    assert.equal("Fresh text", fresh.parts[1].text)
    assert.equal(0, #fresh.ui)
    assert.is_false(fresh._markdownPending)
end)

it("cancels obsolete part sources without cancelling unchanged pending parts", function()
    local _, C = setup()
    local state, original = C.Markdown.ReplyView.new(), reply("canonical source remains unchanged")
    original.parts = {
        { type = "text", text = tableSource },
        { type = "text", text = "first" .. longSuffix },
        { type = "text", text = "shared" .. longSuffix },
    }
    local cancelled, cancel = {}, C.Markdown.Cache.cancel
    C.Markdown.Cache.cancel = function(source, inline)
        cancelled[#cancelled + 1] = source
        return cancel(source, inline)
    end
    local first = C.Markdown.ReplyView.update(state, "chat", original)
    assert.is_true(first._markdownPending)
    local old, shared = original.parts[2].text, original.parts[3].text
    original.parts[2].text = "replacement" .. longSuffix
    local changed = C.Markdown.ReplyView.update(state, "chat", original)
    assert.is_true(changed._markdownPending)
    assert.same({ old }, cancelled)
    local user = { id = original.id, role = "user", text = "user" }
    C.Markdown.ReplyView.update(state, "chat", user)
    assert.same({ old, tableSource, original.parts[2].text, shared }, cancelled)
    drain(C)
    local completed = C.Markdown.ReplyView.update(state, "chat", reply(tableSource))
    assert.equal(1, #completed.ui)
end)

it("retains compatible prefixes and replaces their presentation once syntax completes", function()
    local _, C = setup()
    local state, original = C.Markdown.ReplyView.new(), reply("same canonical source")
    original.parts = { { type = "text", text = tableSource } }
    local stable, stableKey = C.Markdown.ReplyView.update(state, "chat", original)
    original.parts[1].text = tableSource .. longSuffix
    local waiting, waitingKey = C.Markdown.ReplyView.update(state, "chat", original)
    assert.is_true(waiting._markdownPending)
    assert.equal(stable.parts, waiting.parts)
    assert.are_not.equal(stableKey, waitingKey)
    local unchanged, unchangedKey = C.Markdown.ReplyView.update(state, "chat", original)
    assert.equal(waiting.parts, unchanged.parts)
    assert.equal(waitingKey, unchangedKey)
    drain(C)
    local completed, completedKey = C.Markdown.ReplyView.update(state, "chat", original)
    assert.is_false(completed._markdownPending)
    assert.are_not.equal(stable.parts, completed.parts)
    assert.are_not.equal(waitingKey, completedKey)
    assert.equal(1, #completed.ui)
    assert.is_truthy(completed.parts[2].text:find("dense", 1, true))
    original.parts[1].text = "different prefix" .. longSuffix
    local unrelated = C.Markdown.ReplyView.update(state, "chat", original)
    assert.is_true(unrelated._markdownPending)
    assert.equal(0, #unrelated.ui)
end)

it("refreshes mutable references and item data without reparsing cached syntax", function()
    local env, C = setup()
    local state, original = C.Markdown.ReplyView.new(), reply("[[ref:robe]]")
    original.references = { robe = { kind = "item", id = 100, label = "Old robe" } }
    local parse, calls = C.Markdown.parse, 0
    C.Markdown.parse = function(...)
        calls = calls + 1
        return parse(...)
    end
    local first, firstKey = C.Markdown.ReplyView.update(state, "chat", original)
    assert.is_truthy(first.parts[1].text:find("[Old robe]", 1, true))
    original.references.robe.label = "Current robe"
    local changed, changedKey = C.Markdown.ReplyView.update(state, "chat", original)
    assert.is_truthy(changed.parts[1].text:find("[Current robe]", 1, true))
    assert.are_not.equal(firstKey, changedKey)
    env.GetItemIcon = function()
        return "LoadedIcon"
    end
    C.itemRevision = C.itemRevision + 1
    local loaded, loadedKey = C.Markdown.ReplyView.update(state, "chat", original)
    assert.is_truthy(loaded.parts[1].text:find("|TLoadedIcon:", 1, true))
    assert.are_not.equal(changedKey, loadedKey)
    assert.equal(1, calls)
end)

it(
    "does not retain stale reference labels or native components while new syntax is pending",
    function()
        local _, C = setup()
        local state, original = C.Markdown.ReplyView.new(), reply("A|B\n---|---\n[[ref:robe]]|y")
        original.references = { robe = { kind = "item", id = 100, label = "Old robe" } }
        original.ui = { { id = "action", kind = "button", label = "Old action" } }
        local stable = C.Markdown.ReplyView.update(state, "chat", original)
        original.text = original.text .. longSuffix
        original.references.robe.label = "Current robe"
        original.ui = { { id = "action", kind = "button", label = "Current action" } }
        local waiting = C.Markdown.ReplyView.update(state, "chat", original)
        assert.is_true(waiting._markdownPending)
        assert.are_not.equal(stable.parts, waiting.parts)
        assert.equal(1, #waiting.ui)
        assert.equal(original.ui[1], waiting.ui[1])
        drain(C)
        local current = C.Markdown.ReplyView.update(state, "chat", original)
        assert.is_truthy(current.ui[2].rows[1][1]:find("[Current robe]", 1, true))
        assert.equal("Current action", current.ui[1].label)
    end
)

it(
    "keeps stable keys across unrelated syntax work and changes layout without reprojecting",
    function()
        local _, C = setup()
        local state, original = C.Markdown.ReplyView.new(), reply(tableSource)
        local first, firstKey = C.Markdown.ReplyView.update(state, "chat", original)
        C.Markdown.ReplyView.rendered(state, false)
        C.Markdown.Cache.get("unrelated" .. longSuffix)
        drain(C)
        local same, sameKey = C.Markdown.ReplyView.update(state, "chat", original)
        assert.equal(firstKey, sameKey)
        assert.equal(first.parts, same.parts)
        C.Markdown.ReplyView.invalidate()
        local layout, layoutKey = C.Markdown.ReplyView.update(state, "chat", original)
        assert.are_not.equal(sameKey, layoutKey)
        assert.equal(first.parts, layout.parts)
        C.Markdown.ReplyView.rendered(state, false)
        local _, unchangedKey = C.Markdown.ReplyView.update(state, "chat", original)
        assert.equal(layoutKey, unchangedKey)
    end
)

it("invalidates native inline waits independently without recompiling the document view", function()
    local env, C = setup()
    local state, original = C.Markdown.ReplyView.new(), reply(tableSource)
    original.ui = { { id = "label", kind = "text", text = string.rep("**native** ", 100) } }
    local display, firstKey = C.Markdown.ReplyView.update(state, "chat", original)
    local host = env.CreateFrame("Frame")
    local _, pending = C.RenderRichUI(host, {}, display, 300)
    assert.is_true(pending)
    C.Markdown.ReplyView.rendered(state, pending)
    local before, beforeKey = C.Markdown.ReplyView.update(state, "chat", original)
    assert.equal(firstKey, beforeKey)
    assert.equal(display.parts, before.parts)
    drain(C)
    local completed, completedKey = C.Markdown.ReplyView.update(state, "chat", original)
    assert.are_not.equal(firstKey, completedKey)
    assert.equal(display.parts, completed.parts)
    local _, completePending = C.RenderRichUI(host, {}, completed, 210)
    assert.is_false(completePending)
    assert.is_truthy(host.widgets.label.title:GetText():find("|cffe3c77enative|r", 1, true))
    C.Markdown.ReplyView.rendered(state, completePending)
    C.Markdown.Cache.get("another unrelated" .. longSuffix)
    drain(C)
    local _, settledKey = C.Markdown.ReplyView.update(state, "chat", original)
    assert.equal(completedKey, settledKey)
end)
