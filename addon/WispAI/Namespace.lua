local _, ns = ...

ns.Shared = ns.Shared or {}
ns.Shared.Numbers = ns.Shared.Numbers or {}
ns.Shared.Text = ns.Shared.Text or {}

-- One private namespace per subsystem; Core owns shared session state.
ns.Core = ns.Core or {}
ns.Chat = ns.Chat or {}
ns.Transport = ns.Transport or {}
ns.Character = ns.Character or {}
ns.Actions = ns.Actions or {}
ns.Integrations = ns.Integrations or {}
ns.ChatHistory = ns.ChatHistory or {}
ns.Settings = ns.Settings or {}
ns.UI = ns.UI or {}
ns.Inline = ns.Inline or {}
ns.Panels = ns.Panels or {}
ns.Advice = ns.Advice or {}
ns.UI.Memory = ns.UI.Memory or {}
ns.UI.Capabilities = ns.UI.Capabilities or {}
