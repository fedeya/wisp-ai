import { useForm, useSelector } from '@tanstack/react-form';
import {
  connectionModel,
  maxConnectionModels,
  providerDefinitions,
  type ConnectionModel,
  type ConnectionView,
  type DiscoveredConnectionModel,
  type ProviderId,
} from '@wisp/protocol/providers';
import { useState } from 'react';
import { request } from '../../api';
import { ActionProgress } from '../ui/ActionProgress';
import { Button, Input, NumberInput, Select } from '../ui/Controls';
import { desktopLocked } from '../../desktop-controller';
import { useDesktop, useDesktopActions } from '../../use-desktop';
import ModelCatalog from './ModelCatalog';
import { modelProvider, ProviderLogo } from './provider-directory';

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
  const [discovered, setDiscovered] = useState<DiscoveredConnectionModel[]>([]);
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
  const hasModels =
    models.length > 0 &&
    models.every(
      ({ contextWindow }) =>
        contextWindow !== undefined && contextWindowSchema.safeParse(contextWindow).success,
    );
  const canSave =
    !app.locked &&
    (!initialProvider || canDiscover) &&
    hasModels &&
    !modelId.trim() &&
    formCanSubmit;
  const definition = providerDefinitions.find((item) => item.id === provider)!;
  const manageModels = !initialProvider || showModelSettings;

  function discoverModels() {
    return work(
      'Loading provider models',
      async () => {
        const result = await request<{ models: DiscoveredConnectionModel[] }>(
          '/connections/discover',
          connectionDetails(connection?.id, form.state.values),
        );
        setDiscovered(result.models);
        setShowModelSettings(true);
      },
      null,
      'connection-editor',
    );
  }

  function addModel(id: string, contextWindow?: number) {
    const { models } = form.state.values;
    if (!id || models.length >= maxConnectionModels || models.some((model) => model.id === id)) {
      return false;
    }
    const found = discovered.find((model) => model.id === id);
    const model = connectionModel.safeParse({
      name: found?.name,
      reasoningEfforts: found?.reasoningEfforts,
      id,
      contextWindow: contextWindow ?? found?.contextWindow,
    });
    if (!model.success) return false;
    void form.pushFieldValue('models', model.data);
    return true;
  }

  function testModel(model: ConnectionModel) {
    return work(
      'Testing AI model',
      () =>
        request('/connections/test', {
          ...connectionDetails(connection?.id, form.state.values),
          models: [model],
        }),
      `Tool calling verified for ${model.name || model.id}.`,
      'connection-editor',
    );
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
                form.setFieldValue('contextWindow', undefined);
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
        <h3 className="m-0 text-[14px] font-semibold">Models</h3>
        <Button intent="quiet" size="text" disabled={!canDiscover} onClick={discoverModels}>
          {initialProvider ? 'Discover models' : 'Load model list'}
        </Button>
      </div>
      {initialProvider && (
        <>
          <p className="m-0 text-[13px] text-muted">
            {models.length
              ? `${models.length} ${models.length === 1 ? 'model' : 'models'} selected for Wisp`
              : 'Discover models and add the ones you want to use.'}
          </p>
          <Button
            intent="quiet"
            size="text"
            className="w-fit"
            aria-expanded={showModelSettings}
            aria-controls="connection-model-settings"
            onClick={() => setShowModelSettings((open) => !open)}
          >
            {showModelSettings ? 'Hide model settings' : 'Manage models'}
          </Button>
        </>
      )}
      <div
        id="connection-model-settings"
        hidden={!manageModels}
        className={manageModels ? 'grid gap-3' : 'hidden'}
      >
        {discovered.length > 0 && (
          <ModelCatalog
            key={provider}
            provider={provider}
            models={discovered}
            selected={models}
            locked={app.locked}
            onAdd={addModel}
          />
        )}
        {models.length > 0 && <h4 className="m-0 text-[13px] font-semibold">Selected models</h4>}
        <form.Field name="models" mode="array">
          {(field) =>
            field.state.value.map((model, index) => (
              <div className={modelFieldsClass} key={model.id}>
                <div className="flex min-w-0 items-center gap-2.5">
                  <ProviderLogo provider={modelProvider(provider, model.id)} />
                  <div className="min-w-0 [overflow-wrap:anywhere]">
                    <strong className="block text-[13px]">{model.name || model.id}</strong>
                    {model.name && model.name !== model.id && (
                      <span className="block text-[12px] text-muted">{model.id}</span>
                    )}
                  </div>
                </div>
                <form.Field
                  name={`models[${index}].contextWindow`}
                  validators={{ onChange: validateContextWindow, onSubmit: validateContextWindow }}
                >
                  {(contextField) => {
                    const error = contextField.state.meta.errors[0];
                    const fieldId = `model-context-${index}`;
                    const errorId = `model-context-error-${index}`;
                    return (
                      <div>
                        <label htmlFor={fieldId} className="mb-1 block text-[12px] text-muted">
                          Context window (tokens)
                        </label>
                        <NumberInput
                          id={fieldId}
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
                <div className="flex flex-wrap gap-1">
                  <Button
                    intent="quiet"
                    disabled={!canDiscover}
                    aria-label={`Test ${model.id}`}
                    onClick={() => void testModel(model)}
                  >
                    Test
                  </Button>
                  <Button
                    intent="quiet"
                    disabled={app.locked}
                    aria-label={`Remove ${model.id}`}
                    onClick={() => void field.removeValue(index)}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ))
          }
        </form.Field>
        {models.length > 0 && (
          <p className="m-0 text-[12px] text-muted">
            Each model needs a context window. Testing a model may incur provider charges.
          </p>
        )}
        <details
          open={discovered.some(({ supportsTools }) => supportsTools === true) ? undefined : true}
        >
          <summary className="cursor-pointer text-[13px] text-muted">Add a model manually</summary>
          <div className={`${modelFieldsClass} mt-2`}>
            <form.Field name="modelId">
              {(field) => (
                <Input
                  id="ai-model"
                  aria-label="Model ID"
                  value={field.state.value}
                  onChange={({ currentTarget }) => field.handleChange(currentTarget.value)}
                  placeholder={definition.example}
                  disabled={app.locked}
                />
              )}
            </form.Field>
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
              onClick={() => {
                const values = form.state.values;
                if (addModel(values.modelId.trim(), values.contextWindow)) {
                  form.setFieldValue('modelId', '');
                  form.setFieldValue('contextWindow', undefined);
                }
              }}
            >
              Add model
            </Button>
          </div>
        </details>
      </div>
      <div
        className={`actions flex flex-wrap items-center gap-2.5 ${initialProvider ? 'mt-2' : 'mt-[22px]'}`}
      >
        <Button type="submit" intent="primary" disabled={!canSave}>
          Save connection
        </Button>
        <Button intent="quiet" disabled={app.locked} onClick={close}>
          Cancel
        </Button>
      </div>
      <ActionProgress label={app.busyTarget === 'connection-editor' ? app.busy : ''} />
    </form>
  );
}
