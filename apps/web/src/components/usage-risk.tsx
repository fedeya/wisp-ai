import { getTranslator, localizedPath, type Locale } from '../i18n';
import type { SafetyDetails } from '../analytics';
import { SafetyLink } from './safety-link';

export function UsageRisk({
  locale,
  location,
  centered = false,
}: {
  locale: Locale;
  location: SafetyDetails['location'];
  centered?: boolean;
}) {
  const t = getTranslator(locale);
  return (
    <aside
      className={`usage-risk mt-[14px] max-w-[440px] text-[12px] leading-[1.6] text-[#b8ad99] ${centered ? 'mx-auto' : ''}`}
    >
      <strong className="text-[#ddd3c2]">{t('Use at your own risk.')}</strong>{' '}
      {t('Wisp is an addon: you stay in control of movement, combat and trading.')}{' '}
      <SafetyLink
        href={location === 'setup' ? '#safety' : localizedPath(locale, '/setup#safety')}
        location={location}
        locale={locale}
      >
        {t('Is it safe?')}
      </SafetyLink>
    </aside>
  );
}
