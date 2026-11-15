import { useState } from 'react';
import { Button, Checkbox, Input, NumberInput, Select, Textarea } from '../controls';

export default function Controls() {
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
