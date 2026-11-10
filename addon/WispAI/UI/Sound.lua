local _, ns = ...
function ns.UI.PlayCompletionSound()
    if ns.db.sound then
        local sound = SOUNDKIT and SOUNDKIT.TELL_MESSAGE or 3081
        pcall(PlaySound, sound, "Master")
    end
end
