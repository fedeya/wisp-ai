import { changelogStyles } from '../../../../components/ui/changelog';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getPublishedRelease } from '../../../../changelog.server';
import { ReleaseCard } from '../../../../components/release-card';
import { localizedPath } from '../../../../i18n';
import { resolveLocale } from '../../../../i18n/server';
import { pageMetadata } from '../../../../seo';
import { Icon } from '../../../../components/icon';

type Props = { params: Promise<{ locale: string; version: string }> };
export const dynamicParams = true;
export async function generateMetadata({ params }: Props) {
  const locale = await resolveLocale(params);
  const { version } = await params;
  const release = await getPublishedRelease(version);
  return pageMetadata(
    release ? `${release.title} — Wisp AI` : 'Wisp changelog',
    `Wisp ${version}`,
    `/changelog/${version}`,
    locale,
  );
}
export default async function ReleasePage({ params }: Props) {
  const locale = await resolveLocale(params);
  const { version } = await params;
  const release = await getPublishedRelease(version);
  if (!release) {
    notFound();
  }
  const styles = changelogStyles();
  return (
    <main id="main" className={styles.page()}>
      <header className={styles.intro()}>
        <Link
          className={styles.textLink({ class: styles.backLink() })}
          href={localizedPath(
            locale,
            `/changelog${release.channel === 'nightly' ? '?channel=nightly' : ''}`,
          )}
        >
          <Icon name="arrow-left" size={16} />{' '}
          {locale === 'es' ? 'Todas las novedades' : 'All updates'}
        </Link>
        <h1 className={styles.heading()}>{release.title}</h1>
      </header>
      <ReleaseCard release={release} locale={locale} detail />
    </main>
  );
}
