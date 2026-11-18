import { Select as BaseSelect } from '@base-ui/react/select';
import Icon from '../Icon';
import { field, floatingSurface } from './styles';

type SelectOption<Value extends string> = {
  value: Value;
  label: string;
  description?: string;
};

type SelectProps<Value extends string> = {
  id?: string;
  name?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  className?: string;
  disabled?: boolean;
  placeholder?: string;
  value: Value | null;
  options: SelectOption<Value>[];
  onValueChange: (value: Value) => void;
};

export function Select<Value extends string>({
  id,
  name,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
  className,
  disabled,
  placeholder,
  value,
  options,
  onValueChange,
}: SelectProps<Value>) {
  return (
    <BaseSelect.Root<Value>
      name={name}
      value={value}
      items={options}
      disabled={disabled}
      modal={false}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
      }}
    >
      <BaseSelect.Trigger
        id={id}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        className={field({
          class: [
            'group flex items-center justify-between gap-3 text-left',
            'transition-colors duration-75 data-popup-open:bg-white/[0.06] disabled:cursor-default',
            className,
          ],
        })}
      >
        <BaseSelect.Value
          className="min-w-0 truncate data-placeholder:text-muted"
          placeholder={placeholder}
        />
        <BaseSelect.Icon className="flex shrink-0 text-muted transition-[color,transform] group-data-popup-open:rotate-180">
          <Icon name="chevronDown" size={16} />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner
          align="start"
          alignItemWithTrigger={false}
          sideOffset={4}
          className="z-[25]"
        >
          <BaseSelect.Popup
            className={`w-[min(max(var(--anchor-width),10rem),var(--available-width))] origin-(--transform-origin) p-1 outline-none ${floatingSurface} transition-[opacity,scale] duration-100 data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0`}
          >
            <BaseSelect.List className="max-h-[min(18rem,calc(var(--available-height)-10px))] overflow-y-auto overscroll-contain">
              {options.map(({ value, label, description }) => (
                <BaseSelect.Item
                  key={value}
                  value={value}
                  label={label}
                  className="grid min-h-8 grid-cols-[minmax(0,1fr)_16px] items-center gap-x-2 rounded-[4px] px-2.5 py-1.5 text-[14px] leading-snug outline-none select-none data-highlighted:bg-white/[0.06]"
                >
                  <div className="min-w-0 wrap-anywhere">
                    <BaseSelect.ItemText>{label}</BaseSelect.ItemText>
                    {description && (
                      <div className="mt-0.5 text-[12px] text-muted">{description}</div>
                    )}
                  </div>
                  <BaseSelect.ItemIndicator className="col-start-2 flex text-accent">
                    <Icon name="check" size={16} />
                  </BaseSelect.ItemIndicator>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
