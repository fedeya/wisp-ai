<script lang="ts">
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

<div class="app-shell">
  <aside>
    <div class="brand">
      <img src={logo} alt="" />
      <div><strong>Wisp</strong><span>AI COMPANION</span></div>
    </div>
    <p class="tagline">A little help in Azeroth.</p>
    <nav aria-label="Main navigation">
      <span class="nav-label">Workspace</span>
      {#each app.pages.filter((item) => !["Settings", "Diagnostics"].includes(item.name)) as item}<button
          class:selected={app.page === item.name}
          onclick={() => {
            app.page = item.name;
            if (app.page === "Diagnostics") void app.showLogs();
          }}
          aria-current={app.page === item.name ? "page" : undefined}
          ><Icon name={item.icon} />{item.name}</button
        >{/each}
    </nav>
    <nav class="utility-nav" aria-label="App settings">
      <span class="nav-label">Application</span>
      {#each app.pages.filter( (item) => ["Settings", "Diagnostics"].includes(item.name) ) as item}
        <button
          class:selected={app.page === item.name}
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
    <div class="rail-footer">
      <span>Wisp AI</span><span class="version"
        >v{app.info?.version || "0.0.7"}</span
      >
    </div>
  </aside>
  <main>
    <header class="page-header">
      <div>
        <h1>{app.current.title}</h1>
        <p>{app.current.caption}</p>
      </div>
    </header>
    {#if !native}<div class="banner">
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
    <footer class="app-footer">
      <span>Wisp stays available in your system tray.</span><span
        >History saved locally.</span
      >
    </footer>
  </main>
</div>
{#if app.feedback && !app.busy}<div
    class="notification"
    class:error={app.failed}
    role="status"
    aria-live="polite"
  >
    <Icon name={app.failed ? "logs" : "check"} size={18} /><span
      >{app.feedback}</span
    >
    <button
      class="icon-button"
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
{#if app.confirm}<div class="scrim">
    <div
      class="dialog confirmation"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      tabindex="-1"
    >
      <h2 id="confirm-title">{app.confirm.label}</h2>
      <footer>
        <button onclick={() => (app.confirm = null)}>Cancel</button><button
          class="danger-button"
          onclick={async () => {
            const action = app.confirm!.run;
            app.confirm = null;
            await action();
          }}>Confirm</button
        >
      </footer>
    </div>
  </div>{/if}
