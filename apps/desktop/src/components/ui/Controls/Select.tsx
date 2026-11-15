import { Select as BaseSelect } from '@base-ui/react/select';
import Icon from '../Icon';
import { field } from './styles';

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
            'group flex cursor-pointer items-center justify-between gap-3 rounded-[9px] text-left',
            'transition-colors enabled:hover:border-[#568780] enabled:hover:bg-[#1b272d]',
            'data-popup-open:border-[#568780] data-popup-open:bg-[#1b272d] disabled:cursor-default',
            className,
          ],
        })}
      >
        <BaseSelect.Value
          className="min-w-0 truncate data-placeholder:text-muted"
          placeholder={placeholder}
        />
        <BaseSelect.Icon className="flex shrink-0 text-muted transition-[color,transform] group-data-popup-open:rotate-180 group-data-popup-open:text-accent">
          <Icon name="chevronDown" size={16} />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner
          align="start"
          alignItemWithTrigger={false}
          sideOffset={6}
          className="z-[25]"
        >
          <BaseSelect.Popup className="w-[min(max(var(--anchor-width),10rem),var(--available-width))] origin-(--transform-origin) rounded-[12px] border border-solid border-[#3c535b] bg-[#1c252b] p-1 outline-none shadow-[0_12px_32px_#0008] transition-[opacity,scale] duration-150 data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0">
            <BaseSelect.List className="max-h-[min(18rem,calc(var(--available-height)-10px))] overflow-y-auto overscroll-contain">
              {options.map(({ value, label, description }) => (
                <BaseSelect.Item
                  key={value}
                  value={value}
                  label={label}
                  className="grid min-h-9 cursor-pointer grid-cols-[minmax(0,1fr)_16px] items-center gap-x-2 rounded-[7px] px-2.5 py-2 text-[13px] leading-snug outline-none select-none data-selected:bg-[#20352f] data-selected:text-accent data-highlighted:bg-[#2a3d3f] data-highlighted:text-[#f1f7f5]"
                >
                  <div className="min-w-0 wrap-anywhere">
                    <BaseSelect.ItemText>{label}</BaseSelect.ItemText>
                    {description && (
                      <div className="mt-0.5 text-[11px] text-muted">{description}</div>
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
