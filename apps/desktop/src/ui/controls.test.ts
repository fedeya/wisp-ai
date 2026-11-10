import { afterEach, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import Controls from './__tests__/Controls.svelte';

afterEach(cleanup);
const values = () => JSON.parse(screen.getByTestId('values').textContent!);

test('native field events update parent bindings, including number coercion and empty values', async () => {
  render(Controls);
  await fireEvent.input(screen.getByRole('textbox', { name: 'Name' }), {
    target: { value: 'Player' },
  });
  await fireEvent.input(screen.getByRole('spinbutton', { name: 'Count' }), {
    target: { value: '12' },
  });
  await fireEvent.change(screen.getByRole('combobox', { name: 'Choice' }), {
    target: { value: 'two' },
  });
  await fireEvent.input(screen.getByRole('textbox', { name: 'Note' }), {
    target: { value: 'Updated note' },
  });
  await fireEvent.click(screen.getByRole('checkbox', { name: 'Enabled' }));
  expect(values()).toEqual({
    name: 'Player',
    count: 12,
    choice: 'two',
    note: 'Updated note',
    checked: true,
    submits: 0,
  });
  await fireEvent.input(screen.getByRole('spinbutton', { name: 'Count' }), {
    target: { value: '' },
  });
  expect(values().count).toBeNull();
});

test('parent updates reach native controls and ordinary buttons do not submit their form', async () => {
  render(Controls);
  await fireEvent.change(screen.getByRole('combobox', { name: 'Choice' }), {
    target: { value: 'two' },
  });
  await fireEvent.click(screen.getByRole('checkbox', { name: 'Enabled' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
  expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Reset');
  expect((screen.getByRole('spinbutton', { name: 'Count' }) as HTMLInputElement).value).toBe('7');
  expect((screen.getByRole('combobox', { name: 'Choice' }) as HTMLSelectElement).value).toBe('one');
  expect((screen.getByRole('textbox', { name: 'Note' }) as HTMLTextAreaElement).value).toBe(
    'Reset note',
  );
  expect((screen.getByRole('checkbox', { name: 'Enabled' }) as HTMLInputElement).checked).toBe(
    false,
  );
  expect(values().submits).toBe(0);
  await fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  expect(values().submits).toBe(1);
});
