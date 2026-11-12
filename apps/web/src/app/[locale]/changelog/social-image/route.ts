import { changelogSocialImage } from '../../../../changelog-social-image';
import { resolveLocale, type LocalePageProps } from '../../../../i18n/server';

export const dynamic = 'force-static';

export async function GET(_request: Request, { params }: LocalePageProps) {
  return changelogSocialImage(await resolveLocale(params));
}
