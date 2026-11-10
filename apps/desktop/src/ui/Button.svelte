<script lang="ts">
  import type { HTMLButtonAttributes } from "svelte/elements";
  import { tv, type VariantProps } from "tailwind-variants";
  const focus =
    "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent focus-visible:outline-offset-[3px]";
  const button = tv({
    base: `inline-flex min-h-[37px] cursor-pointer items-center justify-center gap-[9px] whitespace-nowrap rounded-[8px] border border-solid px-[15px] py-[8px] text-inherit transition-[background,border-color,transform] duration-150 enabled:hover:border-[#568780] enabled:hover:bg-[#2a3d3f] enabled:active:translate-y-px disabled:cursor-default disabled:opacity-40 ${focus}`,
    variants: {
      intent: {
        default: "border-[#3a4c4f] bg-[#202a2f]",
        primary:
          "primary border-transparent bg-accent font-semibold text-[#102322] enabled:hover:bg-[#92e8d5]",
        quiet: "quiet border-transparent bg-transparent",
        danger: "danger-button border-[#3a4c4f] bg-[#713e3a] text-[#ffe8e3]",
      },
      size: {
        default: "",
        text: "text-button min-h-[24px] px-0 py-[4px] text-accent",
        icon: "icon-button min-h-[30px] p-[6px]",
      },
      destructive: { true: "danger text-[#e5a399]" },
    },
    defaultVariants: { intent: "default", size: "default" },
  });

  const navigationButton = tv({
    base: button({
      intent: "quiet",
      class:
        "min-h-[45px] shrink-0 justify-start gap-[13px] px-[14px] py-[12px] text-[13px] text-[#9aadb4] [@media(height<=700px)]:min-h-[40px] [@media(height<=700px)]:py-[9px]",
    }),
    variants: { selected: { true: "bg-[#1e3333] text-accent" } },
  });

  type Props = Omit<HTMLButtonAttributes, "class"> & {
    class?: string;
  } & VariantProps<typeof button> & {
      navigation?: boolean;
      selected?: boolean;
    };
  let {
    intent,
    size,
    destructive,
    navigation = false,
    selected = false,
    class: className,
    type = "button",
    children,
    ...rest
  }: Props = $props();
</script>

<button
  {...rest}
  {type}
  class={navigation
    ? navigationButton({ selected, class: className })
    : button({ intent, size, destructive, class: className })}
  >{@render children?.()}</button
>
