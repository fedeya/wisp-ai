import { Navigate } from 'react-router';
import type { FeatureChannel, FeatureView } from '@wisp/protocol/features';
import DataState from '../components/ui/DataState';
import { Button } from '../components/ui/Controls';
import { Row, RowGroup } from '../components/ui/Rows';
import Toggle from '../components/ui/Toggle';
import { desktopLocked } from '../desktop-controller';
import { useDesktop, useDesktopActions } from '../use-desktop';

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
export default function Experimental() {
  const app = useDesktop((state) => ({
    loading: state.loading,
    features: state.status?.features,
    locked: desktopLocked(state),
  }));
  const { setFeature } = useDesktopActions();
  const { features, locked } = app;
  if (app.loading || !features) return <DataState />;
  // Reached by an old link after the last flag shipped: nothing to show.
  if (!features.flags.length) return <Navigate to="/settings" replace />;

  return (
    <RowGroup label={`Features in testing · ${channelName[features.channel]}`}>
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
