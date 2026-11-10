local _, C = ...
local referenceQuests = {}
local function mapLocation(link)
    local id, x, y = link:match("^worldmap:(%d+):(%d+):(%d+)$")
    id, x, y = tonumber(id), tonumber(x), tonumber(y)
    if id and id > 0 and x and x <= 10000 and y and y <= 10000 then
        return id, x / 100, y / 100
    end
end
local function refreshReferences()
    if not C_QuestLog or not C_QuestLog.GetNumQuestLogEntries then
        return
    end
    C.db.questReferences = C.db.questReferences or {}
    local changed = false
    for index = 1, C_QuestLog.GetNumQuestLogEntries() do
        local info = C_QuestLog.GetInfo(index)
        if info and not info.isHeader and info.questID and info.title then
            local old = C.db.questReferences[tostring(info.questID)]
            if not old or old.title ~= info.title or old.level ~= info.level then
                changed = true
            end
            C.db.questReferences[tostring(info.questID)] =
                { id = info.questID, title = info.title, level = info.level }
        end
    end
    referenceQuests = C.db.questReferences
    return changed
end
local function macroNameFromLink(link)
    local hex = link:match("^wispmacro:([%x]+)$")
    if not hex or #hex > 32 or #hex % 2 ~= 0 then
        return nil
    end
    local name = hex:gsub("..", function(pair)
        return string.char(tonumber(pair, 16))
    end)
    if name:find("[%c|]") then
        return nil
    end
    return name
end
local function formatted(text, references, fromUser)
    local links = {}
    local function keep(link)
        links[#links + 1] = link
        return "\1" .. #links .. "\2"
    end
    text = tostring(text or "")
    text = text:gsub("```.-```", function(code)
        return keep(code:gsub("|", "||"))
    end)
    text = text:gsub("`[^`\n]+`", function(code)
        return keep(code:gsub("|", "||"))
    end)
    if fromUser then
        text = text:gsub("|cn[%w_]+:|H[^|]+|h.-|h|r", keep)
        text = text:gsub("|c%x%x%x%x%x%x%x%x|H[^|]+|h.-|h|r", keep)
        text = text:gsub("|H[^|]+|h.-|h", keep)
    end
    text = text:gsub("|", "||")
    text = text:gsub("%[%[ref:([%w_-]+)%]%]", function(key)
        local ref = references and references[key]
        if type(ref) ~= "table" then
            return "(reference unavailable)"
        end
        local name = tostring(ref.label or "Reference"):gsub("[|%c%[%]]", "")
        local payload
        if ref.kind == "item" or ref.kind == "spell" or ref.kind == "quest" then
            local id = tonumber(ref.id)
            if not id or id < 1 then
                return name
            end
            payload = ref.kind .. ":" .. id
            if
                type(ref.payload) == "string"
                and (ref.payload == payload or ref.payload:sub(1, #payload + 1) == payload .. ":")
                and ref.payload:match("^" .. ref.kind .. ":[%d:%+%.%-]+$")
            then
                payload = ref.payload
            end
        elseif
            ref.kind == "unit"
            and type(ref.guid) == "string"
            and ref.guid:match("^%a+%-%w[%w%-]*$")
        then
            payload = "unit:" .. ref.guid
        elseif ref.kind == "map" then
            local id, x, y = tonumber(ref.mapId), tonumber(ref.x), tonumber(ref.y)
            if not id or id < 1 then
                return name
            end
            if x and y and x >= 0 and x <= 100 and y >= 0 and y <= 100 then
                payload = string.format(
                    "worldmap:%d:%d:%d",
                    id,
                    math.floor(x * 100 + 0.5),
                    math.floor(y * 100 + 0.5)
                )
                name = name .. string.format(" (%.1f, %.1f)", x, y)
            else
                payload = "wispzone:" .. id
            end
        elseif
            ref.kind == "macro"
            and type(ref.name) == "string"
            and #ref.name <= 16
            and not ref.name:find("[%c|]")
        then
            payload = "wispmacro:"
                .. ref.name:gsub(".", function(char)
                    return string.format("%02x", string.byte(char))
                end)
        end
        if not payload then
            return name
        end
        local icon = "Interface\\Icons\\INV_Misc_QuestionMark"
        local color = "ffe3c77e"
        if ref.kind == "item" then
            icon = (C_Item and C_Item.GetItemIconByID and C_Item.GetItemIconByID(tonumber(ref.id)))
                or (GetItemIcon and GetItemIcon(tonumber(ref.id)))
                or icon
            if GetItemInfo and GetItemQualityColor then
                local _, _, quality = GetItemInfo(tonumber(ref.id))
                if quality then
                    local _, _, _, hex = GetItemQualityColor(quality)
                    color = hex or color
                end
            end
        elseif ref.kind == "spell" then
            icon = (
                C_Spell
                and C_Spell.GetSpellTexture
                and C_Spell.GetSpellTexture(tonumber(ref.id))
            )
                or (GetSpellTexture and GetSpellTexture(tonumber(ref.id)))
                or icon
            color = "ff71d5ff"
        elseif ref.kind == "map" then
            icon, color = "Interface\\Icons\\INV_Misc_Map_01", "ff80cf91"
        elseif ref.kind == "quest" then
            icon = "Interface\\GossipFrame\\AvailableQuestIcon"
        end
        return keep(
            "|T"
                .. tostring(icon)
                .. ":12:12:0:-2|t |c"
                .. color
                .. "|H"
                .. payload
                .. "|h["
                .. name
                .. "]|h|r"
        )
    end)
    text = text:gsub("%*%*([^*]+)%*%*", "|cffe3c77e%1|r")
    text = text:gsub("%*([^*\n]+)%*", "%1"):gsub("_([^_\n]+)_", "%1")
    text = text:gsub("%[([^%]]+)%]%(https?://[^%)]+%)", "%1")
    return C.Emoji.render((text:gsub("\1(%d+)\2", function(index)
        return links[tonumber(index)]
    end)))
end
C.FormatText = function(text, references, fromUser)
    return C.Markdown and not fromUser and C.Markdown.format(text, references)
        or formatted(text, references, fromUser)
end
local function referenceSignature(references)
    local parts = {}
    for key, ref in pairs(references or {}) do
        local values = {}
        for field, value in pairs(ref) do
            values[#values + 1] = field .. "=" .. tostring(value)
        end
        table.sort(values)
        parts[#parts + 1] = key .. ":" .. table.concat(values, "\30")
    end
    table.sort(parts)
    return table.concat(parts, "\31")
end

C.MessageFormat = {
    reference = formatted,
    blocks = function(value)
        return C.Markdown.blocks(value)
    end,
    render = function(...)
        return C.Markdown.render(...)
    end,
    hide = function(...)
        if C.Markdown then
            return C.Markdown.hide(...)
        end
    end,
    refreshReferences = refreshReferences,
    signature = referenceSignature,
    mapLocation = mapLocation,
    macroNameFromLink = macroNameFromLink,
    quest = function(id)
        return referenceQuests[tostring(id)]
    end,
}
