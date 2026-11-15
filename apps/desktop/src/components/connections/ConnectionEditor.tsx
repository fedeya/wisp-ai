import { useForm, useSelector } from '@tanstack/react-form';
import {
  connectionModel,
  providerDefinitions,
  type ConnectionModel,
  type ConnectionView,
  type ProviderId,
} from '@wisp/protocol/providers';
import { useState } from 'react';
import { request } from '../../api';
import { ActionProgress } from '../ui/ActionProgress';
import { Button, Input, NumberInput, Select } from '../ui/Controls';
import { desktopLocked } from '../../desktop-controller';
import { useDesktop, useDesktopActions } from '../../use-desktop';

const labelClass = 'text-[12px] font-medium text-[#bdcccf]';
const modelFieldsClass =
  'api-model-fields gap-[10px] grid grid-cols-[minmax(0,_1fr)_minmax(160px,_0.7fr)_auto] items-center max-sm:grid-cols-[1fr]';

type ConnectionFields = {
  provider: ProviderId;
  name: string;
  apiKey: string;
  baseURL: string;
  models: ConnectionModel[];
  modelId: string;
  contextWindow: number | undefined;
};

const contextWindowSchema = connectionModel.shape.contextWindow;

function validateContextWindow({ value }: { value: number | undefined }) {
  if (value === undefined) return 'Enter a context window for this model.';
  if (!contextWindowSchema.safeParse(value).success) {
    return 'Enter a whole number between 1 and 100,000,000.';
  }
}

function connectionDetails(id: string | undefined, value: ConnectionFields) {
  const provider = providerDefinitions.find((item) => item.id === value.provider)!;
  return {
    id,
    provider: value.provider,
    name: value.name.trim() || provider.name,
    apiKey: value.apiKey || undefined,
    baseURL: value.baseURL.trim() || undefined,
  };
}

export default function ConnectionEditor({
  connection,
  close,
}: {
  connection?: ConnectionView;
  close: () => void;
}) {
  const app = useDesktop((state) => ({
    busy: state.busy,
    busyTarget: state.busyTarget,
    locked: desktopLocked(state),
  }));
  const { loadModels, work } = useDesktopActions();
  const [discovered, setDiscovered] = useState<ConnectionModel[]>([]);
  const defaultValues: ConnectionFields = {
    provider: connection?.provider || 'anthropic',
    name: connection?.name || '',
    apiKey: '',
    baseURL: connection?.baseURL || '',
    models: connection?.models || [],
    modelId: '',
    contextWindow: undefined,
  };
  const form = useForm({
    defaultValues,
    onSubmit: async ({ value }) => {
      await work(
        'Saving AI connection',
        async () => {
          await request('/connections/save', {
            ...connectionDetails(connection?.id, value),
            models: value.models,
          });
          close();
          await loadModels();
        },
        'Connection saved. Choose a default model below.',
        'connection-editor',
      );
    },
  });
  const { provider, baseURL, modelId, models } = useSelector(form.store, (state) => state.values);
  const formCanSubmit = useSelector(form.store, (state) => state.canSubmit);
  const canSave = !app.locked && models.length > 0 && !modelId.trim() && formCanSubmit;
  const canTest =
    !app.locked &&
    models.length > 0 &&
    models.every(({ contextWindow }) => contextWindowSchema.safeParse(contextWindow).success);
  const definition = providerDefinitions.find((item) => item.id === provider)!;

  function addModel() {
    const value = form.state.values;
    const id = value.modelId.trim();
    if (!id || value.models.some((model) => model.id === id)) return;
    const found = discovered.find((model) => model.id === id);
    void form.pushFieldValue('models', {
      ...found,
      id,
      contextWindow: value.contextWindow || found?.contextWindow,
    });
    form.setFieldValue('modelId', '');
    form.setFieldValue('contextWindow', undefined);
  }

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave && !form.state.isSubmitting) void form.handleSubmit();
      }}
      className="field-section api-connection-form gap-[12px] border-t-[1px] [border-top-style:solid] border-t-[var(--border)] mt-[26px] pt-[22px] grid"
    >
      <label className={labelClass} htmlFor="ai-provider">
        Provider
      </label>
      <form.Field
        name="provider"
        listeners={{
          onChange: () => {
            form.setFieldValue('models', []);
            setDiscovered([]);
            form.setFieldValue('modelId', '');
            form.setFieldValue('baseURL', '');
            form.setFieldValue('apiKey', '');
          },
        }}
      >
        {(field) => (
          <Select
            id="ai-provider"
            value={field.state.value}
            onChange={({ currentTarget }) => field.handleChange(currentTarget.value as ProviderId)}
            disabled={app.locked || !!connection}
          >
            {providerDefinitions.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </Select>
        )}
      </form.Field>
      <label className={labelClass} htmlFor="ai-name">
        Connection name
      </label>
      <form.Field name="name">
        {(field) => (
          <Input
            id="ai-name"
            value={field.state.value}
            onChange={({ currentTarget }) => field.handleChange(currentTarget.value)}
            placeholder={definition.name}
            maxLength={80}
            disabled={app.locked}
          />
        )}
      </form.Field>
      <label className={labelClass} htmlFor="ai-key">
        API key{' '}
        {connection
          ? '(leave blank to keep saved key)'
          : provider === 'compatible'
            ? '(optional for local servers)'
            : ''}
      </label>
      <form.Field name="apiKey">
        {(field) => (
          <Input
            id="ai-key"
            type="password"
            value={field.state.value}
            onChange={({ currentTarget }) => field.handleChange(currentTarget.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={app.locked}
          />
        )}
      </form.Field>
      <form.Field name="baseURL">
        {(field) => {
          const input = (
            <Input
              className={provider === 'compatible' ? undefined : 'mt-[8px]'}
              id="ai-url"
              value={field.state.value}
              onChange={({ currentTarget }) => field.handleChange(currentTarget.value)}
              placeholder={
                provider === 'compatible' ? 'http://localhost:1234/v1' : definition.baseURL
              }
              disabled={app.locked}
            />
          );
          return provider === 'compatible' ? (
            <>
              <label className={labelClass} htmlFor="ai-url">
                Base URL
              </label>
              {input}
            </>
          ) : (
            <details>
              <summary className="cursor-pointer text-muted text-[13px]">Custom endpoint</summary>
              <label htmlFor="ai-url">Base URL</label>
              {input}
            </details>
          );
        }}
      </form.Field>
      <div className="label-row flex items-center justify-between">
        <label className={labelClass} htmlFor="ai-model">
          Models available in Wisp
        </label>
        <Button
          intent="quiet"
          size="text"
          disabled={app.locked || (provider === 'compatible' && !baseURL)}
          onClick={() =>
            work(
              'Loading provider models',
              async () => {
                const result = await request<{ models: ConnectionModel[] }>(
                  '/connections/discover',
                  connectionDetails(connection?.id, form.state.values),
                );
                setDiscovered(result.models);
              },
              'Models loaded. Choose models to add below.',
              'connection-editor',
            )
          }
        >
          Load model list
        </Button>
      </div>
      <p className="field-hint text-[11px]! text-muted mt-[12px]">
        Choose a model with tool calling. You can enter its exact ID if the provider cannot list
        models.
      </p>
      <div className={modelFieldsClass}>
        <form.Field name="modelId">
          {(field) => (
            <Input
              id="ai-model"
              value={field.state.value}
              onChange={({ currentTarget }) => field.handleChange(currentTarget.value)}
              list="ai-model-options"
              placeholder={definition.example}
              disabled={app.locked}
            />
          )}
        </form.Field>
        <datalist id="ai-model-options">
          {discovered.map((model) => (
            <option value={model.id} key={model.id}>
              {model.name || model.id}
            </option>
          ))}
        </datalist>
        <form.Field name="contextWindow">
          {(field) => (
            <NumberInput
              aria-label="Context window in tokens"
              min={1}
              max={100000000}
              value={field.state.value}
              onValueChange={field.handleChange}
              placeholder="Context tokens"
              disabled={app.locked}
            />
          )}
        </form.Field>
        <Button disabled={app.locked || !modelId.trim()} onClick={addModel}>
          Add model
        </Button>
      </div>
      <form.Field name="models" mode="array">
        {(field) =>
          field.state.value.map((model, index) => (
            <div className={modelFieldsClass} key={model.id}>
              <span className="[overflow-wrap:anywhere]">{model.id}</span>
              <form.Field
                name={`models[${index}].contextWindow`}
                validators={{ onChange: validateContextWindow, onSubmit: validateContextWindow }}
              >
                {(contextField) => {
                  const error = contextField.state.meta.errors[0];
                  const errorId = `model-context-error-${index}`;
                  return (
                    <div>
                      <NumberInput
                        aria-label={`Context window for ${model.id}`}
                        aria-invalid={!!error}
                        aria-describedby={error ? errorId : undefined}
                        min={1}
                        max={100000000}
                        value={contextField.state.value}
                        onValueChange={contextField.handleChange}
                        placeholder="Context tokens (required)"
                        disabled={app.locked}
                      />
                      {error && (
                        <p id={errorId} role="alert" className="mt-1 text-xs text-[#f0b4aa]">
                          {error}
                        </p>
                      )}
                    </div>
                  );
                }}
              </form.Field>
              <Button
                intent="quiet"
                disabled={app.locked}
                aria-label={`Remove ${model.id}`}
                onClick={() => void field.removeValue(index)}
              >
                Remove
              </Button>
            </div>
          ))
        }
      </form.Field>
      <p className="field-hint text-[11px]! text-muted mt-[12px]">
        Set the context window for every model so Wisp can manage long conversations. For local
        models, use the tokens your server allocates. Choose reasoning per chat in game when the
        model supports it. Default keeps the provider's setting; higher effort can use more time and
        tokens.
      </p>
      <div className="actions gap-[10px] mt-[22px] flex flex-wrap items-center">
        <Button
          disabled={!canTest}
          onClick={() =>
            work(
              'Testing AI connection',
              () => {
                const value = form.state.values;
                return request('/connections/test', {
                  ...connectionDetails(connection?.id, value),
                  models: value.models,
                });
              },
              'Connection and tool calling verified for the first model.',
              'connection-editor',
            )
          }
        >
          Test first model
        </Button>
        <Button type="submit" intent="primary" disabled={!canSave}>
          Save connection
        </Button>
        <Button intent="quiet" disabled={app.locked} onClick={close}>
          Cancel
        </Button>
      </div>
      <p className="field-hint text-[11px]! text-muted mt-[12px]">
        Testing sends a small request to the provider and may incur usage charges.
      </p>
      <ActionProgress label={app.busyTarget === 'connection-editor' ? app.busy : ''} />
    </form>
  );
}
