<script lang="ts">
  import { card, button } from "./ui";

  import type { DesktopController } from "./desktop-controller.svelte";
  import Icon from "./Icon.svelte";
  let { app }: { app: DesktopController } = $props();
</script>

<section
  class={card({
    kind: "empty",
    class:
      "card empty-state text-center [&_>_svg]:text-[#577e7c] [&_>_svg]:mb-[16px]",
  })}
  aria-live="polite"
>
  {#if app.loading}
    <span
      class="spinner border-[2px] border-solid w-[15px] h-[15px] rounded-[50%] border-t-[var(--accent)] border-r-[#77dbc633] border-b-[#77dbc633] border-l-[#77dbc633] animate-spinner shrink-0 inline-block mb-[16px]"
    ></span>
    <h2 class="text-[21px]">Loading your workspace…</h2>
    <p class="mx-auto text-muted text-[13px] max-w-[400px] mt-[12px] mb-[23px]">
      Checking Wisp and your saved data.
    </p>
  {:else}
    <Icon name="link" size={30} />
    <h2 class="text-[21px]">
      {app.starting && !app.connectionError
        ? "Wisp is starting"
        : "Connect to Wisp to view your data"}
    </h2>
    <p class="mx-auto text-muted text-[13px] max-w-[400px] mt-[12px] mb-[23px]">
      {app.starting && !app.connectionError
        ? "Your workspace will appear when the service is ready."
        : "Your saved data is unavailable while Wisp is stopped or unreachable."}
    </p>
    <button class={button({})} onclick={() => (app.page = "Overview")}
      >Go to Overview<Icon name="arrow" size={16} /></button
    >
    {#if app.connectionError}<button
        class={button({ intent: "quiet", class: "quiet" })}
        onclick={app.showLogs}>View diagnostics</button
      >{/if}
  {/if}
</section>
