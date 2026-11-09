<script lang="ts">
  import { onMount } from "svelte";
  import { native, type DesktopInfo, type Status } from "./api";
  import { createTelemetry } from "./telemetry";
  let {
    info,
    status,
    showSettings,
  }: {
    info: DesktopInfo | null;
    status: Status | null;
    showSettings: boolean;
  } = $props();
  let telemetry = $state<ReturnType<typeof createTelemetry> | null>(null);
  let enabled = $state(false);
  let error = $state("");
  onMount(() => {
    try {
      telemetry = createTelemetry(localStorage, native && !import.meta.env.DEV);
      enabled = telemetry.enabled;
    } catch {
      /* Storage unavailable: leave telemetry disabled. */
    }
    return () => telemetry?.dispose();
  });
  $effect(() => {
    if (enabled) telemetry?.observe(info, status);
  });
</script>

{#if showSettings}
  <section class="card">
    <h2>Usage statistics</h2>
    <p>
      Help improve Wisp by sharing app opens, setup milestones and days with
      successful replies with our Rybbit instance. Includes app version,
      platform and a random installation ID. No conversations, credentials,
      character names or file paths are sent. The analytics server receives your
      IP address as part of the connection.
    </p>
    <label>
      <input
        type="checkbox"
        checked={enabled}
        disabled={!telemetry || !native || import.meta.env.DEV}
        onchange={(event) => {
          try {
            telemetry?.setEnabled(event.currentTarget.checked);
            enabled = telemetry?.enabled ?? false;
            error = "";
          } catch (e) {
            error = String(e);
          } finally {
            enabled = telemetry?.enabled ?? false;
            event.currentTarget.checked = enabled;
          }
        }}
      />
      Share usage statistics (optional)
    </label>
    <p class="field-hint">
      Off by default. Turning this off stops sending and removes the local
      installation ID; previously sent statistics remain on the server.
    </p>
    {#if error}<p role="alert">{error}</p>{/if}
  </section>
{/if}
