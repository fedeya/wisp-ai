<script lang="ts">
  import type { HTMLInputAttributes } from "svelte/elements";
  import { tv } from "tailwind-variants";
  import { fieldBase } from "./field";
  const field = tv({ base: [fieldBase, "disabled:opacity-50"] });
  let {
    value = $bindable(),
    type = "text",
    class: className,
    ...rest
  }: Omit<HTMLInputAttributes, "class"> & { class?: string } = $props();
</script>

<input {...rest} {type} bind:value class={field({ class: className })} />
