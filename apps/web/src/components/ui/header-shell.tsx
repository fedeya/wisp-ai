import type { ComponentPropsWithRef } from 'react';
import { tv, type VariantProps } from 'tailwind-variants';
const styles = tv({
  base: "sticky top-0 z-50 h-[64px] isolate md:h-[82px] before:absolute before:inset-0 before:-z-[1] before:bg-[#12110ff2] before:[border-bottom:1px_solid_var(--line)] before:opacity-0 before:backdrop-blur-[10px] before:transition-opacity before:duration-[180ms] before:content-['']",
  variants: { opaque: { true: 'before:opacity-100' } },
});

export function HeaderShell({
  opaque,
  className,
  ...props
}: ComponentPropsWithRef<'div'> & VariantProps<typeof styles>) {
  return <div {...props} className={styles({ opaque, class: className })} />;
}
