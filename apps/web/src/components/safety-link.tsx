'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { trackSafetyClick, type SafetyDetails } from '../analytics';

export function SafetyLink({
  href,
  location,
  locale,
  children,
}: SafetyDetails & { href: string; children: ReactNode }) {
  return (
    <Link
      className="text-gold underline underline-offset-2 [&:hover]:text-gold"
      href={href}
      onClick={() => trackSafetyClick({ location, locale })}
    >
      {children}
    </Link>
  );
}
