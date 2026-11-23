import type { CapabilityView } from '@wisp/protocol/capabilities';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '../ui/Controls';
import Icon from '../ui/Icon';
import { groupLabel } from '../ui/Rows';
import Toggle from '../ui/Toggle';
import type { IntegrationGuide } from './integration-guides';

function Section({
  label,
  aside,
  children,
}: {
  label: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className="mb-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className={groupLabel}>{label}</h2>
        {aside && <span className="mb-1.5 text-sm text-muted">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

export function IntegrationTools({
  label,
  entry,
  tools,
  locked,
  set,
}: {
  label: string;
  entry: CapabilityView;
  tools: CapabilityView[];
  locked: boolean;
  set: (id: string, enabled: boolean) => void;
}) {
  if (tools.length === 0) return null;
  const on = tools.filter((tool) => tool.effective).length;
  return (
    <Section label={label} aside={`${on} of ${tools.length} on`}>
      <ul
        className={`m-0 flex list-none flex-col gap-0.5 overflow-hidden rounded-[6px] p-0 ${entry.enabled ? '' : 'opacity-50'}`}
      >
        {tools.map((tool) => (
          <li key={tool.id} className="flex items-start gap-3 bg-surface px-4 py-3">
            <div className="grid min-w-0 flex-1 gap-0.5">
              <span className="text-base text-foreground">{tool.name}</span>
              <span className="text-sm text-subtle">{tool.description}</span>
              {!tool.available && (
                <span className="flex items-center gap-1.5 text-sm text-warning">
                  <Icon name="warning" size={13} />
                  {tool.reason || 'Required API unavailable'}
                </span>
              )}
            </div>
            <Toggle
              label={`${entry.name}: ${tool.name}`}
              checked={tool.enabled}
              disabled={locked || !entry.enabled}
              onChange={(checked) => set(tool.id, checked)}
            />
          </li>
        ))}
      </ul>
    </Section>
  );
}

function ExamplePrompt({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <li className="flex items-center gap-3 bg-surface py-1.5 pr-2 pl-4">
      <span className="min-w-0 flex-1 text-base text-foreground">“{text}”</span>
      <span role="status" className="text-sm text-muted">
        {copied ? 'Copied' : ''}
      </span>
      <Button intent="quiet" size="icon" aria-label={`Copy “${text}”`} onClick={copy}>
        <Icon name={copied ? 'check' : 'copy'} size={14} />
      </Button>
    </li>
  );
}

export function TryAsking({ examples }: { examples: readonly string[] }) {
  if (examples.length === 0) return null;
  return (
    <Section label="Try asking" aside="Type /wisp in WoW">
      <ul className="m-0 flex list-none flex-col gap-0.5 overflow-hidden rounded-[6px] p-0">
        {examples.map((text) => (
          <ExamplePrompt key={text} text={text} />
        ))}
      </ul>
    </Section>
  );
}

export function AboutIntegration({ guide }: { guide: IntegrationGuide }) {
  return (
    <Section label="About">
      <div className="rounded-[6px] bg-surface px-4 py-3">
        <p className="m-0 text-sm leading-[1.6] text-subtle">{guide.about}</p>
        {guide.link && (
          <a
            href={guide.link.url}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex items-center gap-1.5 text-sm text-accent"
          >
            <Icon name="link" size={13} />
            {guide.link.label}
          </a>
        )}
      </div>
    </Section>
  );
}
