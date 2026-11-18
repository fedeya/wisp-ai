import { tv } from 'tailwind-variants';
const fieldBase =
  'min-h-[32px] min-w-0 w-full rounded-[4px] border border-solid border-border border-b-field-line bg-field px-[10px] py-[6px] hover:bg-hover text-[#e4ebe9] placeholder:text-[#91a1a8]';
/** Native-style focus: a darker field with an accent line along the bottom, no ring. */
const fieldFocus =
  'outline-none focus:bg-field-focus focus:border-b-accent focus:shadow-[inset_0_-1px_0_var(--color-accent)]';

/** Shared look for everything that floats: menus, dialogs, toasts. */
export const floatingSurface =
  'rounded-[8px] border border-solid border-border bg-raised shadow-floating';
export const dialogBackdrop = 'fixed inset-0 z-[20] bg-black/50';

const focus =
  'focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent focus-visible:outline-offset-[3px]';
export const button = tv({
  base: `inline-flex min-h-[32px] items-center justify-center gap-[7px] whitespace-nowrap rounded-[4px] border border-solid px-[12px] py-[5px] text-base text-inherit transition-colors duration-75 disabled:cursor-default disabled:opacity-40 ${focus}`,
  variants: {
    intent: {
      default:
        'border-divider border-b-pressed bg-control enabled:hover:bg-control-hover enabled:active:bg-pressed enabled:active:text-muted',
      primary:
        'primary border-transparent border-b-black/20 bg-accent font-semibold text-on-accent enabled:hover:bg-accent-hover enabled:active:bg-accent-pressed',
      quiet:
        'quiet border-transparent bg-transparent enabled:hover:bg-hover enabled:active:bg-pressed',
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
  base: `flex min-h-[34px] shrink-0 items-center gap-[10px] rounded-[4px] px-[10px] py-[6px] text-base text-subtle no-underline transition-colors duration-75 hover:bg-hover hover:text-foreground ${focus}`,
  variants: { selected: { true: 'bg-active text-foreground hover:bg-active' } },
});

export const badge = tv({
  base: 'badge inline-flex items-center gap-[6px] whitespace-nowrap rounded-[4px] bg-control px-[7px] py-[3px] text-[11px]',
  variants: { positive: { true: 'text-accent!', false: 'text-muted' } },
  defaultVariants: { positive: false },
});

export const card = tv({
  base: 'card mb-4 rounded-[6px] border border-solid border-divider bg-surface p-5',
  variants: {
    kind: {
      default: '',
      provider: 'provider-card p-5',
      integration: 'integration px-4 py-3',
      toggle: 'toggle-card px-4 py-3',
      panel: 'panel-row px-4 py-3',
      empty: 'empty-state px-6 py-12 text-center',
    },
    density: { compact: 'p-4 max-sm:p-3' },
  },
  defaultVariants: { kind: 'default' },
});

export const field = tv({ base: [fieldBase, fieldFocus, 'disabled:opacity-50'] });
/** Select trigger: a button, not a text field, so no underline focus; a ring only for keyboard focus. */
export const selectTrigger = tv({
  base: [fieldBase, 'outline-none', focus, 'disabled:opacity-50'],
});
export const checkbox = tv({
  base: [
    fieldBase,
    'h-[15px] min-h-0 w-[15px] p-0 accent-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent focus-visible:outline-offset-[3px] disabled:opacity-50',
  ],
});
export const textarea = tv({ base: [fieldBase, fieldFocus, 'resize-y'] });
