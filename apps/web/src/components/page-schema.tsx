import { site } from '../site';
import { descriptions, localizedPath, type Locale } from '../i18n';

export function PageSchema({
  title,
  description,
  path,
  software = false,
  softwareVersion,
  locale = 'en',
}: {
  title: string;
  description: string;
  path: string;
  software?: boolean;
  softwareVersion?: string;
  locale?: Locale;
}) {
  const url = `${site.url}${localizedPath(locale, path)}`;
  const graph: Record<string, unknown>[] = [
    {
      '@type': 'WebSite',
      '@id': `${site.url}/#website`,
      name: site.name,
      url: site.url,
      inLanguage: ['en', 'es'],
    },
    {
      '@type': 'WebPage',
      '@id': `${url}#webpage`,
      url,
      name: title,
      description: software ? descriptions[locale] : description,
      inLanguage: locale,
      isPartOf: { '@id': `${site.url}/#website` },
      about: { '@id': `${site.url}/#software` },
    },
  ];
  if (software) {
    graph.push({
      '@type': 'SoftwareApplication',
      '@id': `${site.url}/#software`,
      name: site.name,
      url: site.url,
      description: descriptions[locale],
      applicationCategory: 'GameApplication',
      operatingSystem: 'Windows',
      softwareVersion,
      downloadUrl: new URL(site.download, site.url).href,
      license: `${site.repository}/blob/main/LICENSE`,
      sameAs: [site.repository, site.curseForge],
      image: `${site.url}${localizedPath(locale, '/opengraph-image')}`,
    });
  }
  if (path !== '/') {
    graph.push({
      '@type': 'BreadcrumbList',
      itemListElement: [
        {
          '@type': 'ListItem',
          position: 1,
          name: 'Wisp AI',
          item: `${site.url}${localizedPath(locale)}`,
        },
        { '@type': 'ListItem', position: 2, name: title, item: url },
      ],
    });
  }
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(
          /</g,
          '\\u003c',
        ),
      }}
    />
  );
}
