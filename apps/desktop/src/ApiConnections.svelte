<script lang="ts">
  import Button from "./ui/Button.svelte";
  import Card from "./ui/Card.svelte";
  import Input from "./ui/Input.svelte";
  import Select from "./ui/Select.svelte";

  import {
    providerDefinitions,
    type ProviderId,
    type ConnectionView,
    type ConnectionModel,
  } from "@wisp/protocol/providers";
  import type { DesktopController } from "./desktop-controller.svelte";
  import { request } from "./api";
  import ActionProgress from "./ActionProgress.svelte";
  let { app }: { app: DesktopController } = $props();
  let editing = $state(false);
  let id = $state<string | undefined>();
  let provider = $state<ProviderId>("anthropic");
  let name = $state("");
  let apiKey = $state("");
  let baseURL = $state("");
  let models = $state<ConnectionModel[]>([]);
  let discovered = $state<ConnectionModel[]>([]);
  let modelId = $state("");
  let contextWindow = $state<number | undefined>();
  let definition = $derived(
    providerDefinitions.find((p) => p.id === provider)!,
  );
  function open(connection?: ConnectionView) {
    id = connection?.id;
    provider = connection?.provider || "anthropic";
    name = connection?.name || "";
    apiKey = "";
    baseURL = connection?.baseURL || "";
    models = connection?.models.map((m) => ({ ...m })) || [];
    discovered = [];
    modelId = "";
    contextWindow = undefined;
    editing = true;
  }
  function addModel() {
    const value = modelId.trim();
    if (!value || models.some((m) => m.id === value)) {
      return;
    }
    const found = discovered.find((m) => m.id === value);
    models = [
      ...models,
      {
        ...found,
        id: value,
        contextWindow: contextWindow || found?.contextWindow,
      },
    ];
    modelId = "";
    contextWindow = undefined;
  }
  function setup() {
    return {
      id,
      provider,
      name: name.trim() || definition.name,
      apiKey: apiKey || undefined,
      baseURL: baseURL.trim() || undefined,
      models,
    };
  }
  async function save() {
    await request("/connections/save", setup());
    apiKey = "";
    editing = false;
    await app.loadModels();
  }
</script>

<Card kind="provider">
  <div
    class="section-title gap-[18px] flex items-center justify-between [&_>_svg]:text-muted"
  >
    <div>
      <h2>API connections</h2>
      <p class="text-muted text-[13px]">
        Use your own API key. Usage is billed by the selected provider.
      </p>
    </div>
    <Button
      disabled={app.locked || !app.status || editing}
      onclick={() => open()}>Add connection</Button
    >
  </div>
  {#each app.status?.connections || [] as connection (connection.id)}
    <div
      class="api-connection-row gap-[16px] px-0 py-[16px] flex items-center justify-between border-b-[1px] [border-bottom-style:solid] border-b-[var(--border)] max-sm:items-start max-sm:flex-col"
    >
      <div>
        <strong>{connection.name}</strong>
        <p class="muted text-muted text-[13px]">
          {providerDefinitions.find((p) => p.id === connection.provider)?.name} ·
          {connection.models.length} model{connection.models.length === 1
            ? ""
            : "s"} · {connection.hasKey
            ? "Key saved"
            : connection.provider === "compatible"
              ? "Local / no key"
              : "Key missing"}
        </p>
      </div>
      <div class="actions gap-[10px] mt-[22px] flex flex-wrap items-center">
        <Button
          disabled={app.locked || editing}
          onclick={() => open(connection)}>Edit</Button
        >
        <Button
          intent="quiet"
          destructive
          disabled={app.locked || editing}
          onclick={() => {
            app.confirm = {
              label: `Remove “${connection.name}”? Chats and memory stay on this computer. Chats using this connection will need another model.`,
              run: () =>
                app.work(
                  "Removing AI connection",
                  async () => {
                    await request("/connections/remove", { id: connection.id });
                    await app.loadModels();
                  },
                  "Connection removed.",
                  "connections",
                ),
            };
          }}>Remove</Button
        >
      </div>
    </div>
  {/each}
  <ActionProgress {app} target="connections" />
  {#if editing}
    <div
      class="field-section api-connection-form gap-[12px] border-t-[1px] [border-top-style:solid] border-t-[var(--border)] mt-[26px] pt-[22px] grid"
    >
      <label class="text-[12px] font-medium text-[#bdcccf]" for="ai-provider"
        >Provider</label
      >
      <Select
        id="ai-provider"
        bind:value={provider}
        disabled={app.locked || !!id}
        onchange={() => {
          models = [];
          discovered = [];
          modelId = "";
          baseURL = "";
          apiKey = "";
        }}
      >
        {#each providerDefinitions as item}<option value={item.id}
            >{item.name}</option
          >{/each}
      </Select>
      <label class="text-[12px] font-medium text-[#bdcccf]" for="ai-name"
        >Connection name</label
      >
      <Input
        id="ai-name"
        bind:value={name}
        placeholder={definition.name}
        maxlength={80}
        disabled={app.locked}
      />
      <label class="text-[12px] font-medium text-[#bdcccf]" for="ai-key"
        >API key {id
          ? "(leave blank to keep saved key)"
          : provider === "compatible"
            ? "(optional for local servers)"
            : ""}</label
      >
      <Input
        id="ai-key"
        type="password"
        bind:value={apiKey}
        autocomplete="off"
        spellcheck="false"
        disabled={app.locked}
      />
      {#if provider === "compatible"}
        <label class="text-[12px] font-medium text-[#bdcccf]" for="ai-url"
          >Base URL</label
        >
        <Input
          id="ai-url"
          bind:value={baseURL}
          placeholder="http://localhost:1234/v1"
          disabled={app.locked}
        />
      {:else}
        <details>
          <summary class="cursor-pointer text-muted text-[13px]"
            >Custom endpoint</summary
          >
          <label for="ai-url">Base URL</label><Input
            class="mt-[8px]"
            id="ai-url"
            bind:value={baseURL}
            placeholder={definition.baseURL}
            disabled={app.locked}
          />
        </details>
      {/if}
      <div class="label-row flex items-center justify-between">
        <label class="text-[12px] font-medium text-[#bdcccf]" for="ai-model"
          >Models available in Wisp</label
        >
        <Button
          intent="quiet"
          size="text"
          disabled={app.locked || (provider === "compatible" && !baseURL)}
          onclick={() =>
            app.work(
              "Loading provider models",
              async () => {
                const { models: _models, ...input } = setup();
                discovered = (
                  await request<{ models: ConnectionModel[] }>(
                    "/connections/discover",
                    input,
                  )
                ).models;
              },
              "Models loaded. Choose models to add below.",
              "connection-editor",
            )}>Load model list</Button
        >
      </div>
      <p class="field-hint text-[11px]! text-muted mt-[12px]">
        Choose a model with tool calling. You can enter its exact ID if the
        provider cannot list models.
      </p>
      <div
        class="api-model-fields gap-[10px] grid grid-cols-[minmax(0,_1fr)_minmax(160px,_0.7fr)_auto] items-center max-sm:grid-cols-[1fr]"
      >
        <Input
          id="ai-model"
          bind:value={modelId}
          list="ai-model-options"
          placeholder={definition.example}
          disabled={app.locked}
        />
        <datalist id="ai-model-options"
          >{#each discovered as model}<option value={model.id}
              >{model.name || model.id}</option
            >{/each}</datalist
        >
        <Input
          aria-label="Context window in tokens"
          type="number"
          min="1"
          max="100000000"
          bind:value={contextWindow}
          placeholder="Context tokens"
          disabled={app.locked}
        />
        <Button disabled={app.locked || !modelId.trim()} onclick={addModel}
          >Add model</Button
        >
      </div>
      {#each models as model, index (model.id)}
        <div
          class="api-model-fields gap-[10px] grid grid-cols-[minmax(0,_1fr)_minmax(160px,_0.7fr)_auto] items-center max-sm:grid-cols-[1fr]"
        >
          <span class="[overflow-wrap:anywhere]">{model.id}</span>
          <Input
            aria-label={`Context window for ${model.id}`}
            type="number"
            min="1"
            max="100000000"
            bind:value={models[index]!.contextWindow}
            placeholder="Context tokens (required)"
            disabled={app.locked}
          />
          <Button
            intent="quiet"
            disabled={app.locked}
            aria-label={`Remove ${model.id}`}
            onclick={() => {
              models = models.filter((m) => m.id !== model.id);
            }}>Remove</Button
          >
        </div>
      {/each}
      <p class="field-hint text-[11px]! text-muted mt-[12px]">
        Set the context window for every model so Wisp can manage long
        conversations. For local models, use the tokens your server allocates.
        Choose reasoning per chat in game when the model supports it. Default
        keeps the provider's setting; higher effort can use more time and
        tokens.
      </p>
      <div class="actions gap-[10px] mt-[22px] flex flex-wrap items-center">
        <Button
          disabled={app.locked || !models.length}
          onclick={() =>
            app.work(
              "Testing AI connection",
              () => request("/connections/test", setup()),
              "Connection and tool calling verified for the first model.",
              "connection-editor",
            )}>Test first model</Button
        >
        <Button
          intent="primary"
          disabled={app.locked ||
            !models.length ||
            !!modelId.trim() ||
            models.some((m) => !m.contextWindow)}
          onclick={() =>
            app.work(
              "Saving AI connection",
              save,
              "Connection saved. Choose a default model below.",
              "connection-editor",
            )}>Save connection</Button
        >
        <Button
          intent="quiet"
          disabled={app.locked}
          onclick={() => {
            apiKey = "";
            editing = false;
          }}>Cancel</Button
        >
      </div>
      <p class="field-hint text-[11px]! text-muted mt-[12px]">
        Testing sends a small request to the provider and may incur usage
        charges.
      </p>
      <ActionProgress {app} target="connection-editor" />
    </div>
  {/if}
  <p
    class="privacy-note gap-[7px] text-[11px]! flex items-center mt-[25px] text-[#789c91]!"
  >
    API keys are protected by your operating system. Configure Exa under Web
    search to use web search with API models. Game tools and other enabled
    databases work independently of the search service.
  </p>
</Card>
