import { Button as BaseButton } from '@base-ui/react/button';
import { Input as BaseInput } from '@base-ui/react/input';
import type { ComponentProps } from 'react';
import type { VariantProps } from 'tailwind-variants';
import { badge, button, card, checkbox, field, textarea } from './styles';

export { Select } from './Select';

type ButtonProps = ComponentProps<'button'> & VariantProps<typeof button>;

export function Button({
  intent,
  size,
  destructive,
  className,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <BaseButton
      {...props}
      type={type}
      className={button({ intent, size, destructive, class: className })}
    />
  );
}

type BadgeProps = ComponentProps<'span'> & VariantProps<typeof badge>;

export function Badge({ positive, className, ...props }: BadgeProps) {
  return <span {...props} className={badge({ positive, class: className })} />;
}

type CardProps = ComponentProps<'section'> & VariantProps<typeof card>;

export function Card({ kind, ready, className, ...props }: CardProps) {
  return <section {...props} className={card({ kind, ready, class: className })} />;
}

export function Input({ type = 'text', className, ...props }: ComponentProps<'input'>) {
  return <BaseInput {...props} type={type} className={field({ class: className })} />;
}

type NumberInputProps = Omit<ComponentProps<'input'>, 'type' | 'value' | 'onChange'> & {
  value: number | undefined;
  onValueChange: (value: number | undefined) => void;
};

export function NumberInput({ value, onValueChange, ...props }: NumberInputProps) {
  return (
    <Input
      {...props}
      type="number"
      value={value ?? ''}
      onChange={({ currentTarget }) => {
        const next = currentTarget.valueAsNumber;
        onValueChange(Number.isNaN(next) ? undefined : next);
      }}
    />
  );
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea {...props} className={textarea({ class: className })} />;
}

export function Checkbox({ className, ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  return <input {...props} type="checkbox" className={checkbox({ class: className })} />;
}
