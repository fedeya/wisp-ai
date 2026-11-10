<script lang="ts">
  import type { HTMLSelectAttributes } from "svelte/elements";
  import { tv } from "tailwind-variants";
  import { fieldBase } from "./field";
  const field = tv({ base: [fieldBase, "disabled:opacity-50"] });
  let {
    value = $bindable(),
    children,
    class: className,
    ...rest
  }: Omit<HTMLSelectAttributes, "class"> & { class?: string } = $props();
</script>

<select {...rest} bind:value class={field({ class: className })}
  >{@render children?.()}</select
>
