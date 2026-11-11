'use client';

import type { ComponentProps } from 'react';
import { trackDownload, type DownloadDetails } from '../analytics';
import { ButtonLink } from './ui/button-link';
import { site } from '../site';

type Props = Omit<ComponentProps<typeof ButtonLink>, 'onClick' | 'onAuxClick'> & DownloadDetails;

export function DownloadLink({ location, locale, version, channel, ...props }: Props) {
  // An explicit install URL can point at a different version than the manifest.
  const downloadVersion =
    props.href === site.download && site.download !== '/download' ? undefined : version;
  const track = () =>
    trackDownload({ location, locale, version: downloadVersion, channel: channel ?? 'stable' });
  return (
    <ButtonLink
      {...props}
      onClick={track}
      onAuxClick={(event) => {
        if (event.button === 1) {
          track();
        }
      }}
    />
  );
}
