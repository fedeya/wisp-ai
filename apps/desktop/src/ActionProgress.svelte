<script lang="ts">
  import type { DesktopController } from "./desktop-controller.svelte";
  let { app, target = "" }: { app: DesktopController; target?: string } =
    $props();
</script>

<span
  class="action-progress gap-[8px] inline-flex items-center text-[12px] text-muted [&:empty]:hidden"
  role="status"
  aria-live="polite"
>
  {#if app.busy && app.busyTarget === target}<span
      class="spinner border-[2px] border-solid w-[15px] h-[15px] rounded-[50%] border-t-[var(--accent)] border-r-[#77dbc633] border-b-[#77dbc633] border-l-[#77dbc633] animate-spinner shrink-0"
    ></span>{app.busy}…{/if}
</span>
