<script lang="ts">
  import { onMount } from "svelte";
  import { desktop, native } from "./api";
  import Card from "./ui/Card.svelte";
  import Toggle from "./Toggle.svelte";

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
        Help improve Wisp by sharing usage data.
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
