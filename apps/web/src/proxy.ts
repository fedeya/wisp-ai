import { NextResponse, type NextRequest } from 'next/server';
import { isLocale, preferredLocale } from './i18n/config';
export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (/^\/(en|es)(\/|$)/.test(path)) {
    return NextResponse.next();
  }
  const saved = request.cookies.get('wisp-locale')?.value;
  const locale =
    saved && isLocale(saved) ? saved : preferredLocale(request.headers.get('accept-language'));
  const url = request.nextUrl.clone();
  url.pathname = `/${locale}${path === '/' ? '' : path}`;
  const response = NextResponse.redirect(url, 307);
  response.headers.set('Vary', 'Accept-Language, Cookie');
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}
export const config = {
  matcher: ['/', '/features', '/setup', '/changelog/:path*', '/en/:path*', '/es/:path*'],
};
