<script lang="ts">
  import type { HTMLInputAttributes } from "svelte/elements";
  import { tv } from "tailwind-variants";
  import { fieldBase } from "./field";
  const field = tv({
    base: [
      fieldBase,
      "h-[15px] min-h-0 w-[15px] p-0 accent-accent disabled:opacity-50",
    ],
  });
  let {
    checked = $bindable(),
    class: className,
    ...rest
  }: Omit<HTMLInputAttributes, "type" | "class"> & {
    class?: string;
  } = $props();
</script>

<input
  {...rest}
  type="checkbox"
  bind:checked
  class={field({ class: className })}
/>
