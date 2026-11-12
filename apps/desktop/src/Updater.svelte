<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { onMount, tick } from "svelte";
  import logo from "../src-tauri/icons/128x128@2x.png";

  type UpdateState = {
    phase: "preparing" | "installing" | "reopening" | "failed";
    percent: number | null;
    log: string[];
    error: string | null;
  };

  let update = $state<UpdateState>({
    phase: "preparing",
    percent: null,
    log: [],
    error: null,
  });
  let logPanel = $state<HTMLPreElement>();
  let closeButton = $state<HTMLButtonElement>();
  let failed = $derived(update.phase === "failed");
  let status = $derived(
    {
      preparing: "Preparing the update",
      installing: "Installing the update",
      reopening: "Reopening Wisp",
      failed: "The installation stopped. Try updating Wisp again.",
    }[update.phase],
  );

  onMount(() => {
    let timer: ReturnType<typeof setTimeout>;
    let active = true;
    async function refresh() {
      try {
        const next = await invoke<UpdateState>("updater_status");
        if (!active) return;
        update = next;
        if (next.phase === "failed") {
          await tick();
          if (logPanel) logPanel.scrollTop = logPanel.scrollHeight;
          closeButton?.focus();
          return;
        }
      } catch {
        // The installer can close while the last status request is in flight.
      }
      if (active) timer = setTimeout(refresh, 120);
    }
    void invoke("updater_ready")
      .then(refresh)
      .catch(() => {});
    return () => {
      active = false;
      clearTimeout(timer);
    };
  });
</script>

<main
  class="min-h-dvh border border-solid border-border bg-[#14191d] px-[25px] pt-[15px] pb-[24px] [background-image:radial-gradient(ellipse_at_15%_0%,#243a38_0%,transparent_58%)]"
>
  <header
    class="h-[30px] text-[12px] font-semibold text-muted select-none"
    data-tauri-drag-region
  >
    Wisp AI
  </header>
  <section
    class={[
      "mt-[10px] flex min-h-[92px] items-center gap-[17px]",
      failed ? "mb-[15px]" : "mb-[25px]",
    ]}
    aria-live="polite"
  >
    <div
      class="grid size-[68px] flex-none place-items-center rounded-[18px] border border-solid border-[#45625c] bg-[#1b2c2a]"
    >
      <img class="size-[57px] object-contain" src={logo} alt="" />
    </div>
    <div>
      <h1 class="m-0 text-[25px] tracking-[-0.7px]">
        {failed ? "Couldn't update Wisp" : "Updating Wisp"}
      </h1>
      <p
        class={[
          "mt-[5px] text-[13px] [overflow-wrap:anywhere]",
          failed ? "text-[#e8aca5]" : "text-muted",
        ]}
      >
        {failed ? (update.error ?? status) : "Wisp will reopen automatically."}
      </p>
    </div>
  </section>

  {#if failed}
    <section
      class="overflow-hidden rounded-[12px] border border-solid border-border bg-[#11171a]"
    >
      <h2
        class="border-0 border-b border-solid border-[#2a3438] px-[12px] py-[10px] text-[12px] text-[#c5d3d1]"
      >
        Installation log
      </h2>
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (Allow keyboard scrolling in the log.) -->
      <pre
        class="m-0 max-h-[113px] min-h-[72px] overflow-auto px-[12px] py-[10px] whitespace-pre-wrap text-[#adbcbf] [font:11px/1.6_Consolas,monospace] [overflow-wrap:anywhere]"
        bind:this={logPanel}
        tabindex="0"
        aria-label="Installation log">{update.log.join("\n")}</pre>
    </section>
    <footer class="mt-[17px] flex justify-end">
      <button
        class="min-w-[92px] cursor-pointer rounded-[8px] border border-solid border-[#518178] bg-[#29443f] px-[17px] py-[8px] font-semibold text-[#dcf3ed] hover:bg-[#355951] focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-accent"
        bind:this={closeButton}
        onclick={() => invoke("updater_close")}>Close</button
      >
    </footer>
  {:else}
    <section
      class="rounded-[12px] border border-solid border-border bg-surface px-[16px] py-[15px]"
    >
      <div
        class="mb-[10px] flex justify-between gap-[12px] text-[13px] text-[#c5d3d1]"
      >
        <span>{status}</span>
        {#if update.percent !== null}
          <strong class="text-accent tabular-nums">{update.percent}%</strong>
        {/if}
      </div>
      <progress
        class="block h-[6px] w-full appearance-none rounded-[10px] accent-accent [&::-webkit-progress-bar]:rounded-[10px] [&::-webkit-progress-bar]:bg-[#344146] [&::-webkit-progress-value]:rounded-[10px] [&::-webkit-progress-value]:bg-accent"
        max={100}
        value={update.percent ?? undefined}
        aria-label={status}
      ></progress>
    </section>
  {/if}
</main>
