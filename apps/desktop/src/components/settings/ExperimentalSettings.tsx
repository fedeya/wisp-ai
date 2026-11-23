import type { FeatureChannel, FeatureView } from '@wisp/protocol/features';
import { desktopLocked } from '../../desktop-controller';
import { useDesktop, useDesktopActions } from '../../use-desktop';
import { Button } from '../ui/Controls';
import { Row, RowGroup } from '../ui/Rows';
import Toggle from '../ui/Toggle';

const channelName: Record<FeatureChannel, string> = {
  development: 'development builds',
  nightly: 'Nightly',
  stable: 'Stable',
};

function source(flag: FeatureView, channel: FeatureChannel) {
  const fallback = `by default in ${channelName[channel]}`;
  return flag.override === null
    ? `${flag.channelDefault ? 'On' : 'Off'} ${fallback}`
    : `Changed by you · ${flag.channelDefault ? 'on' : 'off'} ${fallback}`;
}

/** Unfinished features this build ships, with a switch to try or hide each one. */
export default function ExperimentalSettings() {
  const app = useDesktop((state) => ({
    features: state.status?.features,
    locked: desktopLocked(state),
  }));
  const { setFeature } = useDesktopActions();
  const { features, locked } = app;
  if (!features?.flags.length) return null;

  return (
    <RowGroup label="Experimental">
      {features.flags.map((flag) => (
        <Row
          key={flag.id}
          title={flag.name}
          detail={
            <>
              {flag.description}
              <span className="block text-[12px] text-muted">{source(flag, features.channel)}</span>
            </>
          }
          trailing={
            <div className="flex items-center gap-3">
              {flag.override !== null && (
                <Button
                  size="text"
                  disabled={locked}
                  aria-label={`Use the default for ${flag.name}`}
                  onClick={() => void setFeature(flag.id, null)}
                >
                  Reset
                </Button>
              )}
              <Toggle
                label={`Enable ${flag.name}`}
                checked={flag.enabled}
                disabled={locked}
                onChange={(checked) => void setFeature(flag.id, checked)}
              />
            </div>
          }
        />
      ))}
    </RowGroup>
  );
}
