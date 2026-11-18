export type StatusTone = 'positive' | 'attention' | 'neutral';

const toneClass: Record<StatusTone, string> = {
  positive: 'bg-accent-dim text-accent',
  attention: 'bg-warning-dim text-warning',
  neutral: 'bg-control text-muted',
};

/** Small status label with a dot, e.g. "Connected" or "Needs setup". */
export default function StatusBadge({ tone, children }: { tone: StatusTone; children: string }) {
  return (
    <span
      className={`inline-flex w-fit items-center gap-1.5 rounded-[4px] px-2 py-0.5 text-xs leading-5 ${toneClass[tone]}`}
    >
      <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
      {children}
    </span>
  );
}
