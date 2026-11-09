// Shared layout primitives. Keep these literal so Tailwind can detect utilities.
export const containerClassName =
  'mx-auto w-[calc(100%_-_32px)] sm:w-[calc(100%_-_40px)] md:w-[calc(100%_-_64px)] lg:w-[min(1220px,_calc(100%_-_96px))]';

export const navigationLinkClassName =
  'flex min-h-[42px] items-center gap-[5px] rounded px-3 py-3 text-[13px] hover:bg-[#c4aa7010] hover:text-gold aria-[current=page]:text-gold aria-[current=page]:underline aria-[current=page]:decoration-[#d6b77755] aria-[current=page]:underline-offset-[7px] md:min-h-0 md:p-0 md:hover:bg-transparent';
