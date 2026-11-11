'use client';

import { useEffect } from 'react';
import { initializeAnalytics } from '../analytics';

export function WebsiteAnalytics() {
  useEffect(() => initializeAnalytics(), []);
  return null;
}
