'use client';
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
      <div className="header-scroll-marker" ref={marker} aria-hidden="true" />
      <div
        className={`site-header-shell ${scrolled ? 'is-scrolled' : ''} ${menuOpen ? 'nav-open' : ''}`}
      >
        <header className="site-header container">
          <Link
            href={localizedPath(locale, '/')}
            className="wordmark"
            aria-label={t('wispai home')}
            onClick={() => setMenuOpen(false)}
          >
            <Image src="/wisp.png" width={35} height={35} alt="" loading="eager" />
            wisp<span>ai</span>
          </Link>
          <nav
            ref={menu}
            id={menuId}
            aria-label={t('Main navigation')}
            onBlur={(event) => {
              // Touch browsers can blur the focused link before dispatching a click.
              // Only close for a known focus destination; outside taps are handled above.
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
              href={localizedPath(locale, '/features')}
              aria-current={pathname === '/features' ? 'page' : undefined}
              onClick={() => setMenuOpen(false)}
            >
              {t('Features')}
            </Link>
            <Link
              href={localizedPath(locale, '/setup')}
              aria-current={pathname === '/setup' ? 'page' : undefined}
              onClick={() => setMenuOpen(false)}
            >
              {t('Get started')}
            </Link>
            <a href={site.repository} onClick={() => setMenuOpen(false)}>
              GitHub <Icon name="external" size={12} />
            </a>
          </nav>
          <div className="header-actions">
            <LanguageSwitch locale={locale} />
            <a
              className="button nav-download"
              href={site.download}
              data-rybbit-event="download_clicked"
              data-rybbit-prop-source="header"
            >
              {t('Get Wisp ')}
              <Icon name="download" size={15} />
            </a>
            <button
              ref={menuButton}
              type="button"
              className="mobile-nav-toggle"
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
