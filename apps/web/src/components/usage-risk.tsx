import { getTranslator, type Locale } from '../i18n';

export function UsageRisk({ locale, centered = false }: { locale: Locale; centered?: boolean }) {
  const t = getTranslator(locale);
  return (
    <aside
      className={`usage-risk mt-[14px] max-w-[440px] text-[12px] leading-[1.6] text-[#b8ad99] ${centered ? 'mx-auto' : ''}`}
    >
      <strong className="text-[#ddd3c2]">{t('Use at your own risk.')}</strong>{' '}
      {t(
        'We don’t know whether Blizzard permits Wisp or whether using it could lead to an account ban.',
      )}
    </aside>
  );
}
