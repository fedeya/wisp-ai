<script lang="ts">
  import { card } from "../ui";

  import Toggle from "../Toggle.svelte";
  import DataState from "../DataState.svelte";
  import ActionProgress from "../ActionProgress.svelte";
  import type { DesktopController } from "../desktop-controller.svelte";
  let { app }: { app: DesktopController } = $props();
</script>

{#if app.loading || !app.status}<DataState {app} />{:else}
  {#each (app.status?.integrations || []).filter((entry) => entry.group === "memory") as entry (entry.id)}
    <section
      class={card({
        kind: "toggle",
        class: "card toggle-card gap-[22px] flex items-center justify-between",
      })}
    >
      <div class="toggle-description gap-[18px] flex items-center">
        <div>
          <h2 class="text-[15px] max-lg:text-[14px]">
            {entry.name}
          </h2>
          <p class="text-muted text-[12px]">
            {entry.description}
          </p>
        </div>
      </div>
      <div class="row-controls gap-[14px] flex items-center shrink-0">
        <ActionProgress {app} target={entry.id} /><Toggle
          label={`Enable ${entry.name}`}
          checked={entry.enabled}
          disabled={app.locked}
          onchange={(checked) => app.setIntegration(entry.id, checked)}
        />
      </div>
    </section>
  {:else}<section
      class={card({
        kind: "empty",
        class:
          "card empty-state text-center [&_>_svg]:text-[#577e7c] [&_>_svg]:mb-[16px]",
      })}
    >
      <h2 class="text-[21px]">No memory controls available</h2>
      <p
        class="mx-auto text-muted text-[13px] max-w-[400px] mt-[12px] mb-[23px]"
      >
        Memory preferences will appear when Wisp makes them available.
      </p>
    </section>{/each}
{/if}
