import { test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import Panels from './pages/Panels.svelte';
import type { DesktopController } from './desktop-controller.svelte';
import { exportTemplate } from '@wisp/protocol/panel-template';

afterEach(cleanup);
const template = exportTemplate({
  id: 'source',
  title: 'Consumables',
  references: {},
  ui: [
    { id: 'root', kind: 'card', title: 'Bags only' },
    { id: 'note', parent: 'root', kind: 'text', text: 'Bring only what you need.' },
    ...[2589, 2592, 4306].map((id, i) => ({
      id: `item${id}`,
      parent: 'root',
      kind: 'stat',
      label: ['Linen Cloth', 'Wool Cloth', 'Silk Cloth'][i],
      value: '987',
    })),
  ],
  bindings: [2589, 2592, 4306].map((itemId) => ({
    nodeId: `item${itemId}`,
    source: 'item_count',
    itemId,
    target: 20,
  })),
});
test('paste preview exposes all goals; recipient and confirmation are deliberate, cancel never imports', async () => {
  let finish!: () => void;
  const importPanelTemplate = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const app = {
    loading: false,
    locked: false,
    status: {
      gameConnected: false,
      panels: [],
      panelRecipients: [{ characterKey: 'B', label: 'B · Synthetic realm' }],
    },
    importPanelTemplate,
  } as unknown as DesktopController;
  render(Panels, { app });
  await fireEvent.click(screen.getByRole('button', { name: 'Import template' }));
  await fireEvent.input(screen.getByLabelText('Paste template'), {
    target: { value: JSON.stringify(template) },
  });
  await fireEvent.click(screen.getByRole('button', { name: 'Preview template' }));
  expect(screen.getAllByText(/identity\/availability not verified by this template/)).toHaveLength(
    1,
  );
  expect(screen.getByText('Bags only')).toBeTruthy();
  expect(screen.getByText('Bring only what you need.')).toBeTruthy();
  for (const label of ['Linen Cloth', 'Wool Cloth', 'Silk Cloth']) {
    expect(screen.getByText(label)).toBeTruthy();
  }
  expect(screen.queryByText('987')).toBeNull();
  const save = screen.getByRole('button', { name: 'Create new tracker' });
  expect((screen.getByLabelText('Recipient character') as HTMLSelectElement).value).toBe('');
  expect((save as HTMLButtonElement).disabled).toBe(true);
  await fireEvent.click(screen.getByLabelText(/I confirm/));
  expect((save as HTMLButtonElement).disabled).toBe(true);
  await fireEvent.change(screen.getByLabelText('Recipient character'), { target: { value: 'B' } });
  await fireEvent.input(screen.getByLabelText('Target for Wool Cloth'), { target: { value: '0' } });
  expect((save as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('alert').textContent).toMatch(/positive whole/);
  await fireEvent.input(screen.getByLabelText('Target for Wool Cloth'), {
    target: { value: '40' },
  });
  await fireEvent.click(save);
  await fireEvent.click(save);
  expect(importPanelTemplate).toHaveBeenCalledTimes(1);
  expect(importPanelTemplate).toHaveBeenCalledWith('B', expect.stringContaining('40'));
  finish();
  await screen.findByText(/New tracker saved/);
});
test('invalid input and cancel cannot save; export copy failure leaves selectable manual text', async () => {
  const importPanelTemplate = vi.fn();
  const app = {
    loading: false,
    locked: false,
    status: { gameConnected: false, panels: [{ id: 'a', title: 'Consumables', character: 'A' }] },
    exportPanelTemplate: vi.fn(async () => JSON.stringify(template)),
    importPanelTemplate,
  } as unknown as DesktopController;
  render(Panels, { app });
  await fireEvent.click(screen.getByRole('button', { name: 'Export template' }));
  expect(screen.getByText(/Remaining text may contain personal information/)).toBeTruthy();
  await fireEvent.click(screen.getByRole('button', { name: 'Copy template' }));
  expect(await screen.findByText(/Clipboard unavailable/)).toBeTruthy();
  expect(screen.getByLabelText('Template for manual copy')).toBeTruthy();
  await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Import template' }));
  await fireEvent.input(screen.getByLabelText('Paste template'), { target: { value: '{}' } });
  await fireEvent.click(screen.getByRole('button', { name: 'Preview template' }));
  expect(screen.getByRole('alert')).toBeTruthy();
  await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(importPanelTemplate).not.toHaveBeenCalled();
  await fireEvent.click(screen.getByRole('button', { name: 'Import template' }));
  await fireEvent.input(screen.getByLabelText('Paste template'), {
    target: { value: JSON.stringify(template) },
  });
  await fireEvent.click(screen.getByRole('button', { name: 'Preview template' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(importPanelTemplate).not.toHaveBeenCalled();
});
