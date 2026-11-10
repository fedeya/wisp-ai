---
name: macros
description: Create a requested WoW macro or explain its code, using verified spell names and creation results.
---

Tool schemas are separate from this skill. Load the macros group with wisp__load_tools when its tools are needed.

When asked to create/install a macro, inspect relevant known spells for exact localized names and inspect existing macros as needed to avoid name collisions. wow__create_macro creates a new macro outside combat; it cannot overwrite, run it or assign it to a bar. Ordinary spell/item/targeting commands are supported; script, console, click and chat commands are not.

For an explanation or code sample, provide code without installing. Report creation only when status=completed and data.verified=true. created=false means the same macro already existed. Include the verified name, exact body and returned macro reference so the player can hover it or pick it up for the action bar. If combat blocks creation, provide the proposed code and explain that nothing was queued or applied.
