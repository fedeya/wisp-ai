import { getTranslator, localizedPath, type Locale } from '../i18n';
import Link from 'next/link';
import { Icon } from './icon';
import { site } from '../site';
export function SiteFooter({ locale }: { locale: Locale }) {
  const t = getTranslator(locale);
  return (
    <footer className="site-footer site-container">
      <div>
        <a href={site.repository}>
          {t('Source code ')}
          <Icon name="external" size={12} />
        </a>
        <a href={`${site.repository}/issues`}>
          {t('Feedback ')}
          <Icon name="external" size={12} />
        </a>
        <Link href={localizedPath(locale, '/setup#privacy')}>{t('Privacy & controls')}</Link>
      </div>
      <p>
        {t('Made by ')}
        <a href="https://fedeminaya.com">{t('fedeya')}</a>
        {t(' · GPL-3.0')}
      </p>
      <small>{t('Not affiliated with Blizzard Entertainment or any AI provider.')}</small>
    </footer>
  );
}
