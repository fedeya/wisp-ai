<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import { tv, type VariantProps } from "tailwind-variants";
  const card = tv({
    base: "card mb-[18px] rounded-[12px] border border-solid border-border bg-surface p-[23px]",
    variants: {
      kind: {
        default: "",
        provider: "provider-card p-[26px]",
        workspace:
          "workspace-status bg-[linear-gradient(120deg,#1d2c2d,var(--surface)_80%)] p-[22px] md:p-[28px]",
        installation: "installation-card px-[23px] py-[20px]",
        integration: "integration px-[22px] py-[19px]",
        toggle: "toggle-card px-[22px] py-[19px]",
        panel: "panel-row px-[22px] py-[18px]",
        empty: "empty-state px-[30px] py-[64px] text-center",
      },
      ready: { true: "border-[#365b51]" },
    },
    defaultVariants: { kind: "default" },
  });

  let {
    kind,
    ready,
    class: className,
    children,
    ...rest
  }: Omit<HTMLAttributes<HTMLElement>, "class"> & {
    class?: string;
  } & VariantProps<typeof card> = $props();
</script>

<section {...rest} class={card({ kind, ready, class: className })}>
  {@render children?.()}
</section>
