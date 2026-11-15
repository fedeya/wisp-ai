local helper = require("addon.tests.support")

local function setup(env)
    local handler, registered = nil, {}
    env.CreateFrame = function()
        return {
            RegisterEvent = function(_, event)
                registered[event] = true
            end,
            SetScript = function(_, script, callback)
                if script == "OnEvent" then
                    handler = callback
                end
            end,
        }
    end
    env.now = 123
    env.guid = "Player-1"
    env.time = function()
        return env.now
    end
    env.UnitGUID = function(unit)
        assert.equals("player", unit)
        return env.guid
    end
    env.UnitName = function()
        return "Mage"
    end
    env.ns = helper.namespace({ db = env.ns and env.ns.db or {} })
    helper.addon("Character/Inspect.lua", env)
    helper.addon("Character/FlightPaths.lua", env)
    return function(event)
        assert.is_true(registered[event])
        handler(nil, event)
    end
end

local function read(env, args)
    return env.ns.Character.Inspect({ kind = "flight_paths", args = args or {} })
end

local function legacyMap(env, nodes)
    env.NumTaxiNodes = function()
        return #nodes
    end
    env.TaxiNodeName = function(slot)
        return nodes[slot].name
    end
    env.TaxiNodeGetType = function(slot)
        return nodes[slot].state
    end
    env.TaxiNodeCost = function(slot)
        assert.equals("REACHABLE", nodes[slot].state)
        return nodes[slot].cost
    end
end

it(
    "remembers legacy maps after closing and reloading, scoped to the character and origin",
    function()
        local env = helper.env()
        local fire = setup(env)
        assert.equals("unavailable", read(env).status)

        legacyMap(env, {
            { name = "Stormwind", state = "CURRENT" },
            { name = "Lakeshire", state = "REACHABLE", cost = 110 },
            { name = "Sentinel Hill", state = "UNREACHABLE" },
            { name = "Distant stop", state = "DISTANT" },
        })
        fire("TAXIMAP_OPENED")
        local map = read(env).data.maps[1]
        assert.equals("Stormwind", map.origin)
        assert.equals(123, map.observedAt)
        assert.is_true(map.mapOpen)
        assert.same({
            { name = "Lakeshire", reachable = true, costCopper = 110 },
            { name = "Sentinel Hill", reachable = false },
        }, map.destinations)
        fire("TAXIMAP_CLOSED")
        assert.is_false(read(env).data.maps[1].mapOpen)

        fire = setup(env)
        map = read(env, { origin = "storm", destination = "lakeshire" }).data.maps[1]
        assert.equals("Lakeshire", map.destinations[1].name)
        assert.is_false(map.mapOpen)

        legacyMap(env, {
            { name = "Goldshire", state = "CURRENT" },
            { name = "Lakeshire", state = "UNREACHABLE" },
        })
        fire("TAXIMAP_OPENED")
        local limited = read(env, { destination = "Lakeshire", limit = 1 }).data
        assert.equals(2, limited.matched)
        assert.is_true(limited.truncated)
        assert.equals("Goldshire", limited.maps[1].origin)
        assert.is_false(limited.maps[1].destinations[1].reachable)
        assert.same({}, read(env, { destination = "Darnassus" }).data.maps)

        env.guid = "Player-2"
        assert.equals("unavailable", read(env).status)
    end
)

it("replaces an origin from a fresh flight map and skips non-flight map transitions", function()
    local env = helper.env()
    local fire = setup(env)
    legacyMap(env, {
        { name = "Stormwind", state = "CURRENT" },
        { name = "Lakeshire", state = "UNREACHABLE" },
    })
    fire("TAXIMAP_OPENED")
    fire("TAXIMAP_CLOSED")

    env.now = 456
    env.GetTaxiMapID = function()
        return 1415
    end
    env.Enum = { FlightPathState = { Current = 0, Reachable = 1, Unreachable = 2 } }
    env.C_TaxiMap = {
        GetAllTaxiNodes = function(mapId)
            assert.equals(1415, mapId)
            return {
                { nodeID = 1, name = "Stormwind", state = 0, slotIndex = 1 },
                { nodeID = 2, name = "Lakeshire", state = 1, slotIndex = 5 },
                { nodeID = 3, name = "Other map", state = 1, isMapLayerTransition = true },
            }
        end,
    }
    env.TaxiNodeCost = function(slot)
        assert.equals(5, slot)
        return 0
    end
    fire("TAXIMAP_OPENED")
    local reading = read(env)
    assert.equals("WoW flight maps", reading.source)
    assert.equals(1, reading.data.observedOrigins)
    assert.same({
        { name = "Lakeshire", nodeId = 2, reachable = true, costCopper = 0 },
    }, reading.data.maps[1].destinations)
    assert.equals(456, reading.data.maps[1].observedAt)

    env.C_TaxiMap.GetAllTaxiNodes = function()
        return {}
    end
    legacyMap(env, {})
    fire("TAXIMAP_OPENED")
    assert.is_false(read(env).data.maps[1].mapOpen)
    assert.equals(456, read(env).data.maps[1].observedAt)
end)

it(
    "reads world map flight points before visiting a master and guards ambiguous discovery flags",
    function()
        local env = helper.env()
        setup(env)
        env.Enum = { FlightPathFaction = { Neutral = 0, Horde = 1, Alliance = 2 } }
        env.UnitFactionGroup = function()
            return "Alliance"
        end
        env.C_TaxiMap = {
            GetTaxiNodesForMap = function(mapId)
                if mapId == 1414 then
                    return {
                        { name = "Auberdine", nodeID = 1, faction = 2, isUndiscovered = false },
                        { name = "Orgrimmar", nodeID = 2, faction = 1, isUndiscovered = true },
                    }
                end
                assert.equals(1415, mapId)
                return {
                    { name = "Stormwind", nodeID = 3, faction = 2, isUndiscovered = false },
                    { name = "Lakeshire", nodeID = 4, faction = 2, isUndiscovered = true },
                    { name = "Booty Bay", nodeID = 5, faction = 0 },
                }
            end,
        }

        local reading = read(env, { origin = "AUBERDINE", destination = "Lakeshire" })
        assert.equals("available", reading.status)
        assert.equals(0, reading.data.observedOrigins)
        assert.same({}, reading.data.maps)
        assert.same({
            { name = "Auberdine", nodeId = 1, discovery = "unknown" },
            { name = "Lakeshire", nodeId = 4, discovery = "undiscovered" },
        }, reading.data.worldMap.points)

        assert.same({
            { name = "Stormwind", nodeId = 3, discovery = "learned" },
        }, read(env, { destination = "storm" }).data.worldMap.points)
        assert.same({}, read(env, { destination = "Orgrimmar" }).data.worldMap.points)
        local limited = read(env, { limit = 1 }).data.worldMap
        assert.is_true(limited.truncated)
        assert.equals(4, limited.matched)
        assert.equals(1, #limited.points)
    end
)
