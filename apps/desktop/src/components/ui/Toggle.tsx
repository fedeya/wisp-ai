import { Switch } from '@base-ui/react/switch';

export default function Toggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Switch.Root
      render={<button type="button" />}
      nativeButton
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onChange}
      className="relative block h-[23px] w-[40px] shrink-0 cursor-pointer rounded-[20px] border-0 bg-border-strong p-0 transition-colors duration-200 data-checked:bg-[#4ba793] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent focus-visible:outline-offset-[3px] disabled:cursor-default disabled:opacity-40"
    >
      <Switch.Thumb className="absolute top-[3px] left-[3px] block h-[17px] w-[17px] rounded-full bg-[#d8e3df] transition-transform duration-200 data-checked:translate-x-[17px]" />
    </Switch.Root>
  );
}
