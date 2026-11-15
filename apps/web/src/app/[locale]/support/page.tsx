import Image from 'next/image';
import { Icon } from '../../../components/icon';
import { PageSchema } from '../../../components/page-schema';
import { containerClassName } from '../../../components/ui';
import { ButtonLink } from '../../../components/ui/button-link';
import { getTranslator } from '../../../i18n';
import { resolveLocale, type LocalePageProps } from '../../../i18n/server';
import { pageMetadata } from '../../../seo';
import { site } from '../../../site';

const title = 'Support Wisp';
const description = 'Help me keep Wisp and its addon up to date for WoW: Forever.';

export async function generateMetadata({ params }: LocalePageProps) {
  const locale = await resolveLocale(params);
  const t = getTranslator(locale);
  return pageMetadata(t(title), t(description), '/support', locale);
}

export default async function Support({ params }: LocalePageProps) {
  const locale = await resolveLocale(params);
  const t = getTranslator(locale);

  return (
    <main id="main" className={`${containerClassName} max-w-[700px] py-12 text-center md:py-20`}>
      <PageSchema title={t(title)} description={t(description)} path="/support" locale={locale} />
      <Image
        src="/wisp.png"
        width={82}
        height={82}
        alt=""
        className="mb-5 [filter:drop-shadow(0_0_24px_#7eabda50)]"
      />
      <h1 className="text-[clamp(40px,7vw,68px)] leading-[1.08] tracking-[-1.6px]">{t(title)}</h1>
      <p className="mx-auto mt-5 max-w-[520px] text-[16px] leading-[1.75] text-pretty text-muted">
        {t(
          'If Wisp has helped you in Azeroth, your support gives me more time to fix bugs, improve the addon and keep it up to date with WoW: Forever.',
        )}
      </p>
      <section className="mx-auto mt-8 max-w-[485px] rounded-md border border-solid border-[#c4a16a38] bg-[#c4a16a0a] px-5 py-7 md:mt-10 md:px-8 md:py-8">
        <h2 className="text-[26px] tracking-[-0.4px]">GitHub Sponsors</h2>
        <p className="mt-2 text-[14px] leading-[1.65] text-muted">
          {t('Make a one-time or monthly contribution with your GitHub account.')}
        </p>
        <ButtonLink href={site.sponsor} className="mt-5 max-w-full">
          {t('Contribute on GitHub')}
          <Icon name="external" size={16} />
        </ButtonLink>
      </section>
    </main>
  );
}
