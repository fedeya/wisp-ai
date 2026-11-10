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
      <Menu.Trigger
        className="group inline-flex min-h-[38px] cursor-pointer appearance-none items-center gap-[5px] rounded border border-solid border-transparent bg-transparent px-1 py-0 text-[11px] text-[#b5a68a] hover:text-gold aria-expanded:border-[#b89d6338] aria-expanded:bg-[#b89d630a] aria-expanded:text-gold md:gap-[6px] md:px-2 [&_svg]:shrink-0"
        aria-label={label}
      >
        <Icon name="globe" size={15} />
        <span>{locale.toUpperCase()}</span>
        <span className="inline-flex rotate-90 transition-transform group-data-[popup-open]:-rotate-90 motion-reduce:transition-none">
          <Icon name="chevron-right" size={11} />
        </span>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={7} align="end" className="z-[60]">
          <Menu.Popup
            className="m-0 w-[154px] list-none rounded-md border border-solid border-[#aa916044] bg-[#201e19] p-[5px] shadow-[0_12px_35px_#0006]"
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
                    className="flex min-h-[39px] items-center justify-between gap-4 rounded-[3px] px-3 py-[10px] text-[12px] text-[#c8beab] transition-colors duration-150 hover:bg-[#bca16e12] hover:text-[#f0dec0] focus-visible:bg-[#bca16e12] focus-visible:text-[#f0dec0] data-highlighted:bg-[#bca16e12] data-highlighted:text-[#f0dec0] aria-[current=true]:text-gold"
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
