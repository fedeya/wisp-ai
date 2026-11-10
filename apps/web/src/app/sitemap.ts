import type { MetadataRoute } from 'next';
import { site } from '../site';
import { locales, localizedPath } from '../i18n/config';

export default function sitemap(): MetadataRoute.Sitemap {
  return ['/', '/features', '/setup', '/changelog'].flatMap((path) =>
    locales.map((locale) => ({
      url: `${site.url}${localizedPath(locale, path)}`,
      changeFrequency: 'monthly' as const,
      priority: path === '/' ? 1 : path === '/features' ? 0.8 : 0.7,
      alternates: {
        languages: {
          en: `${site.url}${localizedPath('en', path)}`,
          es: `${site.url}${localizedPath('es', path)}`,
        },
      },
    })),
  );
}
