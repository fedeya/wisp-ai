<script lang="ts">
  import Badge from "./ui/Badge.svelte";
  import Button from "./ui/Button.svelte";
  import Card from "./ui/Card.svelte";
  import Input from "./ui/Input.svelte";
  import Select from "./ui/Select.svelte";

  import type { DesktopController } from "./desktop-controller.svelte";
  import { desktop, request } from "./api";
  import ActionProgress from "./ActionProgress.svelte";
  let { app }: { app: DesktopController } = $props();
  let provider = $state<"auto" | "exa" | "chatgpt" | "disabled">("auto");
  let apiKey = $state("");
  let dirty = $state(false);
  $effect(() => {
    if (!dirty && app.status?.search) {
      provider = app.status.search.provider;
    }
  });
  function setup() {
    return { provider, apiKey: apiKey.trim() || undefined };
  }
  async function save() {
    await request("/search/save", setup());
    apiKey = "";
    await app.refresh();
    dirty = false;
  }
</script>

<Card kind="provider">
  <div
    class="section-title gap-[18px] flex items-center justify-between [&_>_svg]:text-muted"
  >
    <div>
      <h2>Web search</h2>
      <p class="text-muted text-[13px]">
        Search globally across the public web, independently of your chat model.
      </p>
    </div>
    <Badge positive={app.status?.search?.hasExaKey}
      >{app.status?.search?.hasExaKey
        ? "Exa key saved"
        : "Exa public · no key needed"}</Badge
    >
  </div>
  <div
    class="search-form field-section gap-[12px] border-t-[1px] [border-top-style:solid] border-t-[var(--border)] mt-[26px] pt-[22px] grid"
  >
    <label class="text-[12px] font-medium text-[#bdcccf]" for="search-provider"
      >Search service</label
    >
    <Select
      id="search-provider"
      bind:value={provider}
      disabled={app.locked || !app.status}
      onchange={() => {
        dirty = true;
      }}
    >
      <option value="auto"
        >Auto — ChatGPT for subscription chats, Exa for API chats</option
      >
      <option value="exa">Exa for all chats</option>
      <option value="chatgpt">ChatGPT search only</option>
      <option value="disabled">Disabled</option>
    </Select>
    <label class="text-[12px] font-medium text-[#bdcccf]" for="exa-key"
      >Exa API key (optional) {app.status?.search?.hasExaKey
        ? "(leave blank to keep saved key)"
        : ""}</label
    >
    <Input
      id="exa-key"
      type="password"
      bind:value={apiKey}
      autocomplete="off"
      spellcheck="false"
      maxlength={4096}
      disabled={app.locked || !app.status}
    />
    <p class="field-hint text-[11px]! text-muted mt-[12px]">
      Exa works without a key through its public MCP service, with free rate
      limits. Searches cover the public web and return source links and
      excerpts. An optional key uses your Exa account and stays protected by the
      operating system.
    </p>
    <p class="field-hint text-[11px]! text-muted mt-[12px]">
      A saved key uses your account credits and may incur Exa charges. Testing
      sends one search request using the saved or entered key, or public access.
    </p>
    <div class="actions gap-[10px] mt-[22px] flex flex-wrap items-center">
      <Button
        intent="quiet"
        disabled={!!app.busy}
        onclick={() =>
          app.work(
            "Opening Exa dashboard",
            () => desktop("open_exa_dashboard"),
            "An API key is optional; public search works without one.",
            "search",
          )}>Get Exa key</Button
      >
      <Button
        disabled={app.locked || !app.status}
        onclick={() =>
          app.work(
            "Testing Exa",
            () => request("/search/test", setup()),
            "Exa accepted the test search. Results depend on source coverage.",
            "search",
          )}>Test Exa</Button
      >
      <Button
        intent="primary"
        disabled={app.locked || !app.status}
        onclick={() =>
          app.work(
            "Saving search settings",
            save,
            "Search settings saved.",
            "search",
          )}>Save search settings</Button
      >
      {#if app.status?.search?.hasExaKey}<Button
          intent="quiet"
          destructive
          disabled={app.locked}
          onclick={() => {
            app.confirm = {
              label:
                "Remove the saved Exa API key? Searches will use public Exa access and its free rate limits.",
              run: () =>
                app.work(
                  "Removing Exa key",
                  () => request("/search/remove-exa", {}),
                  "Exa key removed.",
                  "search",
                ),
            };
          }}>Remove Exa key</Button
        >{/if}
    </div>
    <ActionProgress {app} target="search" />
  </div>
</Card>
