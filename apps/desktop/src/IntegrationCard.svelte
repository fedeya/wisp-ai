<script lang="ts">
  import { card, badge, field } from "./ui";

  import Toggle from "./Toggle.svelte";
  import type { CapabilityView } from "@wisp/protocol/capabilities";
  let {
    entry,
    tools,
    locked,
    busy = "",
    set,
  }: {
    entry: CapabilityView;
    tools: CapabilityView[];
    locked: boolean;
    busy?: string;
    set: (id: string, enabled: boolean) => void;
  } = $props();
</script>

<section class={card({ kind: "integration", class: "card integration" })}>
  <div class="integration-top gap-[18px] flex items-center justify-between">
    <div>
      <h2>{entry.name}</h2>
      <p class="text-muted text-[13px]">
        {entry.description}
      </p>
    </div>
    <div class="row-controls gap-[14px] flex items-center shrink-0">
      {#if busy}<span
          class="action-progress gap-[8px] inline-flex items-center text-[12px] text-muted [&:empty]:hidden"
          role="status"
          ><span
            class="spinner border-[2px] border-solid w-[15px] h-[15px] rounded-[50%] border-t-[var(--accent)] border-r-[#77dbc633] border-b-[#77dbc633] border-l-[#77dbc633] animate-spinner shrink-0"
          ></span>{busy}…</span
        >{/if}<Toggle
        label={`Enable ${entry.name}`}
        checked={entry.enabled}
        disabled={locked}
        onchange={(checked) => set(entry.id, checked)}
      />
    </div>
  </div>
  <div
    class="integration-meta gap-[12px] flex text-muted text-[12px] mt-[18px] items-center flex-wrap [&_span_+_span]:border-l-[1px] [&_span_+_span]:[border-left-style:solid] [&_span_+_span]:border-l-[#3a4a4e] [&_span_+_span]:pl-[18px]"
  >
    <span class={badge({ positive: entry.available, class: "badge" })}
      >{entry.status}</span
    ><span>{entry.kind === "mcp" ? "MCP" : entry.kind}</span
    >{#if entry.version}<span>v{entry.version}</span>{/if}<span
      >{tools.filter((tool) => tool.effective).length}/{tools.length} active</span
    >
  </div>
  {#if entry.reason}<p
      class="muted integration-reason mx-0 text-muted text-[13px] mt-[12px] mb-0"
    >
      {entry.reason}
    </p>{/if}
  {#if tools.length}<details
      class="integration-tools mt-[16px] border-t-[1px] [border-top-style:solid] border-t-[#ffffff12] pt-[12px]"
    >
      <summary class="cursor-pointer text-muted text-[13px]"
        >Tools & capabilities ({tools.length})</summary
      >
      {#each tools as tool (tool.id)}<label
          class="integration-tool gap-[12px] px-0 py-[14px] flex items-start border-b-[1px] [border-bottom-style:solid] border-b-[#ffffff08] [&:last-child]:border-0 [&:last-child]:border-none [&:last-child]:border-[currentColor] [&:last-child]:pb-0 [&.inactive]:opacity-[0.5]"
          class:inactive={!entry.enabled}
        >
          <input
            class={field({
              kind: "checkbox",
              class:
                "p-0 [accent-color:var(--accent)] w-[16px] h-[16px] min-h-[0] shrink-0",
            })}
            type="checkbox"
            aria-label={`${entry.name}: ${tool.name}`}
            checked={tool.enabled}
            disabled={locked || !entry.enabled}
            onchange={(event) => set(tool.id, event.currentTarget.checked)}
          />
          <span class="gap-[5px] grid min-w-[0]"
            ><strong class="text-[13px] font-medium">{tool.name}</strong
            >{#if tool.toolName}<code
                class="text-[11px] text-muted [overflow-wrap:anywhere]"
                >{tool.toolName}</code
              >{/if}{#if !tool.available}<small
                class="tool-unavailable text-[12px] leading-[1.5] text-[#929b9a]"
                >{tool.status}: {tool.reason ||
                  "Required API unavailable"}</small
              >{/if}<small class="text-[12px] leading-[1.5] text-[#929b9a]"
              >{tool.description}</small
            ></span
          >
        </label>{/each}
    </details>{/if}
</section>
