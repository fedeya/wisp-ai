import { Combobox } from '@base-ui/react/combobox';
import { useMemo } from 'react';
import Icon from '../Icon';
import { field, floatingSurface, selectTrigger } from './styles';

export type SearchSelectOption<Value extends string> = {
  value: Value;
  label: string;
  description?: string;
  /** Section heading; options sharing it are listed together under it. */
  group?: string;
};

type OptionGroup<Value extends string> = { label: string; items: SearchSelectOption<Value>[] };

type SearchSelectProps<Value extends string> = {
  id?: string;
  name?: string;
  'aria-label'?: string;
  className?: string;
  disabled?: boolean;
  placeholder?: string;
  searchLabel: string;
  searchPlaceholder?: string;
  emptyText?: string;
  value: Value | null;
  options: SearchSelectOption<Value>[];
  onValueChange: (value: Value) => void;
};

/** Groups options by `group`, in the order each group first appears. */
export function groupOptions<Value extends string>(options: SearchSelectOption<Value>[]) {
  const groups = new Map<string, OptionGroup<Value>>();
  for (const option of options) {
    const label = option.group ?? '';
    const group = groups.get(label) ?? { label, items: [] };
    group.items.push(option);
    groups.set(label, group);
  }
  return [...groups.values()];
}

/** Every word of the query appears in the option's label, description, value or group. */
export function matchesQuery(option: SearchSelectOption<string>, query: string) {
  const text = [option.label, option.description, option.value, option.group]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => text.includes(word));
}

/**
 * A select for long lists: the popup opens with a search field and lists
 * options under their group headings.
 */
export function SearchSelect<Value extends string>({
  id,
  name,
  'aria-label': ariaLabel,
  className,
  disabled,
  placeholder,
  searchLabel,
  searchPlaceholder = 'Search',
  emptyText = 'No matches.',
  value,
  options,
  onValueChange,
}: SearchSelectProps<Value>) {
  const groups = useMemo(() => groupOptions(options), [options]);
  const selected = options.find((option) => option.value === value) ?? null;
  return (
    <Combobox.Root<SearchSelectOption<Value>>
      name={name}
      items={groups}
      value={selected}
      disabled={disabled}
      modal={false}
      autoHighlight
      filter={matchesQuery}
      itemToStringLabel={(option) => option.label}
      itemToStringValue={(option) => option.value}
      isItemEqualToValue={(option, current) => option.value === current.value}
      onValueChange={(next) => {
        if (next) onValueChange(next.value);
      }}
    >
      <Combobox.Trigger
        id={id}
        aria-label={ariaLabel}
        className={selectTrigger({
          class: [
            'group flex items-center justify-between gap-3 text-left',
            'transition-colors duration-75 data-popup-open:bg-hover disabled:cursor-default',
            className,
          ],
        })}
      >
        <Combobox.Value>
          {(current: SearchSelectOption<Value> | null) => (
            <span className={`min-w-0 truncate ${current ? '' : 'text-muted'}`}>
              {current?.label ?? placeholder}
            </span>
          )}
        </Combobox.Value>
        <Combobox.Icon className="flex shrink-0 text-muted transition-[color,transform] group-data-popup-open:rotate-180">
          <Icon name="chevronDown" size={16} />
        </Combobox.Icon>
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner align="start" sideOffset={4} className="z-[25]">
          <Combobox.Popup
            aria-label={searchLabel}
            className={`flex w-[min(max(var(--anchor-width),16rem),var(--available-width))] max-h-[min(24rem,var(--available-height))] origin-(--transform-origin) flex-col gap-1 p-1 outline-none ${floatingSurface} transition-[opacity,scale] duration-100 data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0`}
          >
            <Combobox.Input
              aria-label={searchLabel}
              placeholder={searchPlaceholder}
              className={field({ class: 'shrink-0' })}
            />
            <Combobox.Empty className="px-2.5 py-2 text-sm text-muted empty:hidden">
              {emptyText}
            </Combobox.Empty>
            <Combobox.List className="min-h-0 overflow-y-auto overscroll-contain empty:hidden">
              {(group: OptionGroup<Value>) => (
                <Combobox.Group key={group.label} items={group.items} className="pb-1 last:pb-0">
                  {group.label && (
                    <Combobox.GroupLabel className="sticky top-0 z-[1] bg-raised px-2.5 pt-2 pb-1 text-xs font-medium text-muted select-none">
                      {group.label}
                    </Combobox.GroupLabel>
                  )}
                  <Combobox.Collection>
                    {(option: SearchSelectOption<Value>) => (
                      <Combobox.Item
                        key={option.value}
                        value={option}
                        className="grid min-h-8 grid-cols-[minmax(0,1fr)_16px] items-center gap-x-2 rounded-[4px] px-2.5 py-1.5 text-base leading-snug outline-none select-none data-highlighted:bg-hover"
                      >
                        <div className="min-w-0 wrap-anywhere">
                          {option.label}
                          {option.description && (
                            <div className="mt-0.5 text-xs text-muted">{option.description}</div>
                          )}
                        </div>
                        <Combobox.ItemIndicator className="col-start-2 flex text-accent">
                          <Icon name="check" size={16} />
                        </Combobox.ItemIndicator>
                      </Combobox.Item>
                    )}
                  </Combobox.Collection>
                </Combobox.Group>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
