import { tv } from 'tailwind-variants';
const fieldBase =
  'min-h-[32px] min-w-0 w-full rounded-[4px] border border-solid border-white/[0.08] border-b-white/[0.16] bg-white/[0.04] px-[10px] py-[6px] hover:bg-white/[0.06] text-[#e4ebe9] placeholder:text-[#91a1a8]';
/** Native-style focus: a darker field with an accent line along the bottom, no ring. */
const fieldFocus =
  'outline-none focus:bg-[#11161a] focus:border-b-accent focus:shadow-[inset_0_-1px_0_var(--color-accent)]';

/** Shared look for everything that floats: menus, dialogs, toasts. */
export const floatingSurface =
  'rounded-[8px] border border-solid border-white/[0.08] bg-[#232b31] shadow-[0_8px_24px_rgb(0_0_0/0.35),0_2px_6px_rgb(0_0_0/0.25)]';
export const dialogBackdrop = 'fixed inset-0 z-[20] bg-black/50';

const focus =
  'focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent focus-visible:outline-offset-[3px]';
export const button = tv({
  base: `inline-flex min-h-[32px] items-center justify-center gap-[7px] whitespace-nowrap rounded-[4px] border border-solid px-[12px] py-[5px] text-[14px] text-inherit transition-colors duration-75 disabled:cursor-default disabled:opacity-40 ${focus}`,
  variants: {
    intent: {
      default:
        'border-white/[0.07] border-b-white/[0.03] bg-white/[0.06] enabled:hover:bg-white/[0.09] enabled:active:bg-white/[0.04] enabled:active:text-muted',
      primary:
        'primary border-transparent border-b-black/20 bg-accent font-semibold text-[#102322] enabled:hover:bg-[#8be3d0] enabled:active:bg-[#6cc9b5]',
      quiet:
        'quiet border-transparent bg-transparent enabled:hover:bg-white/[0.06] enabled:active:bg-white/[0.03]',
      danger:
        'danger-button border-transparent bg-[#713e3a] text-[#ffe8e3] enabled:hover:bg-[#804640]',
    },
    size: {
      default: '',
      text: 'text-button min-h-[24px] px-0 py-[2px] text-accent enabled:hover:bg-transparent enabled:hover:underline',
      icon: 'icon-button min-h-[28px] p-[6px]',
    },
    destructive: { true: 'danger text-[#e5a399]' },
  },
  defaultVariants: { intent: 'default', size: 'default' },
});

export const navigationLink = tv({
  base: `flex min-h-[34px] shrink-0 items-center gap-[10px] rounded-[4px] px-[10px] py-[6px] text-[14px] text-[#9aadb4] no-underline transition-colors duration-75 hover:bg-white/[0.05] hover:text-foreground ${focus}`,
  variants: { selected: { true: 'bg-white/[0.07] text-foreground hover:bg-white/[0.08]' } },
});

export const badge = tv({
  base: 'badge inline-flex items-center gap-[6px] whitespace-nowrap rounded-[4px] bg-white/[0.06] px-[7px] py-[3px] text-[11px]',
  variants: { positive: { true: 'text-accent!', false: 'text-muted' } },
  defaultVariants: { positive: false },
});

export const card = tv({
  base: 'card mb-4 rounded-[6px] border border-solid border-white/[0.04] bg-surface p-5',
  variants: {
    kind: {
      default: '',
      provider: 'provider-card p-5',
      workspace: 'workspace-status p-5',
      installation: 'installation-card px-4 py-3',
      integration: 'integration px-4 py-3',
      toggle: 'toggle-card px-4 py-3',
      panel: 'panel-row px-4 py-3',
      empty: 'empty-state px-6 py-12 text-center',
    },
    density: { compact: 'p-4 max-sm:p-3' },
    ready: { true: '' },
  },
  defaultVariants: { kind: 'default' },
});

export const field = tv({ base: [fieldBase, fieldFocus, 'disabled:opacity-50'] });
export const checkbox = tv({
  base: [
    fieldBase,
    'h-[15px] min-h-0 w-[15px] p-0 accent-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent focus-visible:outline-offset-[3px] disabled:opacity-50',
  ],
});
export const textarea = tv({ base: [fieldBase, fieldFocus, 'resize-y'] });
