import { getTranslator, locales } from '../../i18n';
import { resolveLocale, type LocalePageProps } from '../../i18n/server';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { DM_Sans, Manrope } from 'next/font/google';
import { site } from '../../site';
import { isPreview, pageMetadata } from '../../seo';
import { SiteHeader } from '../../components/site-header';
import { SiteFooter } from '../../components/site-footer';
import '../globals.css';
const dmSans = DM_Sans({ subsets: ['latin'], display: 'swap', variable: '--font-dm-sans' });
const manrope = Manrope({
  subsets: ['latin'],
  weight: '800',
  display: 'swap',
  variable: '--font-manrope',
  preload: false,
});
export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  ...pageMetadata('Wisp AI — AI companion for WoW: Forever', site.description, '/'),
  applicationName: site.name,
  robots: {
    index: !isPreview,
    follow: !isPreview,
    googleBot: { index: !isPreview, follow: !isPreview, 'max-image-preview': 'large' },
  },
  icons: {
    icon: [{ url: '/favicon.png', sizes: '32x32', type: 'image/png' }],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
};
export const viewport: Viewport = { themeColor: '#161511' };
export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}
export const dynamicParams = false;
export default async function RootLayout({
  children,
  params,
}: {
  children: ReactNode;
} & LocalePageProps) {
  const locale = await resolveLocale(params);
  const t = getTranslator(locale);
  return (
    <html
      lang={locale}
      data-scroll-behavior="smooth"
      className={`${dmSans.variable} ${manrope.variable}`}
    >
      <head>
        {process.env.NODE_ENV === 'production' && !isPreview && (
          <script src="/_fm/script.js?siteId=61b021a9d037" defer />
        )}
      </head>
      <body>
        <a
          className={`skip-link p-[12px] fixed top-[-100px] z-[100] text-[#111] bg-gold focus:top-[10px]`}
          href="#main"
        >
          {t('Skip to content')}
        </a>
        <SiteHeader locale={locale} />
        {children}
        <SiteFooter locale={locale} />
      </body>
    </html>
  );
}
