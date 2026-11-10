import type { ComponentPropsWithRef } from 'react';
import { tv, type VariantProps } from 'tailwind-variants';
import { Icon } from '../icon';
const styles = tv({
  base: 'inline-flex cursor-pointer items-center gap-[5px] rounded-[3px] border border-solid text-[10px] [&_svg]:shrink-0',
  variants: {
    scene: {
      demo: 'min-h-[28px] border-[#d8c5a52a] bg-[#1716137a] px-[9px] py-[6px] text-[#c3b79e]',
      routine: 'border-[#b9a16c30] bg-transparent px-[10px] py-[7px] text-[#bdaf93]',
    },
  },
  defaultVariants: { scene: 'demo' },
});
type Props = ComponentPropsWithRef<'button'> & VariantProps<typeof styles> & { paused: boolean };
export function PlaybackButton({
  scene,
  paused,
  children,
  className,
  type = 'button',
  ...props
}: Props) {
  return (
    <button {...props} type={type} className={styles({ scene, class: className })}>
      <Icon name={paused ? 'play' : 'pause'} size={12} />
      {children}
    </button>
  );
}
