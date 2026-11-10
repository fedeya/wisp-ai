<script lang="ts">
  import { card, badge, button } from "../ui";

  import DataState from "../DataState.svelte";
  import ActionProgress from "../ActionProgress.svelte";
  import type { DesktopController } from "../desktop-controller.svelte";
  import Icon from "../Icon.svelte";
  let { app }: { app: DesktopController } = $props();
</script>

{#if app.loading || !app.status}<DataState {app} />{:else}
  {#if !app.status.gameConnected && app.status.panels.length}<p
      class="field-hint offline-hint text-[11px]! text-muted mt-[12px]"
    >
      Connect WoW to show or hide panels. Your saved panels remain available
      here.
    </p>{/if}
  {#if !app.status?.panels.length}<section
      class={card({
        kind: "empty",
        class:
          "card empty-state text-center [&_>_svg]:text-[#577e7c] [&_>_svg]:mb-[16px]",
      })}
    >
      <Icon name="panel" size={34} />
      <h2 class="text-[21px]">No panels yet.</h2>
      <p
        class="mx-auto text-muted text-[13px] max-w-[400px] mt-[12px] mb-[23px]"
      >
        Ask Wisp in game to create a tracker or panel. Your saved panels will
        appear here.
      </p>
    </section>{:else}{#each app.status.panels as panel (panel.id)}<section
        class={card({
          kind: "panel",
          class:
            "card panel-row gap-[20px] flex justify-between items-center max-xl:gap-[12px] max-xl:items-stretch max-xl:flex-col",
        })}
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
          <span class={badge({ class: "badge" })}
            >{panel.bindings?.length || 0} tracked values</span
          >
        </div>
        <div class="actions gap-[10px] mt-0 flex flex-wrap items-center">
          <ActionProgress {app} target={panel.id} />
          <button
            class={button({})}
            onclick={() => app.panelAction(panel, "show")}
            disabled={app.locked || !app.status.gameConnected}
            >Show in WoW</button
          ><button
            class={button({})}
            onclick={() => app.panelAction(panel, "hide")}
            disabled={app.locked || !app.status.gameConnected}>Hide</button
          ><button
            class={button({
              intent: "quiet",
              destructive: true,
              class: "quiet danger text-[#e5a399]",
            })}
            onclick={() => {
              app.confirm = {
                label: `Delete “${panel.title}”?`,
                run: () => app.panelAction(panel, "remove"),
              };
            }}
            disabled={app.locked}>Delete</button
          >
        </div>
      </section>{/each}{/if}
{/if}
