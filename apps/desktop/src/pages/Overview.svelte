<script lang="ts">
  import { card, button, badge, field } from "../ui";

  import type { DesktopController } from "../desktop-controller.svelte";
  import Icon from "../Icon.svelte";
  import ActionProgress from "../ActionProgress.svelte";
  import { desktop, native } from "../api";
  let { app }: { app: DesktopController } = $props();
  let editingInstallation = $state(false);
  let choosingFolder = $derived(app.busy === "Choosing folder");
  function chooseFolder() {
    void app.work(
      "Choosing folder",
      app.chooseFolder,
      undefined,
      "folder-picker",
    );
  }
  let installationOpen = $derived(
    !app.info?.configured || !!app.info?.addonOutdated || editingInstallation,
  );
  let next = $derived<keyof typeof steps>(
    app.loading
      ? "loading"
      : !app.info?.configured
        ? app.detectingGame
          ? "searching"
          : "install"
        : app.info?.addonOutdated
          ? "update"
          : !app.status
            ? app.starting && !app.connectionError
              ? "starting"
              : "start"
            : !app.status.ready
              ? "starting"
              : !app.connected
                ? "account"
                : !app.status.gameConnected
                  ? "game"
                  : "ready",
  );
  const steps = {
    searching: {
      title: "Finding WoW Forever",
      description: "Searching for your game installation.",
    },
    loading: {
      title: "Checking Wisp…",
      description: "Checking your installation and connections.",
    },
    install: {
      title: "Welcome to Wisp",
      description:
        "Install the addon, connect an AI provider, and meet Wisp in game.",
    },
    update: {
      title: "Update your Wisp addon",
      description:
        "Install the latest addon, then type /reload in WoW to finish updating.",
    },
    starting: {
      title: "Getting Wisp ready…",
      description:
        "Waiting for the local service. Your connections will update automatically.",
    },
    start: {
      title: "Start Wisp to continue",
      description:
        "Your installation is saved. Start the local service to reconnect.",
    },
    account: {
      title: "Connect your AI account",
      description:
        "Connect ChatGPT or an API provider, then choose a default model.",
    },
    game: {
      title: "Ready when you enter Azeroth",
      description:
        "Open WoW with Wisp AI enabled. Already in game? Type /reload.",
    },
    ready: {
      title: "Everything is ready",
      description:
        "Open /wisp in game, or hover an item and use your inline shortcut.",
    },
  };
</script>

<section
  class={card({
    kind: "workspace",
    ready: next === "ready",
    class:
      "card workspace-status [background:linear-gradient(120deg,_#1d2c2d,_var(--surface)_80%)] [&_>_.action-progress:not(:empty)]:mt-[12px]",
  })}
>
  <div class="status-heading gap-[18px] flex items-start">
    <div
      class="status-symbol border border-solid border-[#3c6258] w-[52px] h-[52px] shrink-0 grid [place-items:center] [background:#243e38] rounded-[14px] text-accent"
    >
      <Icon name={next === "ready" ? "check" : "spark"} size={27} />
    </div>
    <div>
      <span
        class="eyebrow gap-[8px] text-[#8fa5ac] text-[9px] font-semibold tracking-[1.3px] flex items-center"
        >YOUR WORKSPACE</span
      >
      <h2
        class="text-[25px] mt-[8px] leading-[1.3] tracking-[-0.6px] max-md:text-[23px]"
      >
        {steps[next].title}
      </h2>
      <p class="text-muted text-[14px] max-w-[570px]">
        {steps[next].description}
      </p>
    </div>
  </div>
  <div
    class="actions status-actions gap-[10px] mt-[22px] flex flex-wrap items-center mr-0 mb-[24px] ml-[70px] min-h-[37px]"
  >
    {#if next === "update"}<button
        class={button({ intent: "primary", class: "primary" })}
        disabled={!native || app.locked || !app.wow}
        onclick={app.install}
        >{app.busy === "Installing addon"
          ? "Updating addon…"
          : "Update addon"}</button
      >
    {:else if next === "start"}<button
        class={button({ intent: "primary", class: "primary" })}
        disabled={!!app.busy || !native}
        onclick={app.start}>Start Wisp</button
      >
    {:else if next === "account"}<button
        class={button({ intent: "primary", class: "primary" })}
        onclick={() => (app.page = "Connections")}
        >Connect AI<Icon name="arrow" size={16} /></button
      >
    {:else if next === "game"}<span class={badge({ class: "badge" })}
        >Waiting for WoW</span
      ><button
        class={button({ intent: "quiet", class: "quiet" })}
        onclick={() => (editingInstallation = true)}>Check installation</button
      >
    {:else if next === "ready"}<span
        class={badge({ class: "badge good text-accent!" })}
        ><span
          class="live-dot online w-[6px] h-[6px] rounded-[50%] [background:var(--accent)] inline-block shrink-0 [box-shadow:0_0_10px_#77dbc633]"
        ></span>Ready to help</span
      >
    {:else if next !== "searching" && next !== "install"}<span
        class="spinner border-[2px] border-solid w-[15px] h-[15px] rounded-[50%] border-t-[var(--accent)] border-r-[#77dbc633] border-b-[#77dbc633] border-l-[#77dbc633] animate-spinner shrink-0"
      ></span>{/if}
  </div>
  <div
    class="connection-summary border-t-[1px] [border-top-style:solid] border-t-[var(--border)] pt-[8px] [&_>_div_>_span:nth-child(2)]:w-[150px] [&_>_div_>_span:nth-child(2)]:text-muted"
  >
    <div class="gap-[10px] flex items-center min-h-[46px] text-[13px]">
      <span
        class="live-dot w-[6px] h-[6px] rounded-[50%] bg-[#6e7f85] inline-block shrink-0 [&.online]:bg-accent [&.online]:shadow-[0_0_10px_#77dbc633]"
        class:online={app.status?.gameConnected}
      ></span><span>World of Warcraft</span><strong class="font-medium"
        >{app.loading
          ? "Checking…"
          : !app.status
            ? "Not checked"
            : app.status.gameConnected
              ? "Connected"
              : "Waiting for game"}</strong
      >
    </div>
    <div class="gap-[10px] flex items-center min-h-[46px] text-[13px]">
      <span
        class="live-dot w-[6px] h-[6px] rounded-[50%] bg-[#6e7f85] inline-block shrink-0 [&.online]:bg-accent [&.online]:shadow-[0_0_10px_#77dbc633]"
        class:online={app.connected}
      ></span><span>AI provider</span><strong class="font-medium"
        >{app.loading
          ? "Checking…"
          : !app.status
            ? "Not checked"
            : app.connected
              ? "Connected"
              : "Not connected"}</strong
      >{#if !app.loading && !app.connected && app.status}<button
          class={button({
            intent: "quiet",
            size: "text",
            class:
              "text-button px-0 py-[4px] min-h-[24px] text-accent ml-auto text-[12px]",
          })}
          onclick={() => (app.page = "Connections")}>Connect</button
        >{/if}
    </div>
    <div class="gap-[10px] flex items-center min-h-[46px] text-[13px]">
      <span
        class="live-dot w-[6px] h-[6px] rounded-[50%] bg-[#6e7f85] inline-block shrink-0 [&.online]:bg-accent [&.online]:shadow-[0_0_10px_#77dbc633]"
        class:online={app.status?.ready}
      ></span><span>Wisp service</span><strong class="font-medium"
        >{app.active
          ? "Working…"
          : app.loading
            ? "Checking…"
            : app.status?.ready
              ? "Running"
              : app.connectionError
                ? "Unavailable"
                : app.starting || app.status
                  ? "Starting…"
                  : "Stopped"}</strong
      >{#if app.status}<button
          class={button({
            intent: "quiet",
            size: "text",
            class:
              "text-button px-0 py-[4px] min-h-[24px] text-accent ml-auto text-[12px]",
          })}
          disabled={app.locked}
          onclick={() =>
            app.work(
              "Stopping Wisp",
              async () => {
                await desktop("stop_bridge");
                app.starting = false;
              },
              "Wisp stopped.",
            )}>Stop Wisp</button
        >{/if}
    </div>
  </div>
  <ActionProgress {app} />
</section>

{#if !app.loading}
  <section
    class={card({
      kind: "installation",
      class: "card installation-card",
    })}
  >
    <div
      class="section-title gap-[18px] flex items-center justify-between max-xl:flex-wrap [&_>_svg]:text-muted"
    >
      <div
        class="installation-heading gap-[14px] flex items-center min-w-[0] [&_>_svg]:text-muted [&_>_svg]:shrink-0"
      >
        <Icon name="folder" size={20} />
        <div class="min-w-[0]">
          <h2>Game installation</h2>
          {#if app.info?.configured}<p
              class="installation-path [overflow-wrap:anywhere] text-muted text-[13px]"
            >
              {app.info.wow || app.wow}
            </p>{/if}
        </div>
      </div>
      {#if app.info?.configured}<div
          class="installation-controls gap-[10px] flex items-center shrink-0 flex-wrap"
        >
          <span
            class={badge({
              positive: !app.info.addonOutdated,
              class: "badge",
            })}
            >{app.info.addonOutdated
              ? "Update needed"
              : "Addon installed"}</span
          ><button
            class={button({ intent: "quiet", class: "quiet" })}
            aria-expanded={installationOpen}
            onclick={() => (editingInstallation = !editingInstallation)}
            >{installationOpen && !app.info.addonOutdated
              ? "Done"
              : "Manage installation"}</button
          >
        </div>{:else}<button
          class={button({ intent: "quiet", class: "quiet" })}
          disabled={!native || app.locked || app.detectingGame}
          onclick={app.searchInstallations}
          aria-label="Search again"
          title="Search again"
          ><Icon name="refresh" size={17} />Search again</button
        >{/if}
    </div>
    {#if installationOpen}
      {#if !app.info?.configured && app.detectingGame}
        <p
          class="field-hint installation-search gap-[10px] flex items-center text-[11px]! text-muted mt-[12px]"
          role="status"
        >
          <span
            class="spinner border-[2px] border-solid w-[15px] h-[15px] rounded-[50%] border-t-[var(--accent)] border-r-[#77dbc633] border-b-[#77dbc633] border-l-[#77dbc633] animate-spinner shrink-0"
          ></span>Searching for installation…
        </p>
      {:else}
        {#if !app.info?.configured && app.detectedFolders.length > 1}
          <label
            class="field-hint text-[11px]! text-muted mt-[12px]"
            for="detected-game">Found multiple Forever installations</label
          >
          <select
            class={field({})}
            id="detected-game"
            aria-label="Detected Forever installations"
            bind:value={app.wow}
            disabled={!!app.busy}
          >
            {#if app.wow && !app.detectedFolders.includes(app.wow)}<option
                value={app.wow}>{app.wow}</option
              >{/if}
            {#each app.detectedFolders as folder}<option value={folder}
                >{folder}</option
              >{/each}
          </select>
        {:else if !app.info?.configured && app.detectedFolders.length === 0}
          <p class="field-hint text-[11px]! text-muted mt-[12px]">
            {app.detectionFailed
              ? "Couldn't search automatically. Choose your folder or search again."
              : "No WoW Forever installation found. Choose your folder or search again."}
          </p>
        {/if}
        <div class="folder-field gap-[12px] mt-[17px] flex items-center">
          {#if app.info?.configured || app.detectedFolders.length < 2}
            <input
              class={field({
                class: "folder-picker cursor-pointer flex-[1]",
              })}
              aria-label="WoW client folder"
              bind:value={app.wow}
              placeholder="Choose your World of Warcraft folder"
              disabled={!!app.busy || !native}
              readonly
              aria-haspopup="dialog"
              onclick={chooseFolder}
              onkeydown={(event) => {
                if (event.key === "Enter") chooseFolder();
              }}
            />{/if}<button
            class={button({})}
            onclick={chooseFolder}
            disabled={!!app.busy || !native}
            aria-busy={choosingFolder}
            >{#if choosingFolder}<span
                class="spinner border-[2px] border-solid w-[15px] h-[15px] rounded-[50%] border-t-[var(--accent)] border-r-[#77dbc633] border-b-[#77dbc633] border-l-[#77dbc633] animate-spinner shrink-0"
              ></span>Choosing…{:else}<Icon name="folder" size={17} />Choose
              folder{/if}</button
          >
        </div>
      {/if}
      {#if app.info?.addonOutdated}<p
          class="field-hint text-[11px]! text-muted mt-[12px]"
        >
          Update the addon, then type /reload in WoW.
        </p>{/if}
      <div class="actions gap-[10px] mt-[22px] flex flex-wrap items-center">
        {#if !app.info?.configured && !app.detectingGame}<button
            class={button({ intent: "primary", class: "primary" })}
            onclick={app.install}
            disabled={app.locked || !app.wow || !native}
            >{app.busy === "Installing addon"
              ? "Installing…"
              : "Install addon"}</button
          >{:else if app.info?.configured && next !== "update"}<button
            class={button({
              intent: "primary",
            })}
            onclick={app.install}
            disabled={app.locked || !app.wow || !native}
            >{app.busy === "Installing addon"
              ? "Installing…"
              : "Install / update addon"}</button
          >{/if}<ActionProgress {app} target="installation" />
      </div>
      {#if !app.info?.configured && !app.detectingGame}<button
          class={button({
            intent: "quiet",
            size: "text",
            class:
              "text-button import px-0 py-[4px] mx-0 min-h-[24px] text-accent text-[12px] mt-[18px] mb-0",
          })}
          onclick={app.importPrevious}
          disabled={!!app.busy || !native || app.detectingGame}
          >Already using Wisp? Import your previous installation.</button
        >{/if}
    {/if}
  </section>
{/if}
