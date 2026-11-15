<script lang="ts">
  import Badge from "../ui/Badge.svelte";
  import Button from "../ui/Button.svelte";
  import Card from "../ui/Card.svelte";

  import DataState from "../DataState.svelte";
  import ActionProgress from "../ActionProgress.svelte";
  import type { DesktopController } from "../desktop-controller.svelte";
  import Icon from "../Icon.svelte";
  import {
    parseTemplate,
    passiveTemplate,
    TEMPLATE_BYTES,
    type PassiveTemplate,
  } from "@wisp/protocol/panel-template";
  import TemplatePreview from "../TemplatePreview.svelte";
  import Select from "../ui/Select.svelte";
  let mode = $state<"import" | "export" | null>(null);
  let raw = $state("");
  let preview = $state<PassiveTemplate | null>(null);
  let recipient = $state("");
  let confirmed = $state(false);
  let busy = $state(false);
  let error = $state("");
  let notice = $state("");
  const valid = $derived(
    preview !== null && passiveTemplate.safeParse(preview).success,
  );
  function cancel() {
    mode = null;
    raw = "";
    preview = null;
    recipient = "";
    confirmed = false;
    error = "";
  }
  async function exportPanel(
    panel: Parameters<DesktopController["exportPanelTemplate"]>[0],
  ) {
    cancel();
    busy = true;
    try {
      raw = await app.exportPanelTemplate(panel);
      preview = parseTemplate(raw);
      mode = "export";
    } catch (e) {
      error = `Cannot export this panel: ${String(e).replace(/^Error: /, "")}`;
    } finally {
      busy = false;
    }
  }
  function validate() {
    error = "";
    try {
      preview = parseTemplate(raw);
    } catch {
      preview = null;
      error =
        "Invalid or unsupported template. Use a version 1 Forever passive item tracker (up to three items, plain text only). Nothing was saved.";
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(raw);
      notice = "Template copied.";
    } catch {
      notice =
        "Clipboard unavailable. Select and copy the template text below manually.";
    }
  }
  async function save() {
    if (!preview || !valid || !recipient || !confirmed || busy || app.locked) {
      return;
    }
    busy = true;
    error = "";
    try {
      await app.importPanelTemplate(recipient, JSON.stringify(preview));
      cancel();
      notice =
        "New tracker saved for the chosen character. It was not opened in WoW.";
    } catch (e) {
      error = `Nothing imported: ${String(e).replace(/^Error: /, "")}`;
    } finally {
      busy = false;
    }
  }
  let { app }: { app: DesktopController } = $props();
</script>

{#if app.loading || !app.status}<DataState {app} />{:else}
  <div class="flex items-center justify-between gap-[16px] mb-[16px]">
    <p class="text-muted text-[13px]">
      Reuse up to three item goals. No AI. Live counts and ownership are not
      transferred.
    </p>
    <Button
      onclick={() => {
        cancel();
        mode = "import";
        notice = "";
      }}
      disabled={busy || app.locked}>Import template</Button
    >
  </div>
  {#if error}<p role="alert" class="text-[#e5a399] my-[12px]">{error}</p>{/if}
  {#if notice}<p role="status" class="text-accent my-[12px]">{notice}</p>{/if}
  {#if mode}
    <Card class="mb-[20px]">
      <h2>{mode === "import" ? "Import template" : "Export template"}</h2>
      <p class="text-[13px] text-muted my-[10px]">
        Remaining text may contain personal information. Review every title,
        label and note below before sharing or importing. Text is untrusted; no
        actions are allowed.
      </p>
      {#if !preview}
        <label class="grid gap-[8px]"
          >Paste template
          <textarea
            aria-label="Paste template"
            rows="5"
            class="w-full rounded-[8px] bg-[#182327] border border-[#3a4c4f] p-[12px]"
            value={raw}
            oninput={(e) => {
              const value = e.currentTarget.value;
              raw = value.length <= TEMPLATE_BYTES ? value : "";
              error =
                value.length > TEMPLATE_BYTES
                  ? "Template is too large. Nothing was saved."
                  : "";
            }}></textarea>
        </label>
        <Button onclick={validate} disabled={!raw || busy}
          >Preview template</Button
        >
      {:else}
        <TemplatePreview bind:template={preview} editable={mode === "import"} />
        {#if !valid}<p role="alert" class="text-[#e5a399] my-[12px]">
            Use a positive whole target for every item before creating a
            tracker.
          </p>{/if}
        {#if mode === "import"}
          <div class="grid gap-[12px]">
            <label
              >Recipient character
              <Select aria-label="Recipient character" bind:value={recipient}>
                <option value="">Choose a local character…</option>
                {#each app.status.panelRecipients || [] as character}<option
                    value={character.characterKey}>{character.label}</option
                  >{/each}
              </Select>
            </label>
            <p class="text-muted text-[12px]">
              Creates a new saved instance (maximum 12 per character). Existing
              trackers are never replaced. Works offline; does not show or open
              WoW.
            </p>
            <label class="flex gap-[10px] items-start"
              ><input type="checkbox" bind:checked={confirmed} />I confirm these
              goals and this recipient for a new tracker.</label
            >
            <Button
              intent="primary"
              onclick={save}
              disabled={!valid ||
                !recipient ||
                !confirmed ||
                busy ||
                app.locked}>Create new tracker</Button
            >
          </div>
        {:else}
          <Button onclick={copy}>Copy template</Button>
          <label class="grid gap-[8px] mt-[12px] text-[12px]"
            >Template for manual copy<textarea
              aria-label="Template for manual copy"
              readonly
              value={raw}
              rows="3"
              class="w-full rounded-[8px] bg-[#182327] border border-[#3a4c4f] p-[10px]"
            ></textarea></label
          >
        {/if}
      {/if}
      <Button intent="quiet" onclick={cancel} disabled={busy}>Cancel</Button>
    </Card>
  {/if}
  {#if !app.status.gameConnected && app.status.panels.length}<p
      class="field-hint offline-hint text-[11px]! text-muted mt-[12px]"
    >
      Connect WoW to show or hide panels. Your saved panels remain available
      here.
    </p>{/if}
  {#if !app.status?.panels.length}<Card
      kind="empty"
      class="text-center [&_>_svg]:text-[#577e7c] [&_>_svg]:mb-[16px]"
    >
      <Icon name="panel" size={34} />
      <h2 class="text-[21px]">No panels yet.</h2>
      <p
        class="mx-auto text-muted text-[13px] max-w-[400px] mt-[12px] mb-[23px]"
      >
        Ask Wisp in game to create a tracker or panel. Your saved panels will
        appear here.
      </p>
    </Card>{:else}{#each app.status.panels as panel (panel.id)}<Card
        kind="panel"
        class="gap-[20px] flex justify-between items-center max-xl:gap-[12px] max-xl:items-stretch max-xl:flex-col"
      >
        <div
          class="integration-top gap-[18px] flex items-center justify-between flex-[1]"
        >
          <div>
            <h2>{panel.title}</h2>
            <p class="text-muted text-[13px]">
              {panel.character}
            </p>
          </div>
          <Badge>{panel.bindings?.length || 0} tracked values</Badge>
        </div>
        <div class="actions gap-[10px] mt-0 flex flex-wrap items-center">
          <ActionProgress {app} target={panel.id} />
          <Button
            onclick={() => exportPanel(panel)}
            disabled={busy || app.locked}>Export template</Button
          >
          <Button
            onclick={() => app.panelAction(panel, "show")}
            disabled={app.locked || !app.status.gameConnected}
            >Show in WoW</Button
          ><Button
            onclick={() => app.panelAction(panel, "hide")}
            disabled={app.locked || !app.status.gameConnected}>Hide</Button
          ><Button
            intent="quiet"
            destructive
            onclick={() => {
              app.confirm = {
                label: `Delete “${panel.title}”?`,
                run: () => app.panelAction(panel, "remove"),
              };
            }}
            disabled={app.locked}>Delete</Button
          >
        </div>
      </Card>{/each}{/if}
{/if}
