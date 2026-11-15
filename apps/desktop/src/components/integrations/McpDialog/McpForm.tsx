import { Dialog } from '@base-ui/react/dialog';
import { useForm, useSelector } from '@tanstack/react-form';
import { useId, useImperativeHandle, useRef, useState, type RefObject } from 'react';
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
const transports: { value: Mcp['transport']; label: string }[] = [
  { value: 'http', label: 'Streamable HTTP' },
  { value: 'sse', label: 'SSE' },
  { value: 'stdio', label: 'Local process (stdio)' },
];

const argsError = 'Arguments must be a JSON array of strings.';
const envError = 'Environment must be a JSON object with string values.';

function parseJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}

function parseArgs(input: string) {
  const args = parseJson(input);
  return Array.isArray(args) && args.every((item) => typeof item === 'string') ? args : undefined;
}

function parseEnv(input: string) {
  const env = parseJson(input);
  return env &&
    typeof env === 'object' &&
    !Array.isArray(env) &&
    Object.values(env).every((value) => typeof value === 'string')
    ? env
    : undefined;
}

function payloadFor(values: McpFields) {
  const isLocal = values.transport === 'stdio';
  const args = isLocal ? parseArgs(values.args) : [];
  if (!args) throw Error(argsError);
  const hasEnv = isLocal && !!values.env.trim();
  const env = hasEnv ? parseEnv(values.env) : undefined;
  if (hasEnv && !env) throw Error(envError);

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
  const argsInput = useRef<HTMLInputElement>(null);
  const envInput = useRef<HTMLTextAreaElement>(null);
  const errorId = useId();
  const [notice, setNotice] = useState<{
    kind: 'pending' | 'success' | 'error';
    text: string;
  } | null>(null);
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
    validators: {
      onSubmit: ({ value }) => {
        if (value.transport !== 'stdio') return;
        const args = parseArgs(value.args) ? undefined : argsError;
        const env = value.env.trim() && !parseEnv(value.env) ? envError : undefined;
        if (args || env) return { fields: { args, env } };
      },
    },
    onSubmitInvalid: ({ formApi }) => {
      setNotice(null);
      const invalid = formApi.getFieldMeta('args')?.errors.length ? argsInput : envInput;
      invalid.current?.focus();
    },
    onSubmit: async ({ value, meta }) => {
      const save = meta === 'save';
      setNotice({ kind: 'pending', text: save ? 'Saving connection…' : 'Testing connection…' });
      try {
        const result = await request<{ count: number }>(
          save ? '/mcps/save' : '/mcps/test',
          payloadFor(value),
        );
        if (save) {
          await saved();
        } else {
          setNotice({ kind: 'success', text: `Connected. ${result.count} tools available.` });
        }
      } catch (error) {
        setNotice({ kind: 'error', text: String(error).replace(/^Error: /, '') });
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
      <fieldset disabled={busy && notice?.kind === 'pending'} className="m-0 min-w-0 border-0 p-0">
        <div className="form-grid gap-[16px] grid grid-cols-[1fr_1fr]">
          <label className={labelClass}>
            Name
            <form.Field name="name">
              {(field) => (
                <Input
                  ref={server ? undefined : firstField}
                  value={field.state.value}
                  onChange={({ currentTarget }) => field.handleChange(currentTarget.value)}
                  disabled={!!server}
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
                  onValueChange={field.handleChange}
                  options={transports}
                />
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
            <form.Field name="args">
              {(field) => {
                const error = field.state.meta.errors[0];
                const inputId = errorId + '-args';
                return (
                  <div className={labelClass}>
                    <label htmlFor={inputId}>
                      Arguments <span className="muted text-muted text-[10px]">JSON array</span>
                    </label>
                    <Input
                      id={inputId}
                      ref={argsInput}
                      value={field.state.value}
                      onChange={({ currentTarget }) => field.handleChange(currentTarget.value)}
                      aria-invalid={!!error}
                      aria-describedby={error ? inputId + '-error' : undefined}
                    />
                    {error && (
                      <span id={inputId + '-error'} className="text-[11px] text-[#efafa2]">
                        {error}
                      </span>
                    )}
                  </div>
                );
              }}
            </form.Field>
            <form.Field name="env">
              {(field) => {
                const error = field.state.meta.errors[0];
                const inputId = errorId + '-env';
                return (
                  <div className={labelClass}>
                    <label htmlFor={inputId}>
                      Environment{' '}
                      <span className="muted text-muted text-[10px]">
                        Blank keeps stored values
                      </span>
                    </label>
                    <Textarea
                      id={inputId}
                      ref={envInput}
                      value={field.state.value}
                      onChange={({ currentTarget }) => field.handleChange(currentTarget.value)}
                      aria-invalid={!!error}
                      aria-describedby={error ? inputId + '-error' : undefined}
                      rows={2}
                      placeholder={'{"API_KEY":"…"}'}
                    />
                    {error && (
                      <span id={inputId + '-error'} className="text-[11px] text-[#efafa2]">
                        {error}
                      </span>
                    )}
                  </div>
                );
              }}
            </form.Field>
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
      </fieldset>
      <Dialog.Description className="text-[11px] text-muted">
        Test the connection before saving. Local commands run on your computer.
      </Dialog.Description>
      <p
        className={`notice-inline text-[11px] text-muted [&.error]:text-[#efafa2]${notice?.kind === 'error' ? ' error' : ''}`}
        role="status"
        aria-atomic="true"
      >
        {notice?.text}
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
