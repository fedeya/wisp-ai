local function read(path)
    local file = assert(io.open(path, "rb"))
    local bytes = file:read("*a")
    file:close()
    return bytes
end

it("every catalog entry points inside a shipped uncompressed RGBA atlas", function()
    local indices = {}
    for index in read("addon/WispAI/EmojiData.lua"):gmatch(" = (%d+),") do
        indices[#indices + 1] = tonumber(index)
    end
    assert.equals(4009, #indices)

    for page = 0, 3 do
        local atlas = read("addon/WispAI/Textures/Emoji/Emoji" .. page .. ".tga")
        local function uint16(offset)
            return atlas:byte(offset + 1) + 256 * atlas:byte(offset + 2)
        end
        assert.equals(2, atlas:byte(3))
        assert.equals(1024, uint16(12))
        assert.equals(1024, uint16(14))
        assert.equals(32, atlas:byte(17))
        assert.equals(18 + 1024 * 1024 * 4, #atlas)
        for _, index in ipairs(indices) do
            if math.floor(index / 1024) == page then
                local cell, visible = index % 1024, false
                for dy = 1, 30 do
                    for dx = 1, 30 do
                        local x = (cell % 32) * 32 + dx
                        local y = math.floor(cell / 32) * 32 + dy
                        if atlas:byte(22 + ((1023 - y) * 1024 + x) * 4) > 0 then
                            visible = true
                            break
                        end
                    end
                    if visible then
                        break
                    end
                end
                assert.is_true(visible, "empty emoji cell " .. index)
            end
        end
    end
end)
