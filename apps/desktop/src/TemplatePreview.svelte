<script lang="ts">
  import type { PassiveTemplate } from "@wisp/protocol/panel-template";
  import Input from "./ui/Input.svelte";
  let {
    template = $bindable(),
    editable = false,
  }: { template: PassiveTemplate; editable?: boolean } = $props();
</script>

<section
  aria-label="Complete template preview"
  class="rounded-[10px] border border-[#3a4c4f] p-[18px] my-[16px]"
>
  <h2 class="text-[20px] mb-[12px] break-words">{template.title}</h2>
  <p class="text-muted text-[12px] mb-[12px]">
    Unavailable until your own local bag reading. Item identity/availability not
    verified by this template.
  </p>
  {@render nodes(undefined)}
</section>

{#snippet nodes(parent: string | undefined)}
  {#each template.ui.filter((n) => n.parent === parent) as node (node.id)}
    {#if node.kind === "card" || node.kind === "column" || node.kind === "row"}
      <div
        class="my-[8px] p-[12px] rounded-[8px] border border-[#3a4c4f] min-w-0"
      >
        {#if node.title !== undefined}<h3 class="break-words mb-[8px]">
            {node.title}
          </h3>{/if}
        <div
          class={node.kind === "row"
            ? "flex gap-[14px] flex-wrap"
            : "grid gap-[10px]"}
        >
          {@render nodes(node.id)}
        </div>
      </div>
    {:else if node.kind === "text"}
      <p class="whitespace-pre-wrap break-words">{node.text}</p>
    {:else}
      {@const binding = template.bindings.find((b) => b.nodeId === node.id)!}
      <div
        class="flex flex-1 flex-wrap items-center justify-between gap-[12px] min-w-0 rounded-[8px] bg-[#182327] p-[12px]"
      >
        <div class="flex-1 min-w-0">
          <strong class="break-words">{node.label}</strong>
          <p class="text-muted text-[12px] mt-[4px]">
            Item #{binding.itemId} · Forever · {node.kind}
          </p>
        </div>
        {#if editable}
          <label class="text-[12px]"
            >Target
            <Input
              type="number"
              required
              min="1"
              step="1"
              aria-invalid={!Number.isSafeInteger(binding.target) ||
                binding.target <= 0}
              aria-label={`Target for ${node.label}`}
              bind:value={binding.target}
              class="mt-[4px] w-[100px]"
            />
          </label>
        {:else}<p>Target: {binding.target}</p>{/if}
      </div>
    {/if}
  {/each}
{/snippet}
