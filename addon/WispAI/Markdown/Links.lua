local _, ns = ...
local links = {}

function links.Valid(url)
    return type(url) == "string"
            and #url <= 2048
            and url:match("^https?://[^/%?#]+")
            and not url:find('[%s%c|<>"\\]')
            and url
        or nil
end

function links.Encode(url)
    return "wispurl:"
        .. url:gsub(".", function(char)
            return string.format("%02x", string.byte(char))
        end)
end

function links.Decode(link)
    local hex = link:match("^wispurl:([%x]+)$")
    if not hex or #hex > 4096 or #hex % 2 ~= 0 then
        return nil
    end
    return links.Valid((hex:gsub("..", function(pair)
        return string.char(tonumber(pair, 16))
    end)))
end

ns.Markdown.Links = links
