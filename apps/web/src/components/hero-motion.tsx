'use client';

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
    <div ref={scope} className="hero-inner site-container">
      {children}
    </div>
  );
}
