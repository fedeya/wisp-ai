<script lang="ts">
  import Button from "./ui/Button.svelte";
  import Card from "./ui/Card.svelte";
  import Select from "./ui/Select.svelte";
  import { onMount } from "svelte";
  import { listen } from "@tauri-apps/api/event";
  import { desktop, native } from "./api";
  import { renderReleaseNotes } from "@wisp/releases";

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
  let channel = $state("stable");
  let channelLoaded = $state(!native);
  let changingChannel = $state(false);
  async function changeChannel(event: Event) {
    const next = (event.target as HTMLSelectElement).value;
    changingChannel = true;
    release = null;
    dismissed = "";
    try {
      channel = await desktop<string>("update_channel", { channel: next });
      await check();
    } catch (e) {
      (event.target as HTMLSelectElement).value = channel;
      error = `Could not change update channel: ${String(e)}`;
    } finally {
      changingChannel = false;
    }
  }

  async function check() {
    if (!native || !channelLoaded || checking || installing) {
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
    void desktop<string>("update_channel")
      .then((saved) => {
        if (disposed) {
          return;
        }
        channel = saved;
        channelLoaded = true;
        return check();
      })
      .catch(() => {
        if (disposed) {
          return;
        }
        error = "Could not load the update channel. Restart Wisp to try again.";
      });
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
  <div
    class="banner mb-5 flex items-center gap-3 rounded-[9px] border border-solid border-[#355c56] bg-[#1c3330] px-4 py-3 text-xs leading-[1.5] text-[#b7e8db]"
    role="status"
  >
    <span>Wisp {release.version} is available.</span>
    <Button onclick={openSettings}>View update</Button>
    <Button intent="quiet" onclick={() => (dismissed = release!.version)}
      >Later</Button
    >
  </div>
{/if}
{#if showSettings}
  <Card>
    <div class="section-title flex items-center justify-between gap-[18px]">
      <div>
        <h2>App updates</h2>
        <p class="text-[13px] text-muted">Installed version: {version}</p>
      </div>
      <Button
        onclick={check}
        disabled={!native || !channelLoaded || checking || installing || locked}
      >
        {checking ? "Checking…" : "Check for updates"}
      </Button>
    </div>
    <p class="field-hint mt-3 text-[11px]! text-muted">
      Wisp checks automatically at startup and every six hours. You choose when
      to install.
    </p>
    <label class="mt-3 flex items-center text-[13px] text-muted">
      Update channel
      <Select
        class="ml-3 w-auto"
        value={channel}
        onchange={changeChannel}
        disabled={!native ||
          !channelLoaded ||
          checking ||
          installing ||
          changingChannel ||
          locked}
      >
        <option value="stable">Stable</option>
        <option value="nightly">Nightly</option>
      </Select>
    </label>
    {#if channel === "nightly"}
      <p class="field-hint mt-3 text-[11px]! text-muted">
        Experimental builds from main. Features may change or break.
      </p>
    {:else if version.includes("-nightly.")}
      <p class="field-hint mt-3 text-[11px]! text-muted">
        Returning to Stable can install an older version. Your chats and
        settings are kept.
      </p>
    {/if}
    <p class="mt-3 text-[13px] text-accent">
      <a
        href={`https://wisp.fedeya.sh/changelog${channel === "nightly" ? "?channel=nightly" : ""}`}
        target="_blank"
        rel="noreferrer">View all updates ↗</a
      >
    </p>
    {#if lastChecked}<p class="field-hint mt-3 text-[11px]! text-muted">
        Last checked: {lastChecked}
      </p>{/if}
    <p class="text-[13px] text-muted" role="status">
      {installing ? progress : message}
    </p>
    {#if error}<p
        class="banner error mb-5 flex items-center gap-3 rounded-[9px] border border-solid border-[#70473f] bg-[#332522] px-4 py-3 text-[13px] leading-[1.5] text-[#f0b4aa]"
        role="alert"
      >
        {error}
      </p>{/if}
    {#if release}
      <h3>Wisp {release.version}</h3>
      <div
        class="release-notes max-h-[280px] overflow-y-auto text-muted [overflow-wrap:anywhere] [&_img]:max-w-full [&_img]:rounded-lg [&_h1]:text-[1.35rem] [&_h2]:mt-5 [&_h2]:text-[1.1rem] [&_a]:text-accent"
      >
        {@html renderReleaseNotes(
          release.notes || "This release has no notes.",
        )}
      </div>
      <div class="actions mt-[22px] flex flex-wrap items-center gap-[10px]">
        <Button
          intent="primary"
          onclick={install}
          disabled={!supported || installing || checking || locked}
        >
          {installing ? "Updating…" : "Update and restart"}
        </Button>
      </div>
      <p class="field-hint mt-3 text-[11px]! text-muted">
        Wisp downloads and verifies the update, waits for any active reply, then
        opens the Windows updater. Wisp closes during installation and reopens
        automatically when it is ready. Your chats and settings are kept. Use
        Install / update addon in Overview after updating, then /reload in WoW.
      </p>
    {/if}
  </Card>
{/if}
