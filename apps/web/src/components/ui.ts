import { tv } from 'tailwind-variants';

// Shared layout primitives. Keep these literal so Tailwind can detect utilities.
export const containerClassName =
  'mx-auto w-[calc(100%_-_32px)] sm:w-[calc(100%_-_40px)] md:w-[calc(100%_-_64px)] lg:w-[min(1220px,_calc(100%_-_96px))]';

export const navigationLinkClassName =
  'flex min-h-[42px] items-center gap-[5px] rounded px-3 py-3 text-[13px] hover:bg-[#c4aa7010] hover:text-gold aria-[current=page]:text-gold aria-[current=page]:underline aria-[current=page]:decoration-[#d6b77755] aria-[current=page]:underline-offset-[7px] md:min-h-0 md:p-0 md:hover:bg-transparent';

export const link = tv({
  base: 'button inline-flex items-center justify-center rounded-[4px] font-semibold transition-[filter,border-color,box-shadow] duration-[180ms] hover:border-[#e8cc92] hover:brightness-[1.06]',
  variants: {
    intent: {
      primary:
        'primary min-h-[48px] gap-3 border border-solid border-[#efdaab] bg-[linear-gradient(180deg,#e7c88b,#c5a467)] px-[22px] text-[13px] text-[#241c10] shadow-[0_3px_18px_#0005] hover:shadow-[0_4px_22px_#0007]',
      outline:
        'min-h-[34px] gap-[6px] border border-solid border-[#c4a16a60] px-2 text-[11px] text-[#e8d3aa] md:min-h-[38px] md:gap-3 md:px-[18px] md:text-[13px]',
    },
  },
  defaultVariants: { intent: 'primary' },
});

export const headerShell = tv({
  base: "sticky top-0 z-50 h-[64px] isolate md:h-[82px] before:absolute before:inset-0 before:-z-[1] before:bg-[#12110ff2] before:[border-bottom:1px_solid_var(--line)] before:opacity-0 before:backdrop-blur-[10px] before:transition-opacity before:duration-[180ms] before:content-['']",
  variants: { opaque: { true: 'before:opacity-100' } },
});
