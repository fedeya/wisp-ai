import { changelogSocialImage } from '../../../../../changelog-social-image';
import { getPublishedRelease } from '../../../../../changelog.server';
import { resolveLocale } from '../../../../../i18n/server';

type Props = { params: Promise<{ locale: string; version: string }> };

export async function GET(_request: Request, { params }: Props) {
  const locale = await resolveLocale(params);
  const { version } = await params;
  const release = await getPublishedRelease(version);
  if (!release) {
    return new Response(null, { status: 404 });
  }
  return changelogSocialImage(locale, release);
}
