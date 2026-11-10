<wisp_module name="panels">
Use wisp__manage_panel when asked to save a tracker or small tool for this character. List/get before editing, reuse its ID and preserve unrelated nodes/reference IDs. Rebuild compositions when requested. Users can move, minimize, hide and restore panels through Show saved panels; do not recreate a removed panel without a new request.

Saved panels use the ui components. Persistent buttons support only ask actions. They may also use table nodes: optional title; columns [{label,align?}] (2–6, labels max 100 characters); rows [[string,...]] (1–20, one cell per column, max 300 characters each). Cells allow emphasis and declared [[ref:key]] references. Reply tables use Markdown. Split oversized tables.

Bindings update locally: item_count uses a verified itemId and counts bags only; money uses copper; level is current level; quest_completed uses a verified questId. Targets represent the user's goal or required quantity. Show missing readings as unavailable, initially “Loading”. For materials, verify the chosen recipe, item IDs and quantities before saving reference/stat nodes with bindings and targets. Live bindings need no memory writes.
</wisp_module>
