import { afterEach, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { Button, Checkbox, Input, NumberInput, Select, Textarea } from './index';

function ControlsFixture() {
  const [name, setName] = useState('Wisp');
  const [count, setCount] = useState<number | undefined>(4);
  const [choice, setChoice] = useState('one');
  const [note, setNote] = useState('Initial note');
  const [checked, setChecked] = useState(false);
  const [submits, setSubmits] = useState(0);

  return (
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setSubmits((value) => value + 1);
        }}
      >
        <Input
          aria-label="Name"
          value={name}
          onChange={({ currentTarget }) => setName(currentTarget.value)}
        />
        <NumberInput aria-label="Count" value={count} onValueChange={setCount} />
        <Select
          aria-label="Choice"
          value={choice}
          onChange={({ currentTarget }) => setChoice(currentTarget.value)}
        >
          <option value="one">One</option>
          <option value="two">Two</option>
        </Select>
        <Textarea
          aria-label="Note"
          value={note}
          onChange={({ currentTarget }) => setNote(currentTarget.value)}
        />
        <Checkbox
          aria-label="Enabled"
          checked={checked}
          onChange={({ currentTarget }) => setChecked(currentTarget.checked)}
        />
        <Button
          onClick={() => {
            setName('Reset');
            setCount(7);
            setChoice('one');
            setNote('Reset note');
            setChecked(false);
          }}
        >
          Reset
        </Button>
        <Button type="submit">Submit</Button>
      </form>
      <output data-testid="values">
        {JSON.stringify({ name, count: count ?? null, choice, note, checked, submits })}
      </output>
    </>
  );
}

afterEach(cleanup);
const values = () => JSON.parse(screen.getByTestId('values').textContent!);

test('native field events update controlled state, including number coercion and empty values', () => {
  render(<ControlsFixture />);
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
  render(<ControlsFixture />);
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
