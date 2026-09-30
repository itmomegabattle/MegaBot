export function SegmentedControl({ value, onChange, options, label }: { value: string; onChange: (value: string) => void; options: [string, string][]; label?: string }) {
  return (
    <div className={`grid gap-2 rounded-[var(--mega-radius-card)] bg-slate-100 p-1 ${options.length === 3 ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-2'}`} role="group" aria-label={label}>
      {options.map(([key, optionLabel]) => (
        <button
          key={key}
          type="button"
          aria-pressed={value === key}
          onClick={() => onChange(key)}
          className={`mega-segment-option min-h-11 rounded-[var(--mega-radius-control)] px-3 py-2 text-sm font-black transition duration-150 hover:brightness-105 active:scale-[0.98] active:brightness-90 ${value === key ? 'mega-segment-option-active shadow-sm' : 'mega-segment-option-idle'}`}
        >
          {optionLabel}
        </button>
      ))}
    </div>
  );
}
