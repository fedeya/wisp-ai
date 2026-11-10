<script lang="ts">
  import { navigationButton, button } from "./ui";

  import { createDesktopController } from "./desktop-controller.svelte";
  import { native } from "./api";
  import Icon from "./Icon.svelte";
  import McpDialog from "./McpDialog.svelte";
  import Updates from "./Updates.svelte";
  import logo from "../../../assets/wisp.png";
  import Overview from "./pages/Overview.svelte";
  import Connections from "./pages/Connections.svelte";
  import Integrations from "./pages/Integrations.svelte";
  import Memory from "./pages/Memory.svelte";
  import Panels from "./pages/Panels.svelte";
  import Routines from "./pages/Routines.svelte";
  import Diagnostics from "./pages/Diagnostics.svelte";
  const app = createDesktopController();

  $effect(() => {
    if (!app.feedback || app.busy) {
      return;
    }
    const timeout = setTimeout(
      () => (app.feedback = ""),
      app.failed ? 10000 : 5000,
    );
    return () => clearTimeout(timeout);
  });
</script>

<div class="flex min-h-screen">
  <aside
    class="px-[14px] py-[26px] w-[210px] shrink-0 [background:#0f1316] fixed top-[0] right-[auto] bottom-[0] left-[0] flex flex-col border-r-[1px] [border-right-style:solid] border-r-[#1b2529] overflow-y-auto max-md:w-[190px] [@media(height<=700px)]:py-[20px]"
  >
    <div
      class="brand gap-[10px] px-[8px] py-0 flex items-center [@media(height<=700px)]:mb-[24px]"
    >
      <img class="w-[36px] h-[48px] object-contain" src={logo} alt="" />
      <div>
        <strong class="text-[29px] tracking-[-1px] block">Wisp</strong><span
          class="block text-[#798f96] tracking-[1.5px] text-[9px] whitespace-nowrap mt-[4px]"
          >AI COMPANION</span
        >
      </div>
    </div>
    <p
      class="tagline px-[12px] py-0 mx-0 text-muted text-[12px] mt-[22px] mb-[30px] [@media(height<=700px)]:hidden"
    >
      A little help in Azeroth.
    </p>
    <nav
      class="gap-[4px] flex flex-col [@media(height<=700px)]:gap-[2px]"
      aria-label="Main navigation"
    >
      <span
        class="nav-label px-[14px] pt-0 pb-[9px] text-muted text-[11px] tracking-[1px] uppercase"
        >Workspace</span
      >
      {#each app.pages.filter((item) => !["Settings", "Diagnostics"].includes(item.name)) as item}<button
          class={navigationButton({
            selected: app.page === item.name,
          })}
          onclick={() => {
            app.page = item.name;
            if (app.page === "Diagnostics") void app.showLogs();
          }}
          aria-current={app.page === item.name ? "page" : undefined}
          ><Icon name={item.icon} />{item.name}</button
        >{/each}
    </nav>
    <nav
      class="utility-nav gap-[4px] flex flex-col mt-auto pt-[28px] [@media(height<=700px)]:gap-[2px] [@media(height<=700px)]:pt-[16px]"
      aria-label="App settings"
    >
      <span
        class="nav-label px-[14px] pt-0 pb-[9px] text-muted text-[11px] tracking-[1px] uppercase"
        >Application</span
      >
      {#each app.pages.filter( (item) => ["Settings", "Diagnostics"].includes(item.name) ) as item}
        <button
          class={navigationButton({
            selected: app.page === item.name,
          })}
          aria-current={app.page === item.name ? "page" : undefined}
          onclick={() => {
            app.page = item.name;
            if (item.name === "Diagnostics") void app.showLogs();
          }}
        >
          <Icon name={item.icon} />{item.name}
        </button>
      {/each}
    </nav>
    <div
      class="rail-footer gap-[7px] px-[12px] mt-[18px] pt-[18px] pb-0 text-[#769099] tracking-[0.8px] text-[12px] flex items-center flex-wrap [@media(height<=700px)]:mt-[12px] [@media(height<=700px)]:pt-[12px]"
    >
      <span>Wisp AI</span><span class="version ml-auto tracking-[0]"
        >v{app.info?.version || "0.0.7"}</span
      >
    </div>
  </aside>
  <main
    class="px-[32px] ml-[210px] pt-[34px] pb-[80px] min-w-[0] w-[calc(100%_-_210px)] max-w-[1450px] max-lg:px-[24px] max-lg:pt-[27px] max-md:px-[22px] max-md:ml-[190px] max-md:pt-[26px] max-md:w-[calc(100%_-_190px)]"
  >
    <header
      class="page-header gap-[18px] mb-[28px] flex flex-wrap items-start justify-between max-lg:gap-[12px]"
    >
      <div>
        <h1>{app.current.title}</h1>
        <p class="text-muted text-[13px]">
          {app.current.caption}
        </p>
      </div>
    </header>
    {#if !native}<div
        class="banner gap-[12px] border border-solid border-[#355c56] px-[16px] py-[12px] flex items-center rounded-[9px] [background:#1c3330] text-[#b7e8db] mb-[20px] text-[12px] leading-[1.5] [&_.icon-button]:ml-auto"
      >
        Design preview. Desktop actions are available in the installed Wisp app.
      </div>{/if}

    <Updates
      showSettings={app.page === "Settings"}
      version={app.info?.version || "0.0.7"}
      locked={!!app.busy}
      openSettings={() => (app.page = "Settings")}
      onBusy={(label) => (app.busy = label)}
    />
    {#if app.page === "Overview"}<Overview {app} />
    {:else if app.page === "Connections"}<Connections {app} />
    {:else if app.page === "Integrations"}<Integrations {app} />
    {:else if app.page === "Memory"}<Memory {app} />
    {:else if app.page === "Panels"}<Panels {app} />
    {:else if app.page === "Routines"}<Routines {app} />
    {:else if app.page === "Diagnostics"}<Diagnostics {app} />
    {/if}
    <footer
      class="app-footer gap-[12px] px-[2px] flex justify-between text-muted text-[12px] pt-[18px] pb-0 mt-[8px]"
    >
      <span>Wisp stays available in your system tray.</span><span
        >History saved locally.</span
      >
    </footer>
  </main>
</div>
{#if app.feedback && !app.busy}<div
    class="notification gap-[12px] border border-solid border-[#40695e] px-[15px] py-[13px] fixed right-[24px] bottom-[22px] z-[30] flex items-center w-[max-content] max-w-[min(580px,_calc(100vw_-_258px))] rounded-[12px] [background:#20352f] text-[#d5eee4] [box-shadow:0_8px_32px_#0005] text-[13px] leading-[1.5] [&_>_svg]:shrink-0 [&.error]:border-[#89564c] [&.error]:[background:#382824] [&.error]:text-[#ffd2c8]"
    class:error={app.failed}
    role="status"
    aria-live="polite"
  >
    <Icon name={app.failed ? "logs" : "check"} size={18} /><span
      class="[overflow-wrap:anywhere]">{app.feedback}</span
    >
    <button
      class={button({
        intent: "quiet",
        size: "icon",
        class: "icon-button p-[6px] min-h-[30px] shrink-0",
      })}
      aria-label="Dismiss notification"
      onclick={() => (app.feedback = "")}
      ><Icon name="close" size={16} /></button
    >
  </div>{/if}
{#if app.dialog}<McpDialog
    server={app.editing}
    close={() => (app.dialog = false)}
    saved={app.refresh}
  />{/if}
{#if app.confirm}<div
    class="scrim p-[25px] fixed top-[0] right-[0] bottom-[0] left-[0] [background:#050c10b8] [backdrop-filter:blur(5px)] grid [place-items:center] z-[20]"
  >
    <div
      class="dialog confirmation border border-solid border-[#3c535b] p-[27px] w-[min(600px,_100%)] max-h-[90vh] overflow-auto [background:#1c252b] rounded-[16px] [box-shadow:0_25px_100px_#0009] max-w-[460px]"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      tabindex="-1"
    >
      <h2 class="leading-[1.6] text-[17px]" id="confirm-title">
        {app.confirm.label}
      </h2>
      <footer class="gap-[12px] flex justify-end mt-[22px]">
        <button class={button({})} onclick={() => (app.confirm = null)}
          >Cancel</button
        ><button
          class={button({
            intent: "danger",
            class: "danger-button [background:#713e3a] text-[#ffe8e3]",
          })}
          onclick={async () => {
            const action = app.confirm!.run;
            app.confirm = null;
            await action();
          }}>Confirm</button
        >
      </footer>
    </div>
  </div>{/if}
