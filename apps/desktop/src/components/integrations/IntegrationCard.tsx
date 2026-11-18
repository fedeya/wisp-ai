import type { CapabilityView } from '@wisp/protocol/capabilities';
import { ActionProgress } from '../ui/ActionProgress';
import Toggle from '../ui/Toggle';
import { Card, Checkbox } from '../ui/Controls';

type IntegrationCardProps = {
  title: string;
  entry: CapabilityView;
  tools: CapabilityView[];
  locked: boolean;
  busy: string;
  set: (id: string, enabled: boolean) => void;
};

export default function IntegrationCard({
  title,
  entry,
  tools,
  locked,
  busy,
  set,
}: IntegrationCardProps) {
  return (
    <Card kind="integration">
      <div className="integration-top gap-[18px] flex items-center justify-between">
        <div>
          <h2>{title}</h2>
          <p className="text-muted text-sm">{entry.description}</p>
        </div>
        <div className="row-controls gap-[14px] flex items-center shrink-0">
          {busy && <ActionProgress label={busy} />}
          <Toggle
            label={`Enable ${entry.name}`}
            checked={entry.enabled}
            disabled={locked}
            onChange={(checked) => set(entry.id, checked)}
          />
        </div>
      </div>
      {(entry.version || tools.length > 0) && (
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted">
          {entry.version && <span>v{entry.version}</span>}
          {tools.length > 0 && (
            <span>
              {tools.filter((tool) => tool.effective).length}/{tools.length} tools active
            </span>
          )}
        </div>
      )}
      {entry.reason && (
        <p className="muted integration-reason mx-0 text-muted text-sm mt-[12px] mb-0">
          {entry.reason}
        </p>
      )}
      {tools.length > 0 && (
        <details className="integration-tools mt-[16px] border-t-[1px] [border-top-style:solid] border-t-[#ffffff12] pt-[12px]">
          <summary className="text-muted text-sm">
            Tools &amp; capabilities ({tools.length})
          </summary>
          {tools.map((tool) => (
            <label
              key={tool.id}
              className={`integration-tool gap-[12px] px-0 py-[14px] flex items-start border-b-[1px] [border-bottom-style:solid] border-b-[#ffffff08] [&:last-child]:border-0 [&:last-child]:border-none [&:last-child]:border-[currentColor] [&:last-child]:pb-0 [&.inactive]:opacity-[0.5]${entry.enabled ? '' : ' inactive'}`}
            >
              <Checkbox
                className="p-0 [accent-color:var(--accent)] w-[16px] h-[16px] min-h-[0] shrink-0"
                aria-label={`${entry.name}: ${tool.name}`}
                checked={tool.enabled}
                disabled={locked || !entry.enabled}
                onChange={(event) => set(tool.id, event.currentTarget.checked)}
              />
              <span className="gap-[5px] grid min-w-[0]">
                <strong className="text-sm font-medium">{tool.name}</strong>
                {tool.toolName && (
                  <code className="text-[11px] text-muted [overflow-wrap:anywhere]">
                    {tool.toolName}
                  </code>
                )}
                {!tool.available && (
                  <small className="tool-unavailable text-xs leading-[1.5] text-[#929b9a]">
                    {tool.status}: {tool.reason || 'Required API unavailable'}
                  </small>
                )}
                <small className="text-xs leading-[1.5] text-[#929b9a]">{tool.description}</small>
              </span>
            </label>
          ))}
        </details>
      )}
    </Card>
  );
}
