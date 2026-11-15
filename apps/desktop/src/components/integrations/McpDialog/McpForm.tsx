import { Dialog } from '@base-ui/react/dialog';
import { useForm, useSelector } from '@tanstack/react-form';
import { useImperativeHandle, useState, type RefObject } from 'react';
import { request, type Mcp } from '../../../api';
import Icon from '../../ui/Icon';
import { button } from '../../ui/Controls/styles';
import { Button, Checkbox, Input, Select, Textarea } from '../../ui/Controls';

type SubmitMode = 'save' | 'test';
export type McpFormActions = { isSubmitting: () => boolean };

type McpFields = {
  name: string;
  description: string;
  transport: Mcp['transport'];
  address: string;
  args: string;
  env: string;
  token: string;
  clearToken: boolean;
  enabled: boolean;
};

export type McpDialogProps = {
  server: Mcp | null;
  formRef: RefObject<McpFormActions | null>;
  close: () => void;
  saved: () => Promise<void>;
};

const labelClass = 'gap-[8px] mx-0 my-[15px] flex flex-col text-[#b6c9cf] text-[12px]';
const checkRowClass =
  'check-row gap-[9px] mx-0 my-[15px] flex items-center text-[#b6c9cf] text-[12px]';
const checkboxClass = 'w-[15px] h-[15px] min-h-[0] [accent-color:var(--accent)]';

function payloadFor(values: McpFields) {
  const isLocal = values.transport === 'stdio';
  const args: unknown = isLocal ? JSON.parse(values.args) : [];
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) {
    throw Error('Arguments must be a JSON array of strings.');
  }
  const env: unknown = isLocal && values.env.trim() ? JSON.parse(values.env) : undefined;
  if (
    env !== undefined &&
    (!env ||
      typeof env !== 'object' ||
      Array.isArray(env) ||
      Object.values(env).some((v) => typeof v !== 'string'))
  ) {
    throw Error('Environment must be a JSON object with string values.');
  }

  return {
    server: {
      name: values.name,
      description: values.description,
      transport: values.transport,
      enabled: values.enabled,
      args,
      ...(isLocal ? { command: values.address } : { url: values.address }),
    },
    ...(env ? { env } : {}),
    ...(values.clearToken ? { token: '' } : values.token ? { token: values.token } : {}),
  };
}

export default function McpForm({
  server,
  formRef,
  close,
  saved,
  firstField,
}: McpDialogProps & { firstField: RefObject<HTMLInputElement | null> }) {
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const defaultValues: McpFields = {
    name: server?.name || '',
    description: server?.description || '',
    transport: server?.transport || 'http',
    address: server?.url || server?.command || '',
    args: JSON.stringify(server?.args || []),
    env: '',
    token: '',
    clearToken: false,
    enabled: server?.enabled ?? true,
  };
  const form = useForm({
    defaultValues,
    onSubmitMeta: 'save' as SubmitMode,
    onSubmit: async ({ value, meta }) => {
      const save = meta === 'save';
      setNotice({ text: save ? 'Saving connection…' : 'Testing connection…' });
      try {
        const result = await request<{ count: number }>(
          save ? '/mcps/save' : '/mcps/test',
          payloadFor(value),
        );
        if (save) {
          await saved();
        } else {
          setNotice({ text: `Connected. ${result.count} tools available.` });
        }
      } catch (error) {
        setNotice({ text: String(error).replace(/^Error: /, ''), error: true });
        return;
      }
      if (save) close();
    },
  });
  useImperativeHandle(formRef, () => ({ isSubmitting: () => form.state.isSubmitting }), [form]);
  const busy = useSelector(form.store, (state) => state.isSubmitting);
  const addressReady = useSelector(form.store, ({ values }) => !!values.name && !!values.address);
  const isLocal = useSelector(form.store, ({ values }) => values.transport === 'stdio');

  function submit(mode: SubmitMode) {
    if (addressReady && !form.state.isSubmitting) void form.handleSubmit(mode);
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit('save');
      }}
    >
      <header className="flex justify-between items-center mb-[22px]">
        <div>
          <p className="eyebrow gap-[8px] text-[#8fa5ac] text-[9px] font-semibold tracking-[1.3px] flex items-center">
            TOOL CONNECTION
          </p>
          <Dialog.Title className="text-[23px] mt-[7px]">
            {server ? 'Edit connection' : 'Add an MCP'}
          </Dialog.Title>
        </div>
        <Dialog.Close
          className={button({ intent: 'quiet', size: 'icon' })}
          aria-label="Close dialog"
          disabled={busy}
        >
          <Icon name="close" />
        </Dialog.Close>
      </header>
      <div className="form-grid gap-[16px] grid grid-cols-[1fr_1fr]">
        <label className={labelClass}>
          Name
          <form.Field name="name">
            {(field) => (
              <Input
                ref={server ? undefined : firstField}
                value={field.state.value}
                onChange={({ currentTarget }) => field.handleChange(currentTarget.value)}
                disabled={!!server || busy}
                placeholder="my_connection"
              />
            )}
          </form.Field>
        </label>
        <label className={labelClass}>
          Transport
          <form.Field name="transport">
            {(field) => (
              <Select
                value={field.state.value}
                onChange={({ currentTarget }) =>
                  field.handleChange(currentTarget.value as Mcp['transport'])
                }
                disabled={busy}
              >
                <option value="http">Streamable HTTP</option>
                <option value="sse">SSE</option>
                <option value="stdio">Local process (stdio)</option>
              </Select>
            )}
          </form.Field>
        </label>
      </div>
      <label className={labelClass}>
        Description
        <form.Field name="description">
          {(field) => (
            <Input
              value={field.state.value}
              onChange={({ currentTarget }) => field.handleChange(currentTarget.value)}
              placeholder="What can this connection help with?"
            />
          )}
        </form.Field>
      </label>
      <label className={labelClass}>
        {isLocal ? 'Executable or command' : 'Endpoint URL'}
        <form.Field name="address">
          {(field) => (
            <Input
              ref={server ? firstField : undefined}
              value={field.state.value}
              onChange={({ currentTarget }) => field.handleChange(currentTarget.value)}
              placeholder={isLocal ? 'npx' : 'https://example.com/mcp'}
            />
          )}
        </form.Field>
      </label>
      {isLocal ? (
        <>
          <label className={labelClass}>
            Arguments <span className="muted text-muted text-[10px]">JSON array</span>
            <form.Field name="args">
              {(field) => (
                <Input
                  value={field.state.value}
                  onChange={({ currentTarget }) => field.handleChange(currentTarget.value)}
                />
              )}
            </form.Field>
          </label>
          <label className={labelClass}>
            Environment{' '}
            <span className="muted text-muted text-[10px]">Blank keeps stored values</span>
            <form.Field name="env">
              {(field) => (
                <Textarea
                  rows={2}
                  value={field.state.value}
                  onChange={({ currentTarget }) => field.handleChange(currentTarget.value)}
                  placeholder={'{"API_KEY":"…"}'}
                />
              )}
            </form.Field>
          </label>
        </>
      ) : (
        <>
          <label className={labelClass}>
            Bearer token{' '}
            <span className="muted text-muted text-[10px]">Blank keeps stored token</span>
            <form.Field name="token">
              {(field) => (
                <Input
                  type="password"
                  value={field.state.value}
                  onChange={({ currentTarget }) => field.handleChange(currentTarget.value)}
                  autoComplete="off"
                />
              )}
            </form.Field>
            {server?.hasToken && (
              <span className="muted text-muted text-[10px]">A token is securely stored.</span>
            )}
          </label>
          <label className={checkRowClass}>
            <form.Field name="clearToken">
              {(field) => (
                <Checkbox
                  className={checkboxClass}
                  checked={field.state.value}
                  onChange={({ currentTarget }) => field.handleChange(currentTarget.checked)}
                />
              )}
            </form.Field>
            Remove stored token
          </label>
        </>
      )}
      <label className={checkRowClass}>
        <form.Field name="enabled">
          {(field) => (
            <Checkbox
              className={checkboxClass}
              checked={field.state.value}
              onChange={({ currentTarget }) => field.handleChange(currentTarget.checked)}
            />
          )}
        </form.Field>
        Enable connection
      </label>
      <p
        className={`notice-inline text-[11px] text-muted min-h-[32px] [&.error]:text-[#efafa2]${notice?.error ? ' error' : ''}`}
        aria-live="polite"
      >
        {notice?.text || 'Test the connection before saving. Local commands run on your computer.'}
      </p>
      <footer className="gap-[12px] flex justify-end mt-[22px]">
        <Button onClick={() => submit('test')} disabled={busy || !addressReady}>
          Test connection
        </Button>
        <Button intent="primary" type="submit" disabled={busy || !addressReady}>
          {busy ? 'Working…' : 'Save connection'}
        </Button>
      </footer>
    </form>
  );
}
