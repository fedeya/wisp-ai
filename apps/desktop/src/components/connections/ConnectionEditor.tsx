import { useForm, useSelector } from '@tanstack/react-form';
import {
  connectionModel,
  maxConnectionModels,
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
const providerOptions = providerDefinitions.map(({ id, name }) => ({ value: id, label: name }));
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
  initialProvider,
  close,
}: {
  connection?: ConnectionView;
  initialProvider?: ProviderId;
  close: () => void;
}) {
  const app = useDesktop((state) => ({
    busy: state.busy,
    busyTarget: state.busyTarget,
    locked: desktopLocked(state) || !state.status?.ready,
  }));
  const { work } = useDesktopActions();
  const [discovered, setDiscovered] = useState<ConnectionModel[]>([]);
  const [showModelSettings, setShowModelSettings] = useState(false);
  const defaultValues: ConnectionFields = {
    provider: connection?.provider ?? initialProvider ?? 'anthropic',
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
        },
        'Connection saved.',
        'connection-editor',
      );
    },
  });
  const { provider, baseURL, apiKey, modelId, models } = useSelector(
    form.store,
    (state) => state.values,
  );
  const formCanSubmit = useSelector(form.store, (state) => state.canSubmit);
  const canDiscover =
    !app.locked &&
    (provider === 'compatible' ? !!baseURL.trim() : !!apiKey.trim() || !!connection?.hasKey);
  const canSave =
    !app.locked &&
    (!initialProvider || canDiscover) &&
    models.length > 0 &&
    !modelId.trim() &&
    formCanSubmit;
  const canTest =
    !app.locked &&
    models.length > 0 &&
    models.every(({ contextWindow }) => contextWindowSchema.safeParse(contextWindow).success);
  const definition = providerDefinitions.find((item) => item.id === provider)!;
  const missingContext = discovered.some((model) => !model.contextWindow);

  function discoverModels() {
    return work(
      'Loading provider models',
      async () => {
        const values = form.state.values;
        const result = await request<{ models: ConnectionModel[] }>(
          '/connections/discover',
          connectionDetails(connection?.id, values),
        );
        const catalog = new Map<string, ConnectionModel>();
        for (const model of result.models) {
          const parsed = connectionModel.safeParse(model);
          if (parsed.success) catalog.set(parsed.data.id, parsed.data);
        }
        const usableModels = [...catalog.values()];
        setDiscovered(usableModels);
        if (!initialProvider) return;
        const enabled = new Map(values.models.map((model) => [model.id, model]));
        for (const model of usableModels) {
          if (enabled.size >= maxConnectionModels) break;
          if (!enabled.has(model.id) && model.contextWindow) enabled.set(model.id, model);
        }
        form.setFieldValue('models', [...enabled.values()]);
        if (enabled.size === 0) setShowModelSettings(true);
      },
      initialProvider ? 'Model list loaded.' : 'Models loaded. Choose models to add below.',
      'connection-editor',
    );
  }

  function addModel() {
    const value = form.state.values;
    const id = value.modelId.trim();
    if (
      !id ||
      value.models.length >= maxConnectionModels ||
      value.models.some((model) => model.id === id)
    ) {
      return;
    }
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
      className={`field-section api-connection-form grid border-t [border-top-style:solid] border-t-border ${initialProvider ? 'mt-4 gap-2.5 pt-4' : 'mt-[26px] gap-3 pt-[22px]'}`}
    >
      {!initialProvider && (
        <>
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
                onValueChange={field.handleChange}
                options={providerOptions}
                disabled={app.locked || !!connection}
              />
            )}
          </form.Field>
        </>
      )}
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
      <div className="label-row flex flex-wrap items-center justify-between gap-2">
        {initialProvider ? (
          <h3 className="m-0 text-[14px] font-semibold">Models</h3>
        ) : (
          <label className={labelClass} htmlFor="ai-model">
            Models available in Wisp
          </label>
        )}
        <Button
          intent="quiet"
          size="text"
          disabled={
            initialProvider ? !canDiscover : app.locked || (provider === 'compatible' && !baseURL)
          }
          onClick={discoverModels}
        >
          {initialProvider ? 'Discover models' : 'Load model list'}
        </Button>
      </div>
      {initialProvider && (
        <>
          {models.length > 0 ? (
            <div>
              <p className="mt-0 text-[13px] text-accent">
                {models.length} {models.length === 1 ? 'model' : 'models'} available after saving
              </p>
              <ul className="mt-2 mb-0 pl-5 text-[13px] text-muted">
                {models.slice(0, 4).map((model) => (
                  <li key={model.id}>{model.name || model.id}</li>
                ))}
                {models.length > 4 && <li>And {models.length - 4} more</li>}
              </ul>
            </div>
          ) : (
            <p className="mt-0 text-[13px] text-muted">
              {discovered.length > 0
                ? 'Add a model with its context window below.'
                : 'Discover models from this provider or add them manually.'}
            </p>
          )}
          {missingContext && models.length > 0 && (
            <p className="mt-0 text-[13px] text-muted">
              Some discovered models need a context window before they can be added manually.
            </p>
          )}
          <Button
            intent="quiet"
            size="text"
            className="w-fit"
            aria-expanded={showModelSettings}
            aria-controls="connection-model-settings"
            onClick={() => setShowModelSettings((open) => !open)}
          >
            {showModelSettings
              ? 'Hide model settings'
              : models.length
                ? 'Manage models'
                : 'Add models manually'}
          </Button>
        </>
      )}
      <div
        id="connection-model-settings"
        hidden={!!initialProvider && !showModelSettings}
        className={`gap-3 ${!initialProvider || showModelSettings ? 'grid' : 'hidden'}`}
      >
        {initialProvider && (
          <label htmlFor="ai-model" className={labelClass}>
            Model ID
          </label>
        )}
        <p className="field-hint text-[11px]! text-muted mt-[12px]">
          Use models with tool calling. You can enter an exact model ID when the provider cannot
          list models.
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
          <Button
            disabled={app.locked || !modelId.trim() || models.length >= maxConnectionModels}
            onClick={addModel}
          >
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
          model supports it. Default keeps the provider's setting; higher effort can use more time
          and tokens.
        </p>
      </div>
      <div
        className={`actions flex flex-wrap items-center gap-2.5 ${initialProvider ? 'mt-2' : 'mt-[22px]'}`}
      >
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
