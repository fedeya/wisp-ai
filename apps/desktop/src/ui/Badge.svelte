<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import { tv, type VariantProps } from "tailwind-variants";
  const badge = tv({
    base: "badge inline-flex items-center gap-[7px] whitespace-nowrap rounded-[20px] border border-solid border-[#3a494e] px-[9px] py-[5px] text-[10px]",
    variants: { positive: { true: "text-accent!", false: "text-muted" } },
    defaultVariants: { positive: false },
  });

  let {
    positive,
    class: className,
    children,
    ...rest
  }: Omit<HTMLAttributes<HTMLSpanElement>, "class"> & {
    class?: string;
  } & VariantProps<typeof badge> = $props();
</script>

<span {...rest} class={badge({ positive, class: className })}
  >{@render children?.()}</span
>
