import { changelogStyles } from '../../../components/ui/changelog';
import Link from 'next/link';
import { getReleaseHistory } from '../../../changelog.server';
import { ReleaseCard } from '../../../components/release-card';
import { localizedPath } from '../../../i18n';
import { resolveLocale, type LocalePageProps } from '../../../i18n/server';
import { pageMetadata } from '../../../seo';
import { site } from '../../../site';
import { Icon } from '../../../components/icon';

export async function generateMetadata({ params }: LocalePageProps) {
  const locale = await resolveLocale(params);
  return pageMetadata(
    locale === 'es' ? 'Novedades — Wisp AI' : 'Changelog — Wisp AI',
    locale === 'es'
      ? 'Las novedades, mejoras y correcciones de Wisp.'
      : 'New features, improvements and fixes in Wisp.',
    '/changelog',
    locale,
  );
}
export default async function Changelog({
  params,
  searchParams,
}: LocalePageProps & { searchParams: Promise<{ channel?: string; page?: string }> }) {
  const locale = await resolveLocale(params);
  const query = await searchParams;
  const channel = query.channel === 'nightly' ? 'nightly' : 'stable';
  const page = /^\d{1,4}$/.test(query.page || '') ? Math.max(1, Number(query.page)) : 1;
  const history = await getReleaseHistory(channel, page);
  const path = localizedPath(locale, '/changelog');
  const es = locale === 'es';
  const styles = changelogStyles();
  return (
    <main id="main" className={styles.page()}>
      <header className={styles.intro()}>
        <span className={styles.eyebrow()}>{es ? 'EL DIARIO DE WISP' : 'THE WISP JOURNAL'}</span>
        <h1 className={styles.heading()}>
          {es ? 'Cada vez más compañero.' : 'A better companion, every update.'}
        </h1>
        <p className={styles.lead()}>
          {es
            ? 'Nuevas ideas, pequeños detalles y mejoras para tus aventuras en Azeroth.'
            : 'New ideas, thoughtful details and improvements for your adventures in Azeroth.'}
        </p>
      </header>
      <nav className={styles.tabs()} aria-label={es ? 'Canal de versiones' : 'Release channel'}>
        <Link
          className={styles.tab()}
          href={path}
          aria-current={channel === 'stable' ? 'page' : undefined}
        >
          Stable
        </Link>
        <Link
          className={styles.tab()}
          href={`${path}?channel=nightly`}
          aria-current={channel === 'nightly' ? 'page' : undefined}
        >
          Nightly
        </Link>
      </nav>
      {channel === 'nightly' && history.releases.length > 0 && (
        <p className={styles.notice()}>
          {es
            ? 'Probá las últimas novedades antes de que lleguen a Stable. Estas versiones pueden contener errores.'
            : 'Try the latest changes before they reach Stable. These builds may contain bugs.'}
        </p>
      )}
      {history.releases.map((release) => (
        <ReleaseCard key={release.version} release={release} locale={locale} />
      ))}
      {!history.releases.length && (
        <div className={styles.empty()}>
          <h2 className={styles.emptyHeading()}>
            {history.unavailable
              ? es
                ? 'No pudimos cargar las novedades'
                : 'We couldn’t load the updates'
              : channel === 'nightly' && page === 1
                ? es
                  ? 'Las próximas aventuras empiezan acá.'
                  : 'The next adventure starts here.'
                : es
                  ? 'Todavía no hay versiones para mostrar.'
                  : 'No releases to show yet.'}
          </h2>
          <p>
            {!history.unavailable && channel === 'nightly' && page === 1
              ? es
                ? 'Cuando esté disponible la primera Nightly, vas a encontrarla acá. Mientras tanto, disfrutá de la última versión estable.'
                : 'The first Nightly will appear here when it’s ready. Until then, the latest stable release is ready for your next adventure.'
              : es
                ? 'Podés consultar las versiones publicadas en GitHub.'
                : 'You can find published releases on GitHub.'}
          </p>
          {!history.unavailable && channel === 'nightly' && page === 1 ? (
            <Link className={styles.textLink()} href={path}>
              {es ? 'Ver novedades de Stable' : 'Explore Stable updates'}{' '}
              <Icon name="arrow" size={16} />
            </Link>
          ) : (
            <a className={styles.textLink()} href={`${site.repository}/releases`}>
              GitHub Releases <Icon name="external" size={16} />
            </a>
          )}
        </div>
      )}
      {(page > 1 || history.more) && (
        <nav
          className={styles.pagination()}
          aria-label={es ? 'Páginas del historial' : 'Release history pages'}
        >
          {page > 1 && (
            <Link
              className={styles.textLink()}
              href={`${path}?channel=${channel}&page=${page - 1}`}
            >
              <Icon name="arrow-left" size={16} /> {es ? 'Más recientes' : 'Newer'}
            </Link>
          )}
          <span className={styles.pageNumber()}>
            {es ? 'Página' : 'Page'} {page}
          </span>
          {history.more && (
            <Link
              className={styles.textLink()}
              href={`${path}?channel=${channel}&page=${history.nextPage}`}
            >
              {es ? 'Anteriores' : 'Older'} <Icon name="arrow" size={16} />
            </Link>
          )}
        </nav>
      )}
    </main>
  );
}
