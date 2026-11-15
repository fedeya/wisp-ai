/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  skipTrailingSlashRedirect: true,
  async redirects() {
    return [
      {
        // Keep canonical URLs while preserving the trailing slash on PostHog requests.
        source: '/:path((?!_wa(?:/|$)).+)/',
        destination: '/:path',
        permanent: true,
      },
    ];
  },
  async rewrites() {
    // Match the portfolio's first-party Rybbit proxy; expose only tracking endpoints.
    const rybbit = [
      'script.js',
      'replay.js',
      'metrics.js',
      'track',
      'identify',
      'site/tracking-config/:siteId',
      'site/:siteId/feature-flags/evaluate',
      'session-replay/record/:siteId',
    ].map((path) => ({
      source: `/_fm/${path}`,
      destination: `https://rybbit.fedeminaya.com/api/${path}`,
    }));
    return [
      ...rybbit,
      {
        source: '/_wa/static/:path*',
        destination: 'https://us-assets.i.posthog.com/static/:path*',
      },
      {
        source: '/_wa/array/:path*',
        destination: 'https://us-assets.i.posthog.com/array/:path*',
      },
      {
        source: '/_wa/:path*',
        destination: 'https://us.i.posthog.com/:path*',
      },
    ];
  },
  async headers() {
    return [
      {
        source: '/barrens-hero-v1.avif',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=86400, stale-while-revalidate=604800' },
        ],
      },
      ...(process.env.VERCEL_ENV === 'preview'
        ? [{ source: '/:path*', headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] }]
        : []),
    ];
  },
};
export default nextConfig;
