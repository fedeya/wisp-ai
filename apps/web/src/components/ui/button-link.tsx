import Link from 'next/link';
import type { ComponentPropsWithRef } from 'react';
import { tv, type VariantProps } from 'tailwind-variants';
const styles = tv({
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

type Props = ComponentPropsWithRef<'a'> &
  VariantProps<typeof styles> & { href: string; internal?: boolean };
export function ButtonLink({ intent, className, internal = false, ...props }: Props) {
  const Component = internal ? Link : 'a';
  return <Component {...props} className={styles({ intent, class: className })} />;
}
