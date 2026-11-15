import { afterEach, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import Controls from './__tests__/Controls';

afterEach(cleanup);
const values = () => JSON.parse(screen.getByTestId('values').textContent!);

test('native field events update controlled state, including number coercion and empty values', () => {
  render(<Controls />);
  fireEvent.input(screen.getByRole('textbox', { name: 'Name' }), {
    target: { value: 'Player' },
  });
  fireEvent.input(screen.getByRole('spinbutton', { name: 'Count' }), {
    target: { value: '12' },
  });
  fireEvent.change(screen.getByRole('combobox', { name: 'Choice' }), {
    target: { value: 'two' },
  });
  fireEvent.input(screen.getByRole('textbox', { name: 'Note' }), {
    target: { value: 'Updated note' },
  });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Enabled' }));
  expect(values()).toEqual({
    name: 'Player',
    count: 12,
    choice: 'two',
    note: 'Updated note',
    checked: true,
    submits: 0,
  });
  fireEvent.input(screen.getByRole('spinbutton', { name: 'Count' }), {
    target: { value: '' },
  });
  expect(values().count).toBeNull();
});

test('parent updates reach native controls and ordinary buttons do not submit their form', () => {
  render(<Controls />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Choice' }), {
    target: { value: 'two' },
  });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Enabled' }));
  fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
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
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  expect(values().submits).toBe(1);
});
