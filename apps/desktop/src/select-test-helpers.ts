import { fireEvent, screen } from '@testing-library/react';

export function openSelect(trigger: HTMLElement) {
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  return screen.findByRole('listbox');
}

export async function chooseOption(trigger: HTMLElement, name: string) {
  await openSelect(trigger);
  const option = await screen.findByRole('option', { name });
  fireEvent.pointerDown(option, { pointerType: 'mouse' });
  fireEvent.click(option);
}
