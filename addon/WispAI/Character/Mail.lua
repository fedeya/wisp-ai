local _, ns = ...

-- Forever Mainline MailFrame.lua at 4cd0ab752a77164f654ccbca9d0c1fe8dafceebe:
-- header 5/6/7/8 = copper/copper/days/attachment count; item 2/4/7 = ID/count/currency.
-- Never retain private header fields, open a message, or request cache loads.
local revision = 0
local events = CreateFrame("Frame")
for _, event in ipairs({ "MAIL_SHOW", "MAIL_CLOSED", "MAIL_INBOX_UPDATE", "MAIL_SUCCESS" }) do
    events:RegisterEvent(event)
end
events:SetScript("OnEvent", function()
    revision = revision + 1
end)

local function public(value)
    if type(issecretvalue) == "function" then
        local ok, secret = pcall(issecretvalue, value)
        if not ok or secret then
            return false
        end
    end
    return true
end
local function number(value, integer, maximum)
    if not public(value) or type(value) ~= "number" then
        return nil
    end
    if value < 0 or value > maximum or value ~= value or (integer and value % 1 ~= 0) then
        return nil
    end
    return value
end
local function call(fn, ...)
    if type(fn) ~= "function" then
        return {}
    end
    local values = { pcall(fn, ...) }
    if not values[1] then
        return {}
    end
    return values
end
local function shown()
    local values = call(MailFrame and MailFrame.IsShown, MailFrame)
    return public(values[2]) and values[2] == true
end
local function counts()
    local values = call(GetInboxNumItems)
    local loaded = number(values[2], true, 100000)
    local total = number(values[3], true, 100000)
    if loaded and total and total < loaded then
        total = nil
    end
    return loaded, total
end
local function text(value, bytes, exact)
    if not public(value) or type(value) ~= "string" then
        return nil
    end
    local result, truncated = ns.Shared.Text.TruncateUtf8Bytes(value, bytes)
    if truncated and exact then
        return nil
    end
    return result, truncated
end
local function itemLinkID(link)
    if not link then
        return nil
    end
    local id = link:match("^|Hitem:(%d+):[^|]*|h%[[^|]*%]|h$")
        or link:match("^|c%x%x%x%x%x%x%x%x|Hitem:(%d+):[^|]*|h%[[^|]*%]|h|r$")
    return id and tonumber(id) or nil
end
local function row(index)
    -- Do not pack this tuple: that would retain sender/subject/read-state fields.
    local values = call(function()
        local _, _, _, _, money, cod, days, count, _, _, _, _, _, _, firstLink =
            GetInboxHeaderInfo(index)
        return money, cod, days, count, firstLink
    end)
    local result = {
        position = index,
        moneyCopper = number(values[2], true, 9007199254740991),
        codCopper = number(values[3], true, 9007199254740991),
        expiryDays = number(values[4], false, 36500),
        attachmentCount = number(values[5], true, 16),
        attachments = {},
        unknownSlots = 0,
        unknownSlotPositions = {},
        scannedSlots = 16,
    }
    result.fields = {
        money = result.moneyCopper ~= nil and "known" or "unknown",
        cod = result.codCopper ~= nil and "known" or "unknown",
        expiry = result.expiryDays ~= nil and "known" or "unknown",
        attachmentCount = result.attachmentCount ~= nil and "known" or "unknown",
    }
    local complete, present = true, 0
    for slot = 1, 16 do
        local presence = call(HasInboxItem, index, slot)[2]
        if not public(presence) or type(presence) ~= "boolean" then
            result.unknownSlots = result.unknownSlots + 1
            result.unknownSlotPositions[#result.unknownSlotPositions + 1] = slot
            complete = false
        elseif presence then
            present = present + 1
            local item = call(GetInboxItem, index, slot)
            local currencyKnown = public(item[8]) and type(item[8]) == "boolean"
            local currency = currencyKnown and item[8]
            local id = currencyKnown and not currency and number(item[3], true, 2147483647) or nil
            if id == 0 then
                id = nil
            end
            local quantity = number(item[5], true, 2147483647)
            if quantity == 0 then
                quantity = nil
            end
            local name, nameTruncated = text(item[2], 120, false)
            result.attachments[#result.attachments + 1] = {
                slot = slot,
                itemId = id,
                quantity = quantity,
                name = name,
                nameTruncated = nameTruncated or nil,
                linkStatus = "unknown",
                identityStatus = id and "known" or "unknown",
                quantityStatus = quantity and "known" or "unknown",
                kind = currencyKnown and (currency and "currency" or "item") or "unknown",
            }
            if not id or not quantity then
                complete = false
            end
        end
    end
    -- The native caller exposes only the first attachment link in the header.
    -- Associate it only after all slots confirm a single, matching item ID.
    if result.attachmentCount == 1 and present == 1 and result.unknownSlots == 0 then
        local attachment = result.attachments[1]
        local link = text(values[6], 1024, true)
        if attachment.itemId and itemLinkID(link) == attachment.itemId then
            attachment.link, attachment.linkStatus = link, "known"
        end
    end
    result.attachmentsStatus = complete and result.attachmentCount == present and "complete"
        or "partial"
    return result
end
local function equal(a, b)
    if type(a) ~= type(b) then
        return false
    end
    if type(a) ~= "table" then
        return a == b
    end
    for key, value in pairs(a) do
        if key == "expiryDays" and type(value) == "number" and type(b[key]) == "number" then
            if math.abs(value - b[key]) > 2 / 86400 then
                return false
            end
        elseif not equal(value, b[key]) then
            return false
        end
    end
    for key in pairs(b) do
        if a[key] == nil then
            return false
        end
    end
    return true
end

-- Budget escaped JSON, not raw string lengths. Drop presentation before IDs and
-- quantities. Transport repeats this on its complete envelope after metadata.
function ns.Character._BoundMailResult(result, maximum, packet)
    if type(result) ~= "table" or result.status ~= "available" then
        return
    end
    local data = result.data
    if type(data) ~= "table" or data.kind ~= "mail" or type(data.rows) ~= "table" then
        return
    end
    -- The transport hook sees every result. Validate the whole row shape before
    -- changing any optional values, including rows beyond the retained prefix.
    for _, entry in pairs(data.rows) do
        if type(entry) ~= "table" or type(entry.attachments) ~= "table" then
            return
        end
        for _, attachment in pairs(entry.attachments) do
            if type(attachment) ~= "table" or type(attachment.slot) ~= "number" then
                return
            end
        end
    end
    local function size()
        return #C_EncodingUtil.SerializeJSON(packet or result)
    end
    if size() <= maximum then
        return
    end
    for _, entry in ipairs(data.rows) do
        for _, attachment in ipairs(entry.attachments) do
            if attachment.name ~= nil then
                attachment.name, attachment.nameTruncated = nil, nil
                data.optionalTextOmitted = true
            end
            if attachment.link ~= nil then
                attachment.link = nil
                attachment.linkStatus = "omitted_budget"
                data.optionalTextOmitted = true
            end
        end
    end
    if size() <= maximum then
        return
    end
    data.truncated, data.partial = true, true
    local rows, low, high = data.rows, 0, #data.rows
    local function prefix(count)
        data.rows = {}
        for index = 1, count do
            data.rows[index] = rows[index]
        end
        data.returnedRows = count
    end
    -- At most six extra serializations for 50 rows, not a quadratic trim loop.
    while low < high do
        local middle = math.ceil((low + high) / 2)
        prefix(middle)
        if size() <= maximum then
            low = middle
        else
            high = middle - 1
        end
    end
    prefix(low)
    assert(size() <= maximum, "Mail transport envelope is too large")
end

function ns.Character._BoundMailPacket(packet, maximum)
    if packet.type == "state_result" and type(packet.data) == "table" then
        ns.Character._BoundMailResult(packet.data, maximum, packet)
    end
end

function ns.Character.ReadMail(args)
    local limit = args.limit or 10
    assert(
        type(limit) == "number" and limit % 1 == 0 and limit >= 1 and limit <= 50,
        "Invalid mail limit"
    )
    for key in pairs(args) do
        assert(key == "limit", "Unsupported mail argument")
    end
    assert(shown(), "Open the mailbox and keep it open first")
    assert(
        type(GetInboxNumItems) == "function" and type(GetInboxHeaderInfo) == "function",
        "Mail metadata API unavailable"
    )
    local start, capturedAt = revision, time()
    local loaded, total = counts()
    local data = {
        kind = "mail",
        capturedAt = capturedAt,
        source = "already-loaded native mailbox cache",
        serverFreshness = "unknown",
        coverageScope = "loaded cache only",
        unseenMailStatus = "unknown",
        captureRevision = start,
        windowOpen = true,
        loadedCount = loaded,
        totalCount = total,
        countsStatus = loaded ~= nil and total ~= nil and "known" or "partial",
        rows = {},
        scannedRows = 0,
        returnedRows = 0,
        partial = loaded == nil or total == nil or loaded ~= total,
        truncated = loaded ~= nil and loaded > limit or false,
        note = "Capture-local positions, not message identities. Waiting mail is not bag inventory or spendable money. COD is a cost, not free stock. Private text omitted; no refresh or mail actions. Unseen/overflow mail may exist even when loaded counts match. Capture time is not server freshness; identical metadata cannot establish durable identity.",
    }
    for index = 1, math.min(loaded or 0, limit) do
        local entry = row(index)
        data.rows[#data.rows + 1] = entry
        if entry.attachmentsStatus ~= "complete" then
            data.partial = true
        end
        for _, status in pairs(entry.fields) do
            if status ~= "known" then
                data.partial = true
            end
        end
    end
    data.scannedRows, data.returnedRows = #data.rows, #data.rows
    data.partial = data.partial or data.truncated
    for index, entry in ipairs(data.rows) do
        assert(equal(entry, row(index)), "Mailbox changed during capture; ask again")
    end
    local endLoaded, endTotal = counts()
    assert(
        start == revision and shown() and loaded == endLoaded and total == endTotal,
        "Mailbox changed during capture; ask again"
    )
    data.revalidatedAt = time()
    assert(C_EncodingUtil and C_EncodingUtil.SerializeJSON, "Mail JSON budgeting API unavailable")
    return data
end
