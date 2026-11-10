<script lang="ts">
  import Button from "../ui/Button.svelte";
  import Card from "../ui/Card.svelte";

  import type { DesktopController } from "../desktop-controller.svelte";
  import ActionProgress from "../ActionProgress.svelte";
  import Icon from "../Icon.svelte";
  import { desktop } from "../api";
  let { app }: { app: DesktopController } = $props();
</script>

<Card>
  <div
    class="section-title gap-[18px] flex items-center justify-between [&_>_svg]:text-muted"
  >
    <div>
      <h2>Local activity</h2>
      <p class="text-muted text-[13px]">
        Logs stay on your computer. Review them before sharing.
      </p>
    </div>
    <div class="actions gap-[10px] mt-0 flex flex-wrap items-center">
      <ActionProgress {app} />
      <Button onclick={app.showLogs} disabled={!!app.busy}
        ><Icon name="refresh" size={16} />Refresh</Button
      ><Button
        onclick={() => app.work("Opening logs", () => desktop("open_logs"))}
        >Open folder</Button
      >
    </div>
  </div>
  {#if app.connectionError}<p
      class="banner error gap-[12px] border border-solid border-[#70473f] px-[16px] py-[12px] flex items-center rounded-[9px] [background:#332522] text-[#f0b4aa] mb-[20px] text-[13px] leading-[1.5] [&_.icon-button]:ml-auto"
      role="status"
    >
      Last connection error: {app.connectionError}
    </p>{/if}
  <pre
    class="logs border border-solid border-[#293a41] p-[18px] [background:#10171b] rounded-[9px] min-h-[320px] max-h-[55vh] overflow-auto text-[11px] [font-family:ui-monospace,_Consolas,_monospace] font-normal not-italic leading-[1.7] text-[#a5b7be] [white-space:pre-wrap] [word-break:break-word] mt-[22px]">{app.logs ||
      "No activity loaded yet. Refresh to read the local bridge logs."}</pre>
  <p class="field-hint text-[11px]! text-muted mt-[12px]">
    Data location: {app.info?.dataDirectory || "Available in the installed app"}
  </p>
</Card>
