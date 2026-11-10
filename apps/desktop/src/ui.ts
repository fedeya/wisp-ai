import { tv } from 'tailwind-variants';

const focus =
  'focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent focus-visible:outline-offset-[3px]';

export const button = tv({
  base: `inline-flex min-h-[37px] cursor-pointer items-center justify-center gap-[9px] whitespace-nowrap rounded-[8px] border border-solid px-[15px] py-[8px] text-inherit transition-[background,border-color,transform] duration-150 enabled:hover:border-[#568780] enabled:hover:bg-[#2a3d3f] enabled:active:translate-y-px disabled:cursor-default disabled:opacity-40 ${focus}`,
  variants: {
    intent: {
      default: 'border-[#3a4c4f] bg-[#202a2f]',
      primary:
        'border-transparent bg-accent font-semibold text-[#102322] enabled:hover:bg-[#92e8d5]',
      quiet: 'border-transparent bg-transparent',
      danger: 'border-[#3a4c4f] bg-[#713e3a] text-[#ffe8e3]',
    },
    size: {
      default: '',
      text: 'min-h-[24px] px-0 py-[4px] text-accent',
      icon: 'min-h-[30px] p-[6px]',
    },
    destructive: { true: 'text-[#e5a399]' },
  },
  defaultVariants: { intent: 'default', size: 'default' },
});

export const navigationButton = tv({
  base: button({
    intent: 'quiet',
    class:
      'min-h-[45px] shrink-0 justify-start gap-[13px] px-[14px] py-[12px] text-[13px] text-[#9aadb4] [@media(height<=700px)]:min-h-[40px] [@media(height<=700px)]:py-[9px]',
  }),
  variants: { selected: { true: 'bg-[#1e3333] text-accent' } },
});

export const field = tv({
  base: `min-h-[39px] min-w-0 w-full rounded-[7px] border border-solid border-[#36464d] bg-[#151d22] px-[12px] py-[9px] text-[#e4ebe9] placeholder:text-[#91a1a8] ${focus}`,
  variants: {
    kind: {
      text: 'disabled:opacity-50',
      area: 'resize-y',
      checkbox: 'h-[15px] min-h-0 w-[15px] p-0 accent-accent disabled:opacity-50',
    },
  },
  defaultVariants: { kind: 'text' },
});

export const card = tv({
  base: 'card mb-[18px] rounded-[12px] border border-solid border-border bg-surface p-[23px]',
  variants: {
    kind: {
      default: '',
      provider: 'provider-card p-[26px]',
      workspace:
        'workspace-status bg-[linear-gradient(120deg,#1d2c2d,var(--surface)_80%)] p-[22px] md:p-[28px]',
      installation: 'installation-card px-[23px] py-[20px]',
      integration: 'integration px-[22px] py-[19px]',
      toggle: 'toggle-card px-[22px] py-[19px]',
      panel: 'panel-row px-[22px] py-[18px]',
      empty: 'empty-state px-[30px] py-[64px] text-center',
    },
    ready: { true: 'border-[#365b51]' },
  },
  defaultVariants: { kind: 'default' },
});

export const badge = tv({
  base: 'badge inline-flex items-center gap-[7px] whitespace-nowrap rounded-[20px] border border-solid border-[#3a494e] px-[9px] py-[5px] text-[10px]',
  variants: { positive: { true: 'text-accent!', false: 'text-muted' } },
  defaultVariants: { positive: false },
});
