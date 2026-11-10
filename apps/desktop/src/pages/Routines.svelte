<script lang="ts">
  import { card, button } from "../ui";

  import DataState from "../DataState.svelte";
  import ActionProgress from "../ActionProgress.svelte";
  import type { DesktopController } from "../desktop-controller.svelte";
  import { request } from "../api";
  import { describeRoutineTrigger } from "@wisp/protocol/routines";
  let { app }: { app: DesktopController } = $props();
</script>

{#if app.loading || !app.status}<DataState {app} />{:else}
  <section class={card({ class: "card" })}>
    <h2>
      {app.status.routines.length
        ? "Create another routine in game"
        : "No routines yet"}
    </h2>
    <p class="text-muted text-[13px]">
      Try “Every two levels, review my spells and rotation” or “When I change
      weapons, review my equipment.” Routines run while the character is
      connected, outside combat. Each run has its own conversation.
    </p>
  </section>
  {#each app.status?.routines || [] as routine (routine.characterKey + routine.id)}
    <section class={card({ class: "card" })}>
      <div
        class="section-title gap-[18px] flex items-center justify-between [&_>_svg]:text-muted"
      >
        <div>
          <h2>{routine.title}</h2>
          <p class="text-muted text-[13px]">
            {routine.enabled ? "Active" : "Paused"} · {app.characterLabel(
              routine.characterKey,
            )}
          </p>
        </div>
        <div class="actions gap-[10px] mt-0 flex flex-wrap items-center">
          <ActionProgress {app} target={routine.characterKey + routine.id} />
          <button
            class={button({})}
            disabled={!!app.busy}
            onclick={() =>
              app.work(
                "Updating routine",
                () =>
                  request("/routines/action", {
                    characterKey: routine.characterKey,
                    id: routine.id,
                    operation: routine.enabled ? "pause" : "resume",
                  }),
                "Routine updated.",
                routine.characterKey + routine.id,
              )}>{routine.enabled ? "Pause" : "Resume"}</button
          >
          <button
            class={button({
              intent: "quiet",
              destructive: true,
              class: "quiet danger text-[#e5a399]",
            })}
            disabled={!!app.busy}
            onclick={() => {
              app.confirm = {
                label: "Delete “" + routine.title + "”?",
                run: () =>
                  app.work(
                    "Deleting routine",
                    () =>
                      request("/routines/action", {
                        characterKey: routine.characterKey,
                        id: routine.id,
                        operation: "remove",
                      }),
                    "Routine deleted.",
                    routine.characterKey + routine.id,
                  ),
              };
            }}>Delete</button
          >
        </div>
      </div>
      <p class="text-muted text-[13px]">
        {routine.instruction}
      </p>
      <p class="muted text-muted text-[13px]">
        {routine.triggers.map(describeRoutineTrigger).join(" or ")}
      </p>
      <details
        class="routine-history border-t-[1px] [border-top-style:solid] border-t-[var(--border)] mt-[18px] pt-[16px]"
      >
        <summary class="cursor-pointer text-muted text-[13px]"
          >Run history ({(app.status?.routineRuns || []).filter(
            (r) =>
              r.routineId === routine.id &&
              r.characterKey === routine.characterKey,
          ).length})</summary
        >
        {#each (app.status?.routineRuns || [])
          .filter((r) => r.routineId === routine.id && r.characterKey === routine.characterKey)
          .reverse() as run (run.id)}
          <div
            class="section-title gap-[18px] px-0 py-[12px] flex items-center justify-between border-b-[1px] [border-bottom-style:solid] border-b-[var(--border)] [&_>_svg]:text-muted"
          >
            <div>
              <p class="text-muted text-[13px]">
                {new Date(run.startedAt).toLocaleString()} · {run.status ===
                "no_tip"
                  ? "No updates"
                  : run.status}
              </p>
              {#if run.status === "error" || run.status === "interrupted"}<p
                  class="muted text-muted text-[13px]"
                >
                  {run.summary}
                </p>{/if}
            </div>
            {#if run.status !== "no_tip"}<button
                class={button({})}
                disabled={!!app.busy || !app.status?.gameConnected}
                onclick={() =>
                  app.work(
                    "Opening run",
                    () => request("/routines/open", { id: run.id }),
                    "Conversation selected in WoW. Open /wisp to continue.",
                    routine.characterKey + routine.id,
                  )}>Open in game</button
              >{/if}
          </div>
        {:else}<p class="muted text-muted text-[13px]">No runs yet.</p>{/each}
      </details>
    </section>
  {/each}
{/if}
