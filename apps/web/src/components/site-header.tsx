'use client';
import { Dialog } from '@base-ui/react/dialog';
import { containerClassName } from './ui';
import { DownloadLink } from './download-link';
import { NavigationLink } from './ui/navigation-link';
import { HeaderShell } from './ui/header-shell';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Icon } from './icon';
import { getTranslator, localizedPath, stripLocale, type Locale } from '../i18n';
import { site } from '../site';
import { LanguageSwitch } from './language-switch';

const menuButtonClassName =
  'inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded border border-solid border-transparent bg-transparent p-0 text-[#c8b48e] hover:border-line hover:text-gold';

export function SiteHeader({ locale, version }: { locale: Locale; version?: string }) {
  const t = getTranslator(locale);
  const pathname = stripLocale(usePathname());
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const marker = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setScrolled(!entry.isIntersecting));
    if (marker.current) {
      observer.observe(marker.current);
    }
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    // Match the site's md breakpoint, where the inline navigation takes over.
    const desktop = window.matchMedia('(min-width: 761px)');
    const closeOnDesktop = (event: MediaQueryListEvent) => {
      if (event.matches) {
        setMenuOpen(false);
      }
    };
    desktop.addEventListener('change', closeOnDesktop);
    return () => desktop.removeEventListener('change', closeOnDesktop);
  }, []);

  const closeMenu = () => setMenuOpen(false);
  const homeLink = (
    <Link
      href={localizedPath(locale, '/')}
      className="flex items-center gap-[3px] font-brand text-[22px] font-extrabold tracking-[-1px] sm:gap-[5px] sm:text-[24px] md:text-[27px]"
      aria-label={t('wispai home')}
      onClick={closeMenu}
    >
      <Image
        src="/wisp.png"
        width={35}
        height={35}
        className="h-[28px] w-[28px] sm:h-[35px] sm:w-[35px]"
        alt=""
        loading="eager"
      />
      wisp
      <span className="mt-2 ml-px font-body text-[12px] [line-height:normal] font-normal tracking-[-1px] text-gold">
        ai
      </span>
    </Link>
  );
  const navigationLinks = (
    <>
      <NavigationLink
        href={localizedPath(locale, '/features')}
        aria-current={pathname === '/features' ? 'page' : undefined}
        onClick={closeMenu}
      >
        {t('Features')}
      </NavigationLink>
      <NavigationLink
        href={localizedPath(locale, '/setup')}
        aria-current={pathname === '/setup' ? 'page' : undefined}
        onClick={closeMenu}
      >
        {t('Get started')}
      </NavigationLink>
      <NavigationLink
        href={localizedPath(locale, '/changelog')}
        aria-current={pathname.startsWith('/changelog') ? 'page' : undefined}
        onClick={closeMenu}
      >
        {locale === 'es' ? 'Novedades' : 'Changelog'}
      </NavigationLink>
      <NavigationLink external href={site.repository} onClick={closeMenu}>
        GitHub <Icon name="external" size={12} />
      </NavigationLink>
    </>
  );

  return (
    <Dialog.Root open={menuOpen} onOpenChange={setMenuOpen}>
      <div
        className="pointer-events-none absolute top-0 left-0 h-[24px] w-px"
        ref={marker}
        aria-hidden="true"
      />
      <HeaderShell opaque={scrolled}>
        <header
          className={`${containerClassName} relative z-[5] flex h-[64px] items-center justify-between gap-2 md:h-[82px]`}
        >
          {homeLink}
          <nav aria-label={t('Main navigation')} className="hidden gap-8 text-[#cec7ba] md:flex">
            {navigationLinks}
          </nav>
          <div className="flex items-center gap-[6px] md:gap-[19px]">
            <LanguageSwitch locale={locale} />
            <DownloadLink
              intent="outline"
              href={site.download}
              location="header"
              locale={locale}
              version={version}
            >
              {t('Get Wisp ')}
              <Icon name="download" size={15} />
            </DownloadLink>
            <Dialog.Trigger
              className={`${menuButtonClassName} md:hidden`}
              aria-label={t('Open navigation')}
            >
              <Icon name="menu" size={20} />
            </Dialog.Trigger>
          </div>
        </header>
      </HeaderShell>
      <Dialog.Portal>
        <Dialog.Popup className="fixed inset-0 z-[70] h-dvh overflow-y-auto overscroll-contain bg-canvas text-foreground">
          <Dialog.Title className="sr-only">{t('Main navigation')}</Dialog.Title>
          <div className="border-0 border-b border-solid border-line">
            <div className={`${containerClassName} flex h-[64px] items-center justify-between`}>
              {homeLink}
              <Dialog.Close className={menuButtonClassName} aria-label={t('Close navigation')}>
                <Icon name="close" size={20} />
              </Dialog.Close>
            </div>
          </div>
          <nav
            aria-label={t('Main navigation')}
            className={`${containerClassName} flex flex-col gap-1 py-6 [&>a]:min-h-14 [&>a]:gap-2 [&>a]:text-xl [&>a]:font-medium`}
          >
            {navigationLinks}
          </nav>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
