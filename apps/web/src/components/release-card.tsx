import Link from 'next/link';
import { renderReleaseNotes } from '@wisp/releases';
import { localizedPath, type Locale } from '../i18n';
import type { PublishedRelease } from '../changelog.server';
import { Icon } from './icon';

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
  return (
    <article className="release-entry">
      <aside className="release-stamp">
        <span className={`channel-pill ${release.channel}`}>
          {release.channel === 'nightly' ? 'Nightly' : 'Stable'}
        </span>
        <time dateTime={release.date}>
          {new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(
            new Date(release.date),
          )}
        </time>
      </aside>
      <div className="release-content">
        {!detail && (
          <h2>
            <Link href={localizedPath(locale, `/changelog/${release.version}`)}>
              {release.title}
              <Icon name="arrow" size={22} />
            </Link>
          </h2>
        )}
        <div
          className="release-prose"
          dangerouslySetInnerHTML={{ __html: renderReleaseNotes(notes) }}
        />
        <div className="release-links">
          {release.downloads.map((download) => (
            <a className="button release-download" href={download.url} key={download.url}>
              <Icon name="download" size={17} />
              {locale === 'es' ? 'Descargar para' : 'Download for'} {download.label}
            </a>
          ))}
          <a className="text-link" href={release.url}>
            GitHub <Icon name="external" size={16} />
          </a>
        </div>
      </div>
    </article>
  );
}
