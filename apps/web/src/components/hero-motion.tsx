'use client';
import { containerClassName } from './ui';

import { useAnimate } from 'motion/react-mini';
import { stagger, useReducedMotion } from 'motion/react';
import { useEffect, type ReactNode } from 'react';

// Keep the server-rendered hero visible, including before hydration and without JS.
export function HeroMotion({ children }: { children: ReactNode }) {
  const [scope, animate] = useAnimate();
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (reducedMotion !== false) {
      const reset = animate(
        '[data-hero-copy] > *, [data-hero-product]',
        { opacity: 1, transform: 'none' },
        { duration: 0 },
      );
      return () => reset.stop();
    }

    const copy = animate(
      '[data-hero-copy] > *',
      { opacity: [0.65, 1], transform: ['translateY(12px)', 'translateY(0px)'] },
      { duration: 0.5, delay: stagger(0.07), ease: 'easeOut' },
    );
    const product = animate(
      '[data-hero-product]',
      { opacity: [0.7, 1], transform: ['translateY(20px)', 'translateY(0px)'] },
      { duration: 0.7, delay: 0.15, ease: 'easeOut' },
    );
    return () => {
      copy.stop();
      product.stop();
    };
  }, [animate, reducedMotion]);

  return (
    <div
      ref={scope}
      className={`${containerClassName} hero-inner gap-[0] relative grid min-h-[0] grid-cols-[1fr] items-center pt-[45px] pb-[25px] md:gap-[22px] md:min-h-[668px] md:grid-cols-[repeat(2,minmax(0,1fr))] md:pb-[65px] lg:gap-[60px] 2xl:min-h-[758px]`}
    >
      {children}
    </div>
  );
}
