'use client';

import { Menu } from '@base-ui/react/menu';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { localizedPath, stripLocale, type Locale } from '../i18n/config';
import { Icon } from './icon';

export function LanguageSwitch({ locale }: { locale: Locale }) {
  const path = stripLocale(usePathname());
  const [suffix, setSuffix] = useState('');
  const label = locale === 'es' ? 'ES — Idioma: Español' : 'EN — Language: English';

  return (
    <Menu.Root
      onOpenChange={(open) => {
        if (open) {
          setSuffix(window.location.search + window.location.hash);
        }
      }}
    >
      <Menu.Trigger className="language-switch group" aria-label={label}>
        <Icon name="globe" size={15} />
        <span>{locale.toUpperCase()}</span>
        <span className="inline-flex rotate-90 transition-transform group-data-[popup-open]:-rotate-90 motion-reduce:transition-none">
          <Icon name="chevron-right" size={11} />
        </span>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={7} align="end" className="z-[60]">
          <Menu.Popup
            className="language-options"
            aria-label={locale === 'es' ? 'Idioma del sitio' : 'Site language'}
          >
            {(['en', 'es'] as const).map((language) => (
              <Menu.Item
                key={language}
                render={
                  <Link
                    href={localizedPath(language, path) + suffix}
                    hrefLang={language}
                    lang={language}
                    scroll={false}
                  />
                }
                aria-current={locale === language ? 'true' : undefined}
                onClick={(event) => {
                  document.cookie =
                    'wisp-locale=' +
                    language +
                    '; Path=/; Max-Age=31536000; SameSite=Lax' +
                    (location.protocol === 'https:' ? '; Secure' : '');
                  if (language === locale) {
                    event.preventDefault();
                  }
                }}
              >
                <span>{language === 'es' ? 'Español' : 'English'}</span>
                {locale === language && <Icon name="check" size={14} />}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
