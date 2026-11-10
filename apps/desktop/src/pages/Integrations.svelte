<script lang="ts">
  import Button from "../ui/Button.svelte";
  import Card from "../ui/Card.svelte";

  import DataState from "../DataState.svelte";
  import ActionProgress from "../ActionProgress.svelte";
  import type { DesktopController } from "../desktop-controller.svelte";
  import Icon from "../Icon.svelte";
  import IntegrationCard from "../IntegrationCard.svelte";
  import { request } from "../api";
  let { app }: { app: DesktopController } = $props();
</script>

{#if app.loading || !app.status}<DataState {app} />{:else}
  <div class="toolbar flex items-center justify-between mb-[18px]">
    <p class="muted text-muted text-[12px]">
      {app.status?.mcps.length || 0} custom connections
    </p>
    <Button
      intent="primary"
      onclick={() => app.edit(null)}
      disabled={app.locked || !app.status}
      ><Icon name="plus" size={17} />Add MCP</Button
    >
  </div>
  <div class="connection-list">
    {#each (app.status?.integrations || []).filter((entry) => entry.group === "integrations" && !entry.parent) as entry (entry.id)}
      <div
        class="integration-group border border-solid border-border rounded-[12px] [background:var(--surface)] mb-[14px] overflow-hidden [&_.integration]:border-0 [&_.integration]:border-none [&_.integration]:border-[currentColor] [&_.integration]:m-0 [&_.integration]:rounded-[0] [&_.integration]:[background:transparent]"
      >
        <IntegrationCard
          {entry}
          tools={(app.status?.integrations || []).filter(
            (tool) => tool.parent === entry.id,
          )}
          locked={app.locked}
          busy={app.busy === "Updating integration" &&
          (app.busyTarget === entry.id ||
            (app.status?.integrations || []).some(
              (tool) => tool.parent === entry.id && tool.id === app.busyTarget,
            ))
            ? app.busy
            : ""}
          set={app.setIntegration}
        />
        {#each (app.status?.mcps || []).filter((server) => entry.id === "mcp:" + server.name) as server (server.name)}
          <div
            class="actions gap-[10px] px-[22px] py-[12px] m-0 flex flex-wrap items-center border-t-[1px] [border-top-style:solid] border-t-[var(--border)]"
          >
            <ActionProgress {app} target={entry.id} />
            <Button onclick={() => app.edit(server)} disabled={app.locked}
              >Edit</Button
            >
            <Button
              onclick={() =>
                app.work(
                  "Testing " + server.name,
                  async () => {
                    const result = await request<{ count: number }>(
                      "/mcps/test",
                      { server },
                    );
                    app.feedback =
                      "Connected. " + result.count + " tools available.";
                  },
                  undefined,
                  entry.id,
                )}
              disabled={app.locked}>Test connection</Button
            >
            <Button
              intent="quiet"
              destructive
              onclick={() => app.removeMcp(server)}
              disabled={app.locked}>Remove</Button
            >
          </div>
        {/each}
      </div>
    {:else}<Card
        kind="empty"
        class="text-center [&_>_svg]:text-[#577e7c] [&_>_svg]:mb-[16px]"
      >
        <h2 class="text-[21px]">No integrations available yet</h2>
        <p
          class="mx-auto text-muted text-[13px] max-w-[400px] mt-[12px] mb-[23px]"
        >
          Connect WoW to discover supported addons, or add an MCP server to give
          Wisp more tools.
        </p>
      </Card>{/each}
  </div>
  <p class="footnote text-[11px]! text-muted mt-[12px]">
    Changes apply to new tool calls. Disabling an integration preserves
    individual tool choices. Addon availability updates when WoW connects.
  </p>
{/if}
