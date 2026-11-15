export function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      className={`spinner border-[2px] border-solid w-[15px] h-[15px] rounded-[50%] border-t-[var(--accent)] border-r-[#77dbc633] border-b-[#77dbc633] border-l-[#77dbc633] animate-spinner shrink-0 ${className}`}
    />
  );
}

export function ActionProgress({ label }: { label: string }) {
  return (
    <span
      className="action-progress gap-[8px] inline-flex items-center text-[12px] text-muted [&:empty]:hidden"
      role="status"
      aria-live="polite"
    >
      {label && (
        <>
          <Spinner />
          {label}…
        </>
      )}
    </span>
  );
}
