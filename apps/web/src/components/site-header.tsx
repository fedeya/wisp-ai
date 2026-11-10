'use client';
import { containerClassName, navigationLinkClassName, link, headerShell } from './ui';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from './icon';
import { getTranslator, localizedPath, stripLocale, type Locale } from '../i18n';
import { site } from '../site';
import { LanguageSwitch } from './language-switch';

export function SiteHeader({ locale }: { locale: Locale }) {
  const t = getTranslator(locale);
  const pathname = stripLocale(usePathname());
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const marker = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setScrolled(!entry.isIntersecting));
    if (marker.current) {
      observer.observe(marker.current);
    }
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const frame = requestAnimationFrame(() => menu.current?.querySelector('a')?.focus());
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !menu.current?.contains(event.target) &&
        !menuButton.current?.contains(event.target)
      ) {
        setMenuOpen(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        menuButton.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [menuOpen]);

  return (
    <>
      <div
        className="pointer-events-none absolute top-0 left-0 h-[24px] w-px"
        ref={marker}
        aria-hidden="true"
      />
      <div className={headerShell({ opaque: scrolled || menuOpen })}>
        <header
          className={`${containerClassName} relative z-[5] flex h-[64px] items-center justify-between gap-2 md:h-[82px]`}
        >
          <Link
            href={localizedPath(locale, '/')}
            className="flex items-center gap-[3px] font-brand text-[22px] font-extrabold tracking-[-1px] sm:gap-[5px] sm:text-[24px] md:text-[27px]"
            aria-label={t('wispai home')}
            onClick={() => setMenuOpen(false)}
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
          <nav
            ref={menu}
            id={menuId}
            aria-label={t('Main navigation')}
            className={`${menuOpen ? 'flex' : 'hidden'} absolute inset-x-0 top-[calc(100%_+_6px)] flex-col gap-0.5 rounded-md border border-solid border-[#b69d6940] bg-[#1d1c18] p-2 text-[#cec7ba] shadow-[0_12px_32px_#0006] md:static md:flex md:flex-row md:gap-8 md:border-0 md:bg-transparent md:p-0 md:shadow-none`}
            onBlur={(event) => {
              // Touch browsers can blur before clicking; close only for a known
              // focus destination. The outside pointer handler covers taps.
              if (
                event.relatedTarget !== null &&
                !event.currentTarget.contains(event.relatedTarget) &&
                !menuButton.current?.contains(event.relatedTarget)
              ) {
                setMenuOpen(false);
              }
            }}
          >
            <Link
              className={navigationLinkClassName}
              href={localizedPath(locale, '/features')}
              aria-current={pathname === '/features' ? 'page' : undefined}
              onClick={() => setMenuOpen(false)}
            >
              {t('Features')}
            </Link>
            <Link
              className={navigationLinkClassName}
              href={localizedPath(locale, '/setup')}
              aria-current={pathname === '/setup' ? 'page' : undefined}
              onClick={() => setMenuOpen(false)}
            >
              {t('Get started')}
            </Link>
            <a
              className={navigationLinkClassName}
              href={site.repository}
              onClick={() => setMenuOpen(false)}
            >
              GitHub <Icon name="external" size={12} />
            </a>
          </nav>
          <div className="flex items-center gap-[6px] md:gap-[19px]">
            <LanguageSwitch locale={locale} />
            <a className={link({ intent: 'outline' })} href={site.download}>
              {t('Get Wisp ')}
              <Icon name="download" size={15} />
            </a>
            <button
              ref={menuButton}
              type="button"
              className="inline-flex h-[36px] w-[30px] shrink-0 cursor-pointer items-center justify-center rounded border border-solid border-transparent bg-transparent p-0 text-[#c8b48e] aria-expanded:border-[#c4aa703b] aria-expanded:bg-[#c4aa7010] md:hidden"
              aria-label={menuOpen ? t('Close navigation') : t('Open navigation')}
              aria-expanded={menuOpen}
              aria-controls={menuId}
              onClick={() => setMenuOpen((value) => !value)}
            >
              <Icon name={menuOpen ? 'close' : 'menu'} size={20} />
            </button>
          </div>
        </header>
      </div>
    </>
  );
}
