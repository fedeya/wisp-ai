<script lang="ts">
  import { button, field } from "./ui";

  import { untrack } from "svelte";
  import { request, type Mcp } from "./api";
  import Icon from "./Icon.svelte";
  let {
    server,
    close,
    saved,
  }: { server: Mcp | null; close: () => void; saved: () => Promise<void> } =
    $props();
  const initial = untrack(() => server);
  let name = $state(initial?.name || "");
  let description = $state(initial?.description || "");
  let transport = $state(initial?.transport || "http");
  let address = $state(initial?.url || initial?.command || "");
  let args = $state(JSON.stringify(initial?.args || []));
  let env = $state("");
  let token = $state("");
  let clearToken = $state(false);
  let enabled = $state(initial?.enabled ?? true);
  let busy = $state(false);
  let note = $state("");
  let error = $state(false);
  async function submit(save: boolean) {
    if (busy) {
      return;
    }
    busy = true;
    note = save ? "Saving connection…" : "Testing connection…";
    error = false;
    try {
      const parsedArgs = transport === "stdio" ? JSON.parse(args) : [];
      if (
        !Array.isArray(parsedArgs) ||
        parsedArgs.some((a) => typeof a !== "string")
      ) {
        throw Error("Arguments must be a JSON array of strings.");
      }
      const parsedEnv = env.trim() ? JSON.parse(env) : undefined;
      if (
        parsedEnv &&
        (typeof parsedEnv !== "object" ||
          Array.isArray(parsedEnv) ||
          Object.values(parsedEnv).some((v) => typeof v !== "string"))
      ) {
        throw Error("Environment must be a JSON object with string values.");
      }
      const definition = {
        name,
        description,
        transport,
        enabled,
        args: parsedArgs,
        ...(transport === "stdio" ? { command: address } : { url: address }),
      };
      const payload = {
        server: definition,
        ...(parsedEnv ? { env: parsedEnv } : {}),
        ...(clearToken ? { token: "" } : token ? { token } : {}),
      };
      const result = await request<{ count: number }>(
        save ? "/mcps/save" : "/mcps/test",
        payload,
      );
      if (save) {
        await saved();
        close();
      } else {
        note = `Connected. ${result.count} tools available.`;
      }
    } catch (e) {
      error = true;
      note = String(e).replace(/^Error: /, "");
    } finally {
      busy = false;
    }
  }
</script>

<div
  class="scrim p-[25px] fixed top-[0] right-[0] bottom-[0] left-[0] [background:#050c10b8] [backdrop-filter:blur(5px)] grid [place-items:center] z-[20]"
>
  <div
    class="dialog border border-solid border-[#3c535b] p-[27px] w-[min(600px,_100%)] max-h-[90vh] overflow-auto [background:#1c252b] rounded-[16px] [box-shadow:0_25px_100px_#0009]"
    role="dialog"
    aria-modal="true"
    aria-labelledby="mcp-title"
    tabindex="-1"
  >
    <header class="flex justify-between items-center mb-[22px]">
      <div>
        <p
          class="eyebrow gap-[8px] text-[#8fa5ac] text-[9px] font-semibold tracking-[1.3px] flex items-center"
        >
          TOOL CONNECTION
        </p>
        <h2 class="text-[23px] mt-[7px]" id="mcp-title">
          {server ? "Edit connection" : "Add an MCP"}
        </h2>
      </div>
      <button
        class={button({
          intent: "quiet",
          size: "icon",
          class: "icon-button p-[6px] min-h-[30px]",
        })}
        aria-label="Close dialog"
        onclick={close}
        disabled={busy}><Icon name="close" /></button
      >
    </header>
    <div class="form-grid gap-[16px] grid grid-cols-[1fr_1fr]">
      <label
        class="gap-[8px] mx-0 my-[15px] flex flex-col text-[#b6c9cf] text-[12px]"
        >Name<input
          class={field({})}
          bind:value={name}
          disabled={!!server || busy}
          placeholder="my_connection"
        /></label
      ><label
        class="gap-[8px] mx-0 my-[15px] flex flex-col text-[#b6c9cf] text-[12px]"
        >Transport<select
          class={field({})}
          bind:value={transport}
          disabled={busy}
          ><option value="http">Streamable HTTP</option><option value="sse"
            >SSE</option
          ><option value="stdio">Local process (stdio)</option></select
        ></label
      >
    </div>
    <label
      class="gap-[8px] mx-0 my-[15px] flex flex-col text-[#b6c9cf] text-[12px]"
      >Description<input
        class={field({})}
        bind:value={description}
        placeholder="What can this connection help with?"
      /></label
    >
    <label
      class="gap-[8px] mx-0 my-[15px] flex flex-col text-[#b6c9cf] text-[12px]"
      >{transport === "stdio" ? "Executable or command" : "Endpoint URL"}<input
        class={field({})}
        bind:value={address}
        placeholder={transport === "stdio" ? "npx" : "https://example.com/mcp"}
      /></label
    >
    {#if transport === "stdio"}<label
        class="gap-[8px] mx-0 my-[15px] flex flex-col text-[#b6c9cf] text-[12px]"
        >Arguments <span class="muted text-muted text-[10px]">JSON array</span
        ><input class={field({})} bind:value={args} /></label
      ><label
        class="gap-[8px] mx-0 my-[15px] flex flex-col text-[#b6c9cf] text-[12px]"
        >Environment <span class="muted text-muted text-[10px]"
          >Blank keeps stored values</span
        ><textarea
          class={field({ kind: "area" })}
          rows="2"
          bind:value={env}
          placeholder={'{"API_KEY":"…"}'}></textarea></label
      >{:else}<label
        class="gap-[8px] mx-0 my-[15px] flex flex-col text-[#b6c9cf] text-[12px]"
        >Bearer token <span class="muted text-muted text-[10px]"
          >Blank keeps stored token</span
        ><input
          class={field({})}
          type="password"
          bind:value={token}
          autocomplete="off"
        />{#if server?.hasToken}<span class="muted text-muted text-[10px]"
            >A token is securely stored.</span
          >{/if}</label
      ><label
        class="check-row gap-[9px] mx-0 my-[15px] flex flex-row text-[#b6c9cf] text-[12px] items-center"
        ><input
          class={field({
            kind: "checkbox",
            class: "w-[15px] h-[15px] min-h-[0] [accent-color:var(--accent)]",
          })}
          type="checkbox"
          bind:checked={clearToken}
        />Remove stored token</label
      >{/if}
    <label
      class="check-row gap-[9px] mx-0 my-[15px] flex flex-row text-[#b6c9cf] text-[12px] items-center"
      ><input
        class={field({
          kind: "checkbox",
          class: "w-[15px] h-[15px] min-h-[0] [accent-color:var(--accent)]",
        })}
        type="checkbox"
        bind:checked={enabled}
      />Enable connection</label
    >
    <p
      class:error
      class="notice-inline text-[11px] text-muted min-h-[32px] [&.error]:text-[#efafa2]"
      aria-live="polite"
    >
      {note ||
        "Test the connection before saving. Local commands run on your computer."}
    </p>
    <footer class="gap-[12px] flex justify-end mt-[22px]">
      <button
        class={button({})}
        onclick={() => submit(false)}
        disabled={busy || !name || !address}>Test connection</button
      ><button
        class={button({ intent: "primary", class: "primary" })}
        onclick={() => submit(true)}
        disabled={busy || !name || !address}
        >{busy ? "Working…" : "Save connection"}</button
      >
    </footer>
  </div>
</div>
