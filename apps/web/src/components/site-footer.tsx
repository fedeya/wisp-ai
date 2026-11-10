import { containerClassName } from './ui';

import { getTranslator, localizedPath, type Locale } from '../i18n';
import Link from 'next/link';
import { Icon } from './icon';
import { site } from '../site';
export function SiteFooter({ locale }: { locale: Locale }) {
  const t = getTranslator(locale);
  return (
    <footer
      className={`${containerClassName} site-footer gap-[20px] border-t-[1px] [border-top-style:solid] border-t-[var(--line)] pt-[28px] pb-[32px] flex flex-wrap justify-between text-[#8d8577] text-[10px] md:gap-[23px] md:text-[11px] [&_a:hover]:text-gold [&_svg]:shrink-0`}
    >
      <div className="gap-[20px] flex md:gap-[25px]">
        <a href={site.repository} className="gap-[5px] inline-flex items-center">
          {t('Source code ')}
          <Icon name="external" size={12} />
        </a>
        <a href={`${site.repository}/issues`} className="gap-[5px] inline-flex items-center">
          {t('Feedback ')}
          <Icon name="external" size={12} />
        </a>
        <Link
          href={localizedPath(locale, '/setup#privacy')}
          className="gap-[5px] inline-flex items-center"
        >
          {t('Privacy & controls')}
        </Link>
      </div>
      <p>
        {t('Made by ')}
        <a href="https://fedeminaya.com">{t('fedeya')}</a>
        {t(' · GPL-3.0')}
      </p>
      <small className="block w-full text-[9px] text-[#9e9585]">
        {t('Not affiliated with Blizzard Entertainment or any AI provider.')}
      </small>
    </footer>
  );
}
