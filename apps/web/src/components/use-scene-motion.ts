'use client';

import { useAnimate } from 'motion/react-mini';
import { animate as animateValue } from 'motion/react';
import { useCallback, useEffect, useRef } from 'react';

// The scene timers and its in-flight animations share the same playback state.
// Pause/resume keeps the current frame instead of restarting an entrance.
export function useSceneMotion(stopped: boolean, reduced: boolean) {
  const [scope, animate] = useAnimate();
  const active = useRef(new Set<ReturnType<typeof animate>>());
  const paused = useRef(stopped);

  useEffect(() => {
    const animations = active.current;
    return () => {
      for (const animation of animations) {
        animation.stop();
      }
      animations.clear();
    };
  }, []);

  useEffect(() => {
    paused.current = stopped;
    for (const animation of active.current) {
      if (stopped) {
        animation.pause();
      } else {
        animation.play();
      }
    }
  }, [stopped]);

  const track = useCallback((animation: ReturnType<typeof animate>) => {
    active.current.add(animation);
    if (paused.current) {
      animation.pause();
    }
    void animation.then(() => active.current.delete(animation));
    return () => {
      active.current.delete(animation);
      animation.stop();
    };
  }, []);

  const run = useCallback(
    (
      selector: string,
      keyframes: Parameters<typeof animate>[1],
      options: Parameters<typeof animate>[2] = {},
    ) => {
      const animation = animate(selector, keyframes, {
        ease: 'easeOut',
        ...options,
        ...(reduced ? { duration: 0, delay: 0 } : {}),
      });
      if (reduced) {
        return () => animation.stop();
      }
      return track(animation);
    },
    [animate, reduced, track],
  );

  const write = useCallback(
    (from: number, to: number, duration: number, onUpdate: (value: number) => void) =>
      track(animateValue(from, to, { duration, ease: 'linear', onUpdate })),
    [track],
  );

  return [scope, run, write] as const;
}
