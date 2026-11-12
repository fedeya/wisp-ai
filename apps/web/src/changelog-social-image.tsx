import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';
import type { PublishedRelease } from './changelog.server';
import type { Locale } from './i18n';
import { site } from './site';

export async function changelogSocialImage(locale: Locale, release?: PublishedRelease) {
  const [icon, serif, sans] = await Promise.all([
    readFile(join(process.cwd(), 'public/wisp.png')),
    readFile(join(process.cwd(), 'src/assets/fonts/Gelasio-Regular.ttf')),
    readFile(join(process.cwd(), 'node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf')),
  ]);
  const es = locale === 'es';
  const section = es ? 'Novedades' : 'Changelog';
  const [version, build] = release?.title.split('-') ?? [];
  const channel = release?.channel === 'nightly' ? 'Nightly' : 'Stable';
  const date = release
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(
        new Date(release.date),
      )
    : null;
  const gold = '#d6b777';
  const muted = '#aaa397';

  return new ImageResponse(
    <div
      style={{
        display: 'flex',
        width: '100%',
        height: '100%',
        position: 'relative',
        color: '#efe8da',
        background: 'radial-gradient(circle at 76% 56%, #30271a 0%, #1e1912 20%, #12110f 45%)',
        fontFamily: 'Geist',
      }}
    >
      {[122, 516].map((top) => (
        <div
          key={top}
          style={{
            display: 'flex',
            position: 'absolute',
            top,
            right: 80,
            left: 80,
            height: 1,
            background: '#d8c5a522',
          }}
        />
      ))}
      <img
        src={`data:image/png;base64,${icon.toString('base64')}`}
        alt=""
        width={374}
        height={374}
        style={{
          position: 'absolute',
          left: 727,
          top: 133,
        }}
      />
      <div
        style={{
          display: 'flex',
          position: 'absolute',
          top: 76,
          bottom: 70,
          right: 80,
          left: 80,
          flexDirection: 'column',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ color: gold, fontSize: 20, letterSpacing: 4 }}>WISP AI</span>
          {release && <span style={{ color: muted, fontSize: 20 }}>{section}</span>}
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            maxWidth: 600,
          }}
        >
          <span
            style={{
              fontFamily: 'Gelasio',
              fontSize: version ? Math.min(112, Math.floor(980 / version.length)) : 100,
              letterSpacing: -4,
              lineHeight: 1.07,
            }}
          >
            {version ?? section}
          </span>
          {build && <span style={{ fontSize: 34, lineHeight: 1.1, color: muted }}>-{build}</span>}
          {release ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 24, marginTop: 26 }}>
              <span style={{ color: gold, fontSize: 18, letterSpacing: 2 }}>
                {channel.toUpperCase()}
              </span>
              <span style={{ color: muted, fontSize: 22 }}>{date}</span>
            </div>
          ) : (
            <span style={{ color: muted, fontSize: 27, marginTop: 18, maxWidth: 430 }}>
              {es
                ? 'Nuevas funciones, mejoras y correcciones.'
                : 'New features, improvements and fixes.'}
            </span>
          )}
        </div>
        <span style={{ color: muted, fontSize: 20 }}>{new URL(site.url).hostname}</span>
      </div>
    </div>,
    {
      width: 1200,
      height: 630,
      fonts: [
        { name: 'Gelasio', data: serif, weight: 400, style: 'normal' },
        { name: 'Geist', data: sans, weight: 400, style: 'normal' },
      ],
      headers: { 'Cache-Control': 'public, max-age=0, must-revalidate' },
    },
  );
}
