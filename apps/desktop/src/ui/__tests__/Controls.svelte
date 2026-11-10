<script lang="ts">
  import Input from "../Input.svelte";
  import Select from "../Select.svelte";
  import Textarea from "../Textarea.svelte";
  import Checkbox from "../Checkbox.svelte";
  import Button from "../Button.svelte";
  let name = $state("Wisp");
  let count = $state<number | undefined>(4);
  let choice = $state("one");
  let note = $state("Initial note");
  let checked = $state(false);
  let submits = $state(0);
</script>

<form
  onsubmit={(event) => {
    event.preventDefault();
    submits += 1;
  }}
>
  <Input aria-label="Name" bind:value={name} />
  <Input aria-label="Count" type="number" bind:value={count} />
  <Select aria-label="Choice" bind:value={choice}
    ><option value="one">One</option><option value="two">Two</option></Select
  >
  <Textarea aria-label="Note" bind:value={note} />
  <Checkbox aria-label="Enabled" bind:checked />
  <Button
    onclick={() => {
      name = "Reset";
      count = 7;
      choice = "one";
      note = "Reset note";
      checked = false;
    }}>Reset</Button
  >
  <Button type="submit">Submit</Button>
</form>
<output data-testid="values"
  >{JSON.stringify({
    name,
    count: count ?? null,
    choice,
    note,
    checked,
    submits,
  })}</output
>
