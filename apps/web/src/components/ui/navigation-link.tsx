import Link from 'next/link';
import type { ComponentPropsWithRef } from 'react';
import { tv } from 'tailwind-variants';
const styles = tv({
  base: 'flex min-h-[42px] items-center gap-[5px] rounded px-3 py-3 text-[13px] hover:bg-[#c4aa7010] hover:text-gold aria-[current=page]:text-gold aria-[current=page]:underline aria-[current=page]:decoration-[#d6b77755] aria-[current=page]:underline-offset-[7px] md:min-h-0 md:p-0 md:hover:bg-transparent',
});
type Props = ComponentPropsWithRef<'a'> & { href: string; external?: boolean };
export function NavigationLink({ className, external = false, ...props }: Props) {
  const Component = external ? 'a' : Link;
  return <Component {...props} className={styles({ class: className })} />;
}
