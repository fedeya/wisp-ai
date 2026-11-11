<script lang="ts">
  import { onMount } from "svelte";
  import { desktop, native } from "./api";
  import Card from "./ui/Card.svelte";
  import Toggle from "./Toggle.svelte";

  let { onchange }: { onchange: (enabled: boolean) => void } = $props();
  let enabled = $state(true);
  let loaded = $state(false);
  let saving = $state(false);
  let error = $state("");
  onMount(() => {
    if (!native) return;
    void desktop<{ enabled: boolean }>("telemetry_settings")
      .then((settings) => {
        enabled = settings.enabled;
        loaded = true;
      })
      .catch(() => {
        error = "Could not load usage analytics settings.";
      });
  });
  async function change(value: boolean) {
    const previous = enabled;
    enabled = value;
    saving = true;
    error = "";
    try {
      const settings = await desktop<{ enabled: boolean }>(
        "telemetry_settings",
        { enabled: value },
      );
      enabled = settings.enabled;
      onchange(enabled);
    } catch {
      enabled = previous;
      error = "Could not save usage analytics settings. Try again.";
    } finally {
      saving = false;
    }
  }
</script>

<Card>
  <div class="flex items-center justify-between gap-6">
    <div>
      <h2>Usage analytics</h2>
      <p class="mt-2 text-[13px] leading-relaxed text-muted">
        Enabled by default to help improve Wisp. Sends app and addon versions,
        app activity, features used, tool names, outcomes and durations to
        PostHog using a random installation ID.
      </p>
      <p class="mt-2 text-[13px] leading-relaxed text-muted">
        Conversations, tool arguments and results, character names, credentials
        and local logs are not included. Turning this off stops future usage
        events from the desktop app, bridge and agent.
      </p>
    </div>
    <Toggle
      label="Share usage analytics"
      checked={enabled}
      disabled={!loaded || saving}
      onchange={change}
    />
  </div>
  {#if error}<p role="alert" class="mt-3 text-[13px] text-[#f0b4aa]">
      {error}
    </p>{/if}
</Card>
