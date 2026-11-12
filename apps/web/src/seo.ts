import type { Metadata } from 'next';
import { site } from './site';
import { descriptions, getTranslator, localizedPath, type Locale } from './i18n';

export const isPreview = process.env.VERCEL_ENV === 'preview';

export function pageMetadata(
  title: string,
  description: string,
  path: string,
  locale: Locale = 'en',
  socialImage?: { path: string; alt: string },
): Metadata {
  const t = getTranslator(locale);
  const image = localizedPath(locale, socialImage?.path ?? '/opengraph-image');
  const imageAlt = socialImage?.alt ?? t('Wisp AI — AI companion for WoW: Forever');
  return {
    title,
    description,
    alternates: {
      canonical: localizedPath(locale, path),
      languages: {
        en: localizedPath('en', path),
        es: localizedPath('es', path),
        'x-default': localizedPath('en', path),
      },
    },
    openGraph: {
      type: 'website',
      locale: locale === 'es' ? 'es_LA' : 'en_US',
      alternateLocale: [locale === 'es' ? 'en_US' : 'es_LA'],
      siteName: site.name,
      url: `${site.url}${localizedPath(locale, path)}`,
      title,
      description,
      images: [
        {
          url: image,
          width: 1200,
          height: 630,
          alt: imageAlt,
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: socialImage ? [{ url: image, alt: imageAlt }] : [image],
    },
  };
}

export function localizedMetadata(locale: Locale, path: string): Metadata {
  const t = getTranslator(locale);
  const copy =
    path === '/features'
      ? [
          'Features — Wisp AI for WoW: Forever',
          'Explore Wisp’s routines, memory, gear advice, auction prices, macros and more. See example prompts, requirements and limits for every feature.',
        ]
      : path === '/setup'
        ? [
            'Get started — Install Wisp AI for WoW: Forever',
            'Install Wisp on Windows, choose your AI connection and open /wisp in WoW: Forever. Setup steps, connection options, troubleshooting and privacy controls.',
          ]
        : ['Wisp AI — AI companion for WoW: Forever', descriptions[locale]];
  return pageMetadata(t(copy[0]), t(copy[1]), path, locale);
}
