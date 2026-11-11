# Website languages

Wisp's website is available in English and Spanish, including Home, Features,
Setup, the animated conversations and controls, metadata and social cards.

## URLs and language choice

- English: `/en`, `/en/features`, `/en/setup`.
- Spanish: `/es`, `/es/features`, `/es/setup`.
- `/`, `/features` and `/setup` redirect to the preferred version with HTTP 307.
  A saved `wisp-locale` preference takes priority over `Accept-Language`.
  Region tags such as `es-AR`, `es-MX` and `en-US` match their base language;
  quality weights are respected. Unsupported language preferences fall back to
  English. Explicit `/es` and `/en` links always retain their requested locale.
- The globe/EN/ES selector opens both language options and marks the current one. It changes the current page's language, preserves query
  parameters and anchors without a document reload (Next Link navigation), and stores the choice in a one-year SameSite=Lax
  preference cookie (Secure on HTTPS). No translation service runs. Production
  pages load Rybbit analytics through the first-party `/_fm/` proxy and PostHog
  for pageviews and download clicks. Both are disabled in development and previews.
- Language-negotiating redirects are private/no-store and vary by language and
  cookie. Assets, sitemap and robots are not subject to locale negotiation.

Next.js App Router uses `app/[locale]`, `generateStaticParams` and `src/proxy.ts`.
All six content pages are prerendered. Spanish content is present in the initial
HTML, including with JavaScript disabled; it is not a client-side text swap.
The root layout emits the correct `html lang`, fonts and shared navigation.

## Translations

English source copy is the dictionary key. `src/i18n/es.json` holds Spanish
translations; `getTranslator` preserves surrounding inline whitespace and
`translateData` localizes static copy collections. Unmapped names fall back to
the source. Keep technical identifiers, URLs and product names unchanged.

The copy uses Latin American Spanish with voseo. In Setup, labels of actual
English desktop controls (for example Overview, Connections, Continue with
ChatGPT and Set default) deliberately remain as displayed in the app. Macro
examples use localized spell names in Spanish; real macro creation resolves the
character's learned spell names rather than assuming website and game locale
are identical.

Add new UI copy to the English source and its exact source/translation pair to
`es.json`. Route/locale helpers that do not need copy import `i18n/config` to
avoid loading the translation dictionary. No new i18n runtime dependency is used.

## Search engines

Both languages have self-canonicals, reciprocal `hreflang=en/es` links and
`x-default=en`, their own Open Graph URLs/titles, translated social images and
localized JSON-LD. `/sitemap.xml` lists all six URLs with language alternates.
The production robots policy and preview noindex protection apply to both.

Browser QA checks region/quality negotiation, manual selection and persistence,
anchors, all six server-rendered pages, language metadata, sitemap, both social
images, no-JS rendering, and layouts between 320 and 1440 pixels. Spanish macro
and routine animations were also checked for clipped content at desktop, tablet
and phone widths.
