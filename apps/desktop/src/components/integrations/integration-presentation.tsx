import type { CapabilityView } from '@wisp/protocol/capabilities';
import type { ComponentProps } from 'react';
import type { Mcp } from '../../api';
import auctionatorLogo from '../../assets/integrations/auctionator.png';
import everlootLogo from '../../assets/integrations/everloot.png';
import questieLogo from '../../assets/integrations/questie.png';
import simLogo from '../../assets/integrations/sim.png';
import syndicatorLogo from '../../assets/integrations/syndicator.png';
import theWowDbLogo from '../../assets/integrations/thewowdb.svg';
import Icon from '../ui/Icon';
import StatusBadge, { type StatusTone } from '../ui/StatusBadge';

const integrationLogos: Readonly<Partial<Record<string, string>>> = {
  'integration:questie': questieLogo,
  'integration:syndicator': syndicatorLogo,
  'integration:auctionator': auctionatorLogo,
  'integration:thewowdb': theWowDbLogo,
  'mcp:everloot': everlootLogo,
  'integration:wowsims': simLogo,
};

type IconName = ComponentProps<typeof Icon>['name'];
type Label = { label: string; tone: 'ready' | 'attention' | 'neutral' };

const statusTone: Record<Label['tone'], StatusTone> = {
  ready: 'positive',
  attention: 'attention',
  neutral: 'neutral',
};

export const mcpTransport: Record<Mcp['transport'], string> = {
  http: 'Streamable HTTP',
  sse: 'SSE',
  stdio: 'Local process',
};

export function integrationType(kind: CapabilityView['kind']): { icon: IconName; label: string } {
  switch (kind) {
    case 'addon':
      return { icon: 'puzzle', label: 'WoW addon' };
    case 'source':
    case 'mcp':
      return { icon: 'database', label: 'Data source' };
    case 'service':
      return { icon: 'workflow', label: 'Service' };
    default:
      return { icon: 'plug', label: 'Integration' };
  }
}

export function needsAddonSetup(entry: CapabilityView) {
  return (
    entry.kind === 'addon' &&
    entry.enabled &&
    (entry.status === 'missing' || entry.status === 'incompatible')
  );
}

export function capabilityStatus(
  entry: Pick<CapabilityView, 'available' | 'enabled' | 'status' | 'kind'>,
): Label {
  if (!entry.enabled) return { label: 'Disabled', tone: 'neutral' };
  if (entry.status === 'waiting') return { label: 'Waiting for WoW', tone: 'neutral' };
  if (entry.status === 'missing' && entry.kind === 'addon') {
    return { label: 'Setup needed', tone: 'attention' };
  }
  if (entry.status === 'missing') return { label: 'Missing', tone: 'attention' };
  if (entry.status === 'incompatible') return { label: 'Incompatible', tone: 'attention' };
  if (!entry.available) return { label: 'Unavailable', tone: 'attention' };
  if (entry.status === 'partial') return { label: 'Partial', tone: 'attention' };
  if (entry.status === 'ready') {
    return { label: entry.kind === 'addon' ? 'Detected' : 'Ready', tone: 'ready' };
  }
  return { label: 'Configured', tone: 'neutral' };
}

export function IntegrationIcon({ id, icon }: { id?: string; icon: IconName }) {
  const logo = id && integrationLogos[id];
  if (logo) {
    return <img alt="" src={logo} className="size-9 shrink-0 rounded-[8px] object-contain" />;
  }
  return (
    <span className="grid size-9 shrink-0 place-items-center rounded-[8px] border border-solid border-border-strong bg-selected text-[#bbe2d9]">
      <Icon name={icon} size={19} />
    </span>
  );
}

export function IntegrationStatus({ label, tone }: Label) {
  return <StatusBadge tone={statusTone[tone]}>{label}</StatusBadge>;
}
