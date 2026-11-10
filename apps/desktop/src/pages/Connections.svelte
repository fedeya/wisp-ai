<script lang="ts">
  import Badge from "../ui/Badge.svelte";
  import Button from "../ui/Button.svelte";
  import Card from "../ui/Card.svelte";
  import Select from "../ui/Select.svelte";

  import type { DesktopController } from "../desktop-controller.svelte";
  import ApiConnections from "../ApiConnections.svelte";
  import SearchConnection from "../SearchConnection.svelte";
  import ActionProgress from "../ActionProgress.svelte";
  import Icon from "../Icon.svelte";
  import { request } from "../api";
  let { app }: { app: DesktopController } = $props();
  let chatgptConnected = $derived(app.status?.auth.status === "connected");
</script>

<Card kind="provider">
  <div class="provider-heading gap-[15px] flex items-center max-xl:flex-wrap">
    <div
      class="provider-symbol border border-solid border-[#36534d] [background:#243e3a] text-accent rounded-[11px] w-[47px] h-[47px] flex items-center justify-center shrink-0"
    >
      <Icon name="spark" size={25} />
    </div>
    <div>
      <h2>ChatGPT</h2>
      <p class="text-muted text-[13px]">
        Connect with your subscription. No API key needed.
      </p>
    </div>
    <Badge positive={chatgptConnected} class="ml-auto"
      >{chatgptConnected
        ? "Connected"
        : app.status?.auth.status === "authorizing"
          ? "Waiting for browser"
          : "Not connected"}</Badge
    >
  </div>
  {#if app.status?.auth.account}<p
      class="account-name text-[14px]! text-[#d1e3dd]! mt-[24px]"
    >
      {app.status.auth.account}
    </p>{/if}
  {#if app.status?.auth.message}<p class="muted text-muted text-[13px]">
      {app.status.auth.message}
    </p>{/if}
  {#if !app.status}<div
      class="empty-inline text-[12px] text-[#c0a77a] mt-[22px]"
    >
      Start Wisp to manage your account.
      <Button intent="quiet" size="text" onclick={() => (app.page = "Overview")}
        >Go to Overview</Button
      >
    </div>{/if}
  <div class="actions gap-[10px] mt-[22px] flex flex-wrap items-center">
    <ActionProgress {app} />
    <Button
      intent={chatgptConnected ? "default" : "primary"}
      onclick={() => app.signIn()}
      disabled={app.locked || !app.status}
      >{app.busy === "Opening sign-in"
        ? "Opening browser…"
        : chatgptConnected
          ? "Reconnect"
          : "Continue with ChatGPT"}<Icon name="arrow" size={17} /></Button
    ><Button
      onclick={() => app.signIn(true)}
      disabled={app.locked || !app.status}>Add account</Button
    >{#if app.status?.auth.status === "authorizing"}<Button
        onclick={() =>
          app.work("Cancelling sign-in", () => request("/auth/cancel", {}))}
        disabled={!!app.busy}>Cancel sign-in</Button
      >{/if}{#if chatgptConnected}<Button
        intent="quiet"
        destructive
        onclick={() => {
          app.confirm = {
            label:
              "Disconnect this AI connection? Your chats and memory will stay on this computer.",
            run: () =>
              app.work(
                "Disconnecting",
                () => request("/auth/disconnect", {}),
                "Connection disconnected.",
              ),
          };
        }}
        disabled={app.locked}>Disconnect</Button
      >{/if}
  </div>
  {#if (app.status?.auth.profiles.length || 0) > 0}<div
      class="field-section border-t-[1px] [border-top-style:solid] border-t-[var(--border)] mt-[26px] pt-[22px]"
    >
      <label class="text-[12px] font-medium text-[#bdcccf]" for="accounts"
        >Saved accounts</label
      >
      <div class="inline-field gap-[12px] mt-[10px] flex items-center">
        <Select
          class="flex-[1]"
          id="accounts"
          bind:value={app.account}
          disabled={app.locked}
          >{#each app.status?.auth.profiles || [] as item}<option
              value={item.id}>{item.label}</option
            >{/each}</Select
        ><Button
          onclick={() =>
            app.work(
              "Switching account",
              () => request("/auth/select", { profileId: app.account }),
              undefined,
              "accounts",
            )}
          disabled={app.locked || app.account === app.status?.auth.activeId}
          >Use account</Button
        >
      </div>
      <ActionProgress {app} target="accounts" />
    </div>{/if}
</Card>

<ApiConnections {app} />
<SearchConnection {app} />

<Card kind="provider">
  <h2>Default model</h2>
  <div
    class="field-section border-t-[1px] [border-top-style:solid] border-t-[var(--border)] mt-[26px] pt-[22px]"
  >
    {#if app.modelsError}<p
        class="banner error gap-[12px] border border-solid border-[#70473f] px-[16px] py-[12px] flex items-center rounded-[9px] [background:#332522] text-[#f0b4aa] mb-[20px] text-[13px] leading-[1.5] [&_.icon-button]:ml-auto"
        role="status"
      >
        Could not load models: {app.modelsError}
      </p>{/if}
    <div class="label-row flex items-center justify-between">
      <label class="text-[12px] font-medium text-[#bdcccf]" for="models"
        >Default model for new chats</label
      ><Button
        intent="quiet"
        size="text"
        onclick={() =>
          app.work(
            "Loading models",
            app.loadModels,
            "Models refreshed.",
            "model",
          )}
        disabled={app.locked || !app.status}
        ><Icon name="refresh" size={14} />Refresh</Button
      >
    </div>
    <div class="inline-field gap-[12px] mt-[10px] flex items-center">
      <Select
        class="flex-[1]"
        id="models"
        bind:value={app.model}
        disabled={app.locked || !app.models.length}
        ><option value="" disabled
          >{app.models.length
            ? "Loading available models…"
            : "Connect a provider first"}</option
        >{#each app.models as item}<option value={item.slug}
            >{item.displayName}</option
          >{/each}</Select
      ><Button
        onclick={() =>
          app.work(
            "Updating default model",
            () => request("/auth/model", { model: app.model }),
            "Default model updated.",
            "model",
          )}
        disabled={app.locked ||
          !app.models.length ||
          app.model === app.status?.model}
        >{app.busy === "Updating default model"
          ? "Saving…"
          : "Set default"}</Button
      >
    </div>
    <ActionProgress {app} target="model" />
    <p class="field-hint text-[11px]! text-muted mt-[12px]">
      You can choose a different model and effort inside each chat.
    </p>
  </div>
  <p
    class="privacy-note gap-[7px] text-[11px]! flex items-center mt-[25px] text-[#789c91]!"
  >
    <Icon name="check" size={16} />Credentials stay protected by your operating
    system.
  </p>
</Card>
