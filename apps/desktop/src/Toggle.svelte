<script lang="ts">
  let {
    label,
    checked,
    disabled = false,
    onchange,
  }: {
    label: string;
    checked: boolean;
    disabled?: boolean;
    onchange: (checked: boolean) => void;
  } = $props();
</script>

<label class="relative block h-[23px] w-[40px] shrink-0">
  <input
    class="peer absolute inset-0 z-[1] m-0 h-full min-h-0 w-full cursor-pointer p-0 opacity-0"
    type="checkbox"
    aria-label={label}
    {checked}
    {disabled}
    onchange={(event) => onchange(event.currentTarget.checked)}
  />
  <span
    aria-hidden="true"
    class="block h-[23px] w-[40px] rounded-[20px] bg-[#3b4b51] transition-colors duration-200 after:absolute after:top-[3px] after:left-[3px] after:block after:h-[17px] after:w-[17px] after:rounded-full after:bg-[#d8e3df] after:transition-transform after:duration-200 after:content-[''] peer-checked:bg-[#4ba793] peer-checked:after:translate-x-[17px] peer-focus-visible:outline-2 peer-focus-visible:outline-solid peer-focus-visible:outline-accent peer-focus-visible:outline-offset-[3px] peer-disabled:opacity-40"
  ></span>
</label>
