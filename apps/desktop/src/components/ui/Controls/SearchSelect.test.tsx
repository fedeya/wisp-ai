import { afterEach, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { openSelect } from '../../../select-test-helpers';
import { SearchSelect } from './SearchSelect';

const options = [
  { value: 'or:claude', label: 'Claude Sonnet', group: 'OpenRouter' },
  { value: 'or:gpt', label: 'GPT-5', group: 'OpenRouter' },
  { value: 'gpt-codex', label: 'GPT-5 Codex', group: 'ChatGPT' },
];

function Fixture() {
  const [value, setValue] = useState<string | null>(null);
  return (
    <>
      <SearchSelect
        aria-label="Model"
        searchLabel="Search models"
        emptyText="No models match your search."
        placeholder="Choose a model"
        value={value}
        onValueChange={setValue}
        options={options}
      />
      <output>{value ?? 'none'}</output>
    </>
  );
}

afterEach(cleanup);

test('lists options under their group and narrows them by every word typed', async () => {
  render(<Fixture />);
  const trigger = screen.getByRole('combobox', { name: 'Model' });
  expect(trigger.textContent).toContain('Choose a model');
  const list = await openSelect(trigger);
  const groups = within(list).getAllByRole('group');
  expect(groups.map((group) => within(group).getAllByRole('option').length)).toEqual([2, 1]);
  expect(within(list).getByText('OpenRouter')).toBeTruthy();
  expect(within(list).getByText('ChatGPT')).toBeTruthy();

  const search = screen.getByRole('combobox', { name: 'Search models' });
  // Words match in any order and across the label, the value and the group.
  fireEvent.change(search, { target: { value: 'gpt openrouter' } });
  expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['GPT-5']);
  fireEvent.change(search, { target: { value: 'gemini' } });
  expect(screen.queryAllByRole('option')).toHaveLength(0);
  expect(screen.getByText('No models match your search.')).toBeTruthy();

  fireEvent.change(search, { target: { value: 'codex' } });
  const option = screen.getByRole('option', { name: 'GPT-5 Codex' });
  fireEvent.click(option);
  expect(document.querySelector('output')?.textContent).toBe('gpt-codex');
  expect(trigger.textContent).toContain('GPT-5 Codex');
});
