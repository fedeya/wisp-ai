-- Public entry points other addons reach through the `WispAI` global (see Core.lua).
-- They only open Wisp's quick-question popup prefilled; the player always sends.
local _, ns = ...

-- Byte limits. The bridge schema (`addonAttachment` in @wisp/protocol) matches them.
local LIMITS = { source = 40, title = 60, prompt = 500, link = 255, label = 60, text = 4000 }
local THROTTLE_SECONDS = 1
local lastAccepted

local function trim(value)
    return (value:match("^%s*(.-)%s*$"))
end

--- One line of display text without WoW escape sequences, so another addon's
--- strings cannot draw colors, textures or fake links in Wisp's UI.
local function plain(value)
    return trim(
        value
            :gsub("|c%x%x%x%x%x%x%x%x", "")
            :gsub("|cn[^:|]*:", "")
            :gsub("|r", "")
            :gsub("|T.-|t", "")
            :gsub("|A.-|a", "")
            :gsub("|K.-|k", "")
            :gsub("|H.-|h(.-)|h", "%1")
            :gsub("|", "")
            :gsub("%c", " ")
    )
end

--- Attachment text is data for the model, so it keeps its characters; only line
--- endings are normalized and control characters other than tab and newline dropped.
local function data(value)
    return trim(value:gsub("\r\n?", "\n"):gsub("[%z\1-\8\11-\31\127]", ""))
end

-- Accepts nil or a string within `limit` bytes; anything else is invalid.
local function field(value, limit)
    if value == nil then
        return true
    end
    return type(value) == "string" and #value <= limit
end

-- One game hyperlink, optionally colored, and nothing else.
local function validLink(link)
    if link == nil then
        return true
    end
    if type(link) ~= "string" or #link > LIMITS.link then
        return false
    end
    local bare = link:gsub("^|c%x%x%x%x%x%x%x%x", ""):gsub("^|cn[^:|]*:", ""):gsub("|r$", "")
    return bare:match("^|H%a+:[^|]*|h%[[^|]*%]|h$") ~= nil
end

local function validate(request)
    if type(request) ~= "table" then
        return nil
    end
    local attachment = request.attachment
    if
        not field(request.source, LIMITS.source)
        or not field(request.title, LIMITS.title)
        or not field(request.prompt, LIMITS.prompt)
        or not validLink(request.link)
        or (attachment ~= nil and type(attachment) ~= "table")
    then
        return nil
    end
    -- The caller writes everything the player reads; Wisp adds no text of its own.
    local source = request.source and plain(request.source) or ""
    local prompt = request.prompt and plain(request.prompt) or ""
    if source == "" or prompt == "" then
        return nil
    end
    local clean = {
        source = source,
        title = request.title and plain(request.title) or "",
        prompt = prompt,
        link = request.link,
    }
    if attachment then
        if
            not field(attachment.label, LIMITS.label)
            or type(attachment.text) ~= "string"
            or #attachment.text > LIMITS.text
        then
            return nil
        end
        local label = attachment.label and plain(attachment.label) or ""
        local text = data(attachment.text)
        if label == "" or text == "" then
            return nil
        end
        clean.attachment = { source = source, label = label, text = text }
    end
    return clean
end

--- True when Wisp can take a question now: the bridge is connected and Desktop
--- needs no setup. Callers use it to enable or grey out their button.
function ns.Api.IsAvailable()
    return ns.connected == true and not ns.Transport.needsDesktopSetup
end

--- Opens the quick-question popup with `request` and focuses its input. Never sends.
--- request = {
---   source = string,      -- required, caller addon name, ≤ 40 bytes
---   prompt = string,      -- required, input text, ≤ 500 bytes
---   title = string?,      -- popup header, ≤ 60 bytes (default: source)
---   link = string?,       -- one game hyperlink, ≤ 255 bytes
---   attachment = { label = string (≤ 60 bytes), text = string (≤ 4000 bytes) }?,
--- }
--- Returns true, or false and "unavailable" | "invalid_request" | "busy" | "throttled".
function ns.Api.Ask(request)
    if not ns.Api.IsAvailable() then
        return false, "unavailable"
    end
    local clean = validate(request)
    if not clean then
        return false, "invalid_request"
    end
    local now = GetTime()
    if lastAccepted and now - lastAccepted < THROTTLE_SECONDS then
        return false, "throttled"
    end
    local ok, reason = ns.Inline.OpenRequest(clean)
    if ok then
        lastAccepted = now
    end
    return ok, reason
end
