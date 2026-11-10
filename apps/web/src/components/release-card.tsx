import Link from 'next/link';
import { renderReleaseNotes } from '@wisp/releases';
import { localizedPath, type Locale } from '../i18n';
import type { PublishedRelease } from '../changelog.server';
import { Icon } from './icon';
import { ButtonLink } from './ui/button-link';
import { changelogStyles } from './ui/changelog';

export function ReleaseCard({
  release,
  locale,
  detail = false,
}: {
  release: PublishedRelease;
  locale: Locale;
  detail?: boolean;
}) {
  const notes = release.notes.replace(/^# .+\r?\n/, '').trim();
  const styles = changelogStyles();
  return (
    <article className={styles.entry()}>
      <aside className={styles.stamp()}>
        <span className={styles.channel()}>
          {release.channel === 'nightly' ? 'Nightly' : 'Stable'}
        </span>
        <time className={styles.date()} dateTime={release.date}>
          {new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(
            new Date(release.date),
          )}
        </time>
      </aside>
      <div>
        {!detail && (
          <h2 className={styles.title()}>
            <Link
              className={styles.titleLink()}
              href={localizedPath(locale, `/changelog/${release.version}`)}
            >
              {release.title}
              <span className={styles.titleArrow()}>
                <Icon name="arrow" size={22} />
              </span>
            </Link>
          </h2>
        )}
        <div
          className={styles.prose()}
          dangerouslySetInnerHTML={{ __html: renderReleaseNotes(notes) }}
        />
        <div className={styles.links()}>
          {release.downloads.map((download) => (
            <ButtonLink
              intent="outline"
              className={styles.download()}
              href={download.url}
              key={download.url}
            >
              <Icon name="download" size={17} />
              {locale === 'es' ? 'Descargar para' : 'Download for'} {download.label}
            </ButtonLink>
          ))}
          <a className={styles.textLink()} href={release.url}>
            GitHub <Icon name="external" size={16} />
          </a>
        </div>
      </div>
    </article>
  );
}
