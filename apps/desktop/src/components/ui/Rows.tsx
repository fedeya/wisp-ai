import type { ReactNode } from 'react';

/** Small section label above a group of rows. */
export const groupLabel = 'mb-1.5 ml-0.5 text-sm font-normal tracking-normal text-muted';

/** A labelled stack of rows, the desktop replacement for loose cards. */
export function RowGroup({
  label,
  className = '',
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className={`mb-5 ${className}`}>
      <h2 className={groupLabel}>{label}</h2>
      <div className="flex flex-col gap-0.5 overflow-hidden rounded-[6px]">{children}</div>
    </section>
  );
}

/** Icon, title and detail on the left; status or action on the right. */
export function Row({
  icon,
  title,
  detail,
  trailing,
  highlight = false,
  children,
}: {
  icon?: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  trailing?: ReactNode;
  highlight?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={highlight ? 'bg-raised' : 'bg-surface'}>
      <div className="flex min-h-[56px] items-center gap-3 px-4 py-2.5">
        {icon && <span className="flex shrink-0 text-muted">{icon}</span>}
        <div className="min-w-0 flex-1">
          <div className="text-base text-foreground">{title}</div>
          {detail && (
            <div className="mt-0.5 text-sm text-subtle [overflow-wrap:anywhere]">{detail}</div>
          )}
        </div>
        {trailing && <div className="flex shrink-0 items-center gap-2">{trailing}</div>}
      </div>
      {children}
    </div>
  );
}
