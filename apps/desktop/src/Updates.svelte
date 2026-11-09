<script lang="ts">
  import { onMount } from "svelte";
  import { listen } from "@tauri-apps/api/event";
  import { desktop, native } from "./api";

  let {
    showSettings,
    version,
    locked,
    openSettings,
    onBusy,
  }: {
    showSettings: boolean;
    version: string;
    locked: boolean;
    openSettings: () => void;
    onBusy: (label: string) => void;
  } = $props();
  type Release = { version: string; notes: string | null };
  type Progress = {
    phase: "downloading" | "waiting" | "installing";
    downloaded?: number;
    total?: number;
  };
  let release = $state<Release | null>(null);
  let checking = $state(false);
  let installing = $state(false);
  let supported = $state(native);
  let message = $state("");
  let error = $state("");
  let dismissed = $state("");
  let lastChecked = $state("");
  let progress = $state("Preparing update…");

  async function check() {
    if (!native || checking || installing) {
      return;
    }
    checking = true;
    error = "";
    try {
      const result = await desktop<{
        supported: boolean;
        update: Release | null;
      }>("check_update");
      supported = result.supported;
      release = result.update;
      lastChecked = new Date().toLocaleString();
      message = !supported
        ? "Updates are available in the installed Windows x64 release."
        : release
          ? `Version ${release.version} is available.`
          : "You’re up to date.";
    } catch {
      error =
        "Could not check for updates. Check your connection and try again. Public releases may not be available yet.";
    } finally {
      checking = false;
    }
  }
  async function install() {
    if (!release || installing || locked) {
      return;
    }
    installing = true;
    error = "";
    progress = "Downloading update…";
    onBusy("Updating Wisp");
    try {
      await desktop("install_update");
    } catch (e) {
      error = `Update failed: ${String(e).replace(/^Error: /, "")} You can try again.`;
    } finally {
      installing = false;
      onBusy("");
    }
  }
  onMount(() => {
    if (!native) {
      return;
    }
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void listen<Progress>("update-progress", ({ payload }) => {
      if (!installing) {
        return;
      }
      if (payload.phase === "waiting") {
        progress = "Waiting for the active reply to finish…";
      } else if (payload.phase === "installing") {
        progress =
          "Opening the Windows updater. Wisp will close and reopen automatically…";
      } else {
        progress = payload.total
          ? `Downloading update… ${Math.min(100, Math.round(((payload.downloaded || 0) / payload.total) * 100))}%`
          : "Downloading update…";
      }
    })
      .then((stop) => {
        if (disposed) {
          stop();
        } else {
          unsubscribe = stop;
        }
      })
      .catch(() => {
        error = "Update progress is unavailable. Restart Wisp to try again.";
      });
    void check();
    const timer = setInterval(
      () => {
        void check();
      },
      6 * 60 * 60 * 1000,
    );
    return () => {
      disposed = true;
      clearInterval(timer);
      unsubscribe?.();
    };
  });
</script>

{#if release && dismissed !== release.version && !showSettings}
  <div class="banner" role="status">
    <span>Wisp {release.version} is available.</span>
    <button onclick={openSettings}>View update</button>
    <button class="quiet" onclick={() => (dismissed = release!.version)}
      >Later</button
    >
  </div>
{/if}
{#if showSettings}
  <section class="card">
    <div class="section-title">
      <div>
        <h2>App updates</h2>
        <p>Installed version: {version}</p>
      </div>
      <button
        onclick={check}
        disabled={!native || checking || installing || locked}
      >
        {checking ? "Checking…" : "Check for updates"}
      </button>
    </div>
    <p class="field-hint">
      Wisp checks automatically at startup and every six hours. You choose when
      to install.
    </p>
    {#if lastChecked}<p class="field-hint">Last checked: {lastChecked}</p>{/if}
    <p role="status">{installing ? progress : message}</p>
    {#if error}<p class="banner error" role="alert">{error}</p>{/if}
    {#if release}
      <h3>Wisp {release.version}</h3>
      <pre class="release-notes">{release.notes ||
          "This release has no notes."}</pre>
      <div class="actions">
        <button
          class="primary"
          onclick={install}
          disabled={!supported || installing || checking || locked}
        >
          {installing ? "Updating…" : "Update and restart"}
        </button>
      </div>
      <p class="field-hint">
        Wisp downloads and verifies the update, waits for any active reply, then
        opens the Windows updater. Wisp closes during installation and reopens
        automatically when it is ready. Your chats and settings are kept. Use
        Install / update addon in Overview after updating, then /reload in WoW.
      </p>
    {/if}
  </section>
{/if}

<style>
  .release-notes {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font: inherit;
    color: var(--muted);
    max-height: 280px;
    overflow-y: auto;
  }
</style>
