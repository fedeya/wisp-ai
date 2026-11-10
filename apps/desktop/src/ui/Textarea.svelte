<script lang="ts">
  import type { HTMLTextareaAttributes } from "svelte/elements";
  import { tv } from "tailwind-variants";
  import { fieldBase } from "./field";
  const field = tv({ base: [fieldBase, "resize-y"] });
  let {
    value = $bindable(),
    class: className,
    ...rest
  }: Omit<HTMLTextareaAttributes, "class"> & { class?: string } = $props();
</script>

<textarea {...rest} bind:value class={field({ class: className })}></textarea>
