local _, ns = ...

-- Tri-state eligibility only: true means one active quest was observed; nil is
-- unknown (missing, restricted, partial or oversized log), never an empty log.
function ns.Character.HasActiveQuests()
    if
        not C_QuestLog
        or type(C_QuestLog.GetNumQuestLogEntries) ~= "function"
        or type(C_QuestLog.GetInfo) ~= "function"
    then
        return nil
    end
    local ok, result = pcall(function()
        local count = C_QuestLog.GetNumQuestLogEntries()
        if not ns.Shared.Numbers.IsNonNegativeInteger(count) then
            return nil
        end
        local partial = count > 100
        for index = 1, math.min(count, 100) do
            local info = C_QuestLog.GetInfo(index)
            if type(info) ~= "table" then
                partial = true
            elseif
                info.isHeader == false
                and info.isHidden == false
                and ns.Shared.Numbers.IsNonNegativeInteger(info.questID)
                and info.questID > 0
            then
                return true
            elseif info.isHeader ~= true and info.isHidden ~= true then
                partial = true
            end
        end
        if not partial then
            return false
        end
    end)
    if ok then
        return result
    end
    return nil
end
