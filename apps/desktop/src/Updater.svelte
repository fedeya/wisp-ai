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

<main class:failed>
  <header data-tauri-drag-region>Wisp AI</header>
  <section class="hero" aria-live="polite">
    <div class="logo"><img src={logo} alt="" /></div>
    <div>
      <h1>{failed ? "Couldn't update Wisp" : "Updating Wisp"}</h1>
      <p>
        {failed ? (update.error ?? status) : "Wisp will reopen automatically."}
      </p>
    </div>
  </section>

  {#if failed}
    <section class="diagnostics">
      <h2>Installation log</h2>
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (Allow keyboard scrolling in the log.) -->
      <pre
        bind:this={logPanel}
        tabindex="0"
        aria-label="Installation log">{update.log.join("\n")}</pre>
    </section>
    <footer>
      <button bind:this={closeButton} onclick={() => invoke("updater_close")}
        >Close</button
      >
    </footer>
  {:else}
    <section class="progress">
      <div class="progress-label">
        <span>{status}</span>
        {#if update.percent !== null}<strong>{update.percent}%</strong>{/if}
      </div>
      <progress
        max={100}
        value={update.percent ?? undefined}
        aria-label={status}
      ></progress>
    </section>
  {/if}
</main>

<style>
  main {
    min-height: 100dvh;
    padding: 15px 25px 24px;
    border: 1px solid #2e393e;
    background:
      radial-gradient(ellipse at 15% 0%, #243a38 0%, transparent 58%), #14191d;
  }

  header {
    height: 30px;
    color: var(--muted);
    font-size: 12px;
    font-weight: 600;
    user-select: none;
  }

  .hero {
    display: flex;
    align-items: center;
    gap: 17px;
    min-height: 92px;
    margin: 10px 0 25px;
  }

  .logo {
    display: grid;
    flex: 0 0 68px;
    width: 68px;
    height: 68px;
    place-items: center;
    border: 1px solid #45625c;
    border-radius: 18px;
    background: #1b2c2a;
  }

  .logo img {
    width: 57px;
    height: 57px;
    object-fit: contain;
  }

  h1 {
    margin: 0;
    font-size: 25px;
    letter-spacing: -0.7px;
  }

  p {
    margin: 5px 0 0;
    color: var(--muted);
    font-size: 13px;
    overflow-wrap: anywhere;
  }

  .progress {
    padding: 15px 16px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: #1c2328;
  }

  .progress-label {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 10px;
    color: #c5d3d1;
    font-size: 13px;
  }

  strong {
    color: var(--accent);
    font-variant-numeric: tabular-nums;
  }

  progress {
    display: block;
    width: 100%;
    height: 6px;
    appearance: none;
    border-radius: 10px;
    accent-color: var(--accent);
  }

  progress::-webkit-progress-bar {
    border-radius: 10px;
    background: #344146;
  }

  progress::-webkit-progress-value {
    border-radius: 10px;
    background: var(--accent);
  }

  .failed .hero {
    margin-bottom: 15px;
  }

  .failed .hero p {
    color: #e8aca5;
  }

  .diagnostics {
    border: 1px solid var(--border);
    border-radius: 12px;
    background: #11171a;
    overflow: hidden;
  }

  .diagnostics h2 {
    padding: 10px 12px;
    border-bottom: 1px solid #2a3438;
    color: #c5d3d1;
    font-size: 12px;
  }

  pre {
    min-height: 72px;
    max-height: 113px;
    margin: 0;
    padding: 10px 12px;
    overflow: auto;
    color: #adbcbf;
    font:
      11px/1.6 Consolas,
      monospace;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  footer {
    display: flex;
    justify-content: flex-end;
    margin-top: 17px;
  }

  button {
    min-width: 92px;
    padding: 8px 17px;
    border: 1px solid #518178;
    border-radius: 8px;
    background: #29443f;
    color: #dcf3ed;
    font-weight: 600;
    cursor: pointer;
  }

  button:hover {
    background: #355951;
  }
  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }
</style>
