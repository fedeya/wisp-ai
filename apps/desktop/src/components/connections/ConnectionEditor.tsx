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
import { useEffect, useRef, useState } from 'react';
import { bridge, call } from '../../api';
import { ActionProgress } from '../ui/ActionProgress';
import { Button, Input, NumberInput } from '../ui/Controls';
import Icon from '../ui/Icon';
import { desktopLocked } from '../../desktop-controller';
import { useDesktop, useDesktopActions } from '../../use-desktop';
import ModelCatalog from './ModelCatalog';
import { modelProvider, ProviderLogo } from './provider-directory';
import { autoAddLimit, suggestedModels } from './suggested-models';

const labelClass = 'text-xs font-medium text-[#bdcccf]';
const modelFieldsClass =
  'api-model-fields gap-[10px] grid grid-cols-[minmax(0,_1fr)_minmax(160px,_0.7fr)_auto] items-center max-sm:grid-cols-[1fr]';
const keyPages: Partial<Record<ProviderId, string>> = {
  anthropic: 'https://platform.claude.com/settings/keys',
  google: 'https://aistudio.google.com/apikey',
  openai: 'https://platform.openai.com/api-keys',
  openrouter: 'https://openrouter.ai/settings/keys',
};

type ConnectionFields = {
  name: string;
  apiKey: string;
  baseURL: string;
  models: ConnectionModel[];
  modelId: string;
  contextWindow: number | undefined;
};

const contextWindowSchema = connectionModel.shape.contextWindow;

// Empty means automatic: the bridge fills in the model's known context window.
function validContextWindow(value: number | undefined) {
  return value === undefined || contextWindowSchema.safeParse(value).success;
}

function validateContextWindow({ value }: { value: number | undefined }) {
  if (!validContextWindow(value)) {
    return 'Enter a whole number between 1 and 100,000,000.';
  }
}

function connectionDetails(provider: ProviderId, id: string | undefined, value: ConnectionFields) {
  return {
    id,
    provider,
    // Left blank, the bridge names a new connection after its provider.
    name: value.name.trim() || undefined,
    apiKey: value.apiKey || undefined,
    baseURL: value.baseURL.trim() || undefined,
  };
}

export default function ConnectionEditor({
  connection,
  provider,
  close,
  onConnected,
  onSetupFailed,
}: {
  connection?: ConnectionView;
  provider: ProviderId;
  close: () => void;
  onConnected?: (connectionId: string) => void;
  /** Setup only: which action failed, for onboarding telemetry. Never the message. */
  onSetupFailed?: (
    code: 'model_discovery_failed' | 'model_test_failed' | 'connection_save_failed',
  ) => void;
}) {
  const app = useDesktop((state) => ({
    busy: state.busy,
    busyTarget: state.busyTarget,
    locked: desktopLocked(state) || !state.status,
  }));
  const { work } = useDesktopActions();
  const [discovered, setDiscovered] = useState<DiscoveredConnectionModel[]>([]);
  const [showModelSettings, setShowModelSettings] = useState(false);
  const [showSelectedSettings, setShowSelectedSettings] = useState(false);
  const defaultValues: ConnectionFields = {
    name: connection?.name || '',
    apiKey: '',
    baseURL: connection?.baseURL || '',
    models: connection?.models || [],
    modelId: '',
    contextWindow: undefined,
  };
  const form = useForm({
    defaultValues,
    onSubmit: ({ value }) => saveConnection(value.models),
  });

  async function saveConnection(models: ConnectionModel[]) {
    const saved = await work(
      'Saving AI connection',
      async () => {
        const saved = await call(
          bridge.connections.save.$post({
            json: { ...connectionDetails(provider, connection?.id, form.state.values), models },
          }),
        );
        if (onConnected) onConnected(saved.id);
        else close();
      },
      onConnected ? null : 'Connection saved.',
      'connection-editor',
    );
    if (!saved) onSetupFailed?.('connection_save_failed');
  }
  const { baseURL, apiKey, modelId, models } = useSelector(form.store, (state) => state.values);
  const formCanSubmit = useSelector(form.store, (state) => state.canSubmit);
  const canDiscover =
    !app.locked &&
    (provider === 'compatible' ? !!baseURL.trim() : !!apiKey.trim() || !!connection?.hasKey);
  const hasModels =
    models.length > 0 && models.every(({ contextWindow }) => validContextWindow(contextWindow));
  const canSave = canDiscover && hasModels && !modelId.trim() && formCanSubmit;
  const definition = providerDefinitions.find((item) => item.id === provider)!;
  // Creating a connection, here or in onboarding: key first, then models only if needed.
  const guided = !!onConnected || !connection;
  const pickingModels = guided && showModelSettings;
  const selectedSettingsVisible = !guided || !hasModels || showSelectedSettings;
  const compatible = provider === 'compatible';
  const keyPage = keyPages[provider];
  const modelsHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (pickingModels) modelsHeading.current?.focus();
  }, [pickingModels]);

  /**
   * Loads the provider's models. When creating a connection that is all the
   * player has to do: Wisp saves every usable model and only shows the picker
   * when there are too many to add (aggregators) or none it can vouch for.
   */
  async function discoverModels(autoSave = false) {
    let found: DiscoveredConnectionModel[] = [];
    const loaded = await work(
      'Loading provider models',
      async () => {
        const result = await call(
          bridge.connections.discover.$post({
            json: connectionDetails(provider, connection?.id, form.state.values),
          }),
        );
        found = result.models;
        setDiscovered(result.models);
      },
      null,
      'connection-editor',
    );
    if (!loaded) {
      onSetupFailed?.('model_discovery_failed');
      return;
    }
    const suggested = suggestedModels(found);
    // Models the player already chose (manually, then back to the key) are
    // theirs: keep them and show the picker instead of replacing them.
    const untouched = form.state.values.models.length === 0;
    if (autoSave && untouched && suggested.length > 0 && suggested.length <= autoAddLimit) {
      // Kept selected if saving fails, so the picker opens ready to retry.
      form.setFieldValue('models', suggested);
      await saveConnection(suggested);
    }
    setShowModelSettings(true);
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

  async function testModel(model: ConnectionModel) {
    const verified = await work(
      'Testing AI model',
      () =>
        call(
          bridge.connections.test.$post({
            json: {
              ...connectionDetails(provider, connection?.id, form.state.values),
              models: [model],
            },
          }),
        ),
      `Tool calling verified for ${model.name || model.id}.`,
      'connection-editor',
    );
    if (!verified) onSetupFailed?.('model_test_failed');
    return verified;
  }

  const nameField = (
    <div className="grid gap-2">
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
    </div>
  );
  const endpointField = (
    <div className="grid gap-2">
      <label className={labelClass} htmlFor="ai-url">
        Base URL
      </label>
      <form.Field name="baseURL">
        {(field) => (
          <Input
            id="ai-url"
            value={field.state.value}
            onChange={({ currentTarget }) => field.handleChange(currentTarget.value)}
            placeholder={compatible ? 'http://localhost:1234/v1' : definition.baseURL}
            disabled={app.locked}
          />
        )}
      </form.Field>
    </div>
  );

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (guided && !pickingModels) {
          if (canDiscover) void discoverModels(!connection);
        } else if (canSave && !form.state.isSubmitting) {
          void form.handleSubmit();
        }
      }}
      className={
        onConnected
          ? 'grid gap-4'
          : 'field-section api-connection-form mt-4 grid gap-2.5 border-t [border-top-style:solid] border-t-border pt-4'
      }
    >
      <div hidden={pickingModels} className={pickingModels ? 'hidden' : 'grid gap-2.5'}>
        {!guided && nameField}
        {guided && compatible && endpointField}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className={labelClass} htmlFor="ai-key">
            API key{' '}
            {connection && (!guided || connection.hasKey)
              ? '(leave blank to keep saved key)'
              : compatible
                ? '(optional for local servers)'
                : ''}
          </label>
          {guided && keyPage && !baseURL.trim() && (
            <a href={keyPage} target="_blank" rel="noreferrer" className="text-sm text-accent">
              Get API key ↗
            </a>
          )}
        </div>
        <form.Field name="apiKey">
          {(field) => (
            <Input
              id="ai-key"
              type="password"
              value={field.state.value}
              onChange={({ currentTarget }) => field.handleChange(currentTarget.value)}
              placeholder={guided ? 'Paste your API key' : undefined}
              autoComplete="off"
              spellCheck={false}
              disabled={app.locked}
            />
          )}
        </form.Field>
        {compatible ? (
          !guided && endpointField
        ) : (
          <details>
            <summary className="text-muted text-sm">Custom endpoint</summary>
            <div className="mt-2 grid gap-3">{endpointField}</div>
          </details>
        )}
      </div>
      {(!guided || pickingModels) && (
        <>
          <div className="label-row flex flex-wrap items-center justify-between gap-2">
            <h3
              ref={modelsHeading}
              tabIndex={guided ? -1 : undefined}
              className="m-0 text-base font-semibold outline-none"
            >
              {guided ? 'Choose models' : 'Models'}
            </h3>
            <Button
              intent="quiet"
              size="text"
              disabled={!canDiscover}
              onClick={() => void discoverModels()}
            >
              {guided && discovered.length ? 'Refresh models' : 'Discover models'}
            </Button>
          </div>
          <p className="m-0 text-sm text-muted">
            {models.length
              ? `${models.length} ${models.length === 1 ? 'model' : 'models'} selected for Wisp`
              : 'Discover models and add the ones you want to use.'}
          </p>
          {!guided && (
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
          )}
        </>
      )}
      <div
        id="connection-model-settings"
        hidden={!showModelSettings}
        className={showModelSettings ? 'grid gap-3' : 'hidden'}
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
        {guided && hasModels && (
          <Button
            intent="quiet"
            size="text"
            className="w-fit"
            aria-controls="selected-model-settings"
            aria-expanded={selectedSettingsVisible}
            onClick={() => setShowSelectedSettings((open) => !open)}
          >
            {selectedSettingsVisible ? 'Hide selected model settings' : 'Selected model settings'}
          </Button>
        )}
        <div
          id="selected-model-settings"
          hidden={!selectedSettingsVisible}
          className={selectedSettingsVisible ? 'grid gap-3' : 'hidden'}
        >
          {models.length > 0 && <h4 className="m-0 text-sm font-semibold">Selected models</h4>}
          <form.Field name="models" mode="array">
            {(field) =>
              field.state.value.map((model, index) => (
                <div className={modelFieldsClass} key={model.id}>
                  <div className="flex min-w-0 items-center gap-2.5">
                    <ProviderLogo provider={modelProvider(provider, model.id)} />
                    <div className="min-w-0 [overflow-wrap:anywhere]">
                      <strong className="block text-sm">{model.name || model.id}</strong>
                      {model.name && model.name !== model.id && (
                        <span className="block text-xs text-muted">{model.id}</span>
                      )}
                    </div>
                  </div>
                  <form.Field
                    name={`models[${index}].contextWindow`}
                    validators={{
                      onChange: validateContextWindow,
                      onSubmit: validateContextWindow,
                    }}
                  >
                    {(contextField) => {
                      const error = contextField.state.meta.errors[0];
                      const fieldId = `model-context-${index}`;
                      const errorId = `model-context-error-${index}`;
                      return (
                        <div>
                          <label htmlFor={fieldId} className="mb-1 block text-xs text-muted">
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
                            onValueChange={(value) => {
                              if (guided) setShowSelectedSettings(true);
                              contextField.handleChange(value);
                            }}
                            placeholder="Auto"
                            disabled={app.locked}
                          />
                          {error && (
                            <p id={errorId} role="alert" className="mt-1 text-xs text-danger">
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
            <p className="m-0 text-xs text-muted">
              Wisp fills in each model&apos;s context window. Change it only if your provider serves
              a smaller one. Testing a model may incur provider charges.
            </p>
          )}
        </div>
        <details
          open={discovered.some(({ supportsTools }) => supportsTools === true) ? undefined : true}
        >
          <summary className="text-sm text-muted">Add a model manually</summary>
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
                  placeholder="Context tokens (auto)"
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
      {guided ? (
        <div className="actions flex flex-wrap items-center justify-between gap-2.5">
          {pickingModels ? (
            <Button
              intent="quiet"
              size="text"
              disabled={app.locked}
              onClick={() => setShowModelSettings(false)}
            >
              <Icon name="back" size={15} />
              Back to {compatible ? 'endpoint' : 'API key'}
            </Button>
          ) : (
            <Button
              intent="quiet"
              size="text"
              disabled={!canDiscover}
              onClick={() => setShowModelSettings(true)}
            >
              Add a model manually
            </Button>
          )}
          <div className="flex flex-wrap items-center gap-2.5">
            {!onConnected && (
              <Button intent="quiet" disabled={app.locked} onClick={close}>
                Cancel
              </Button>
            )}
            <Button
              type="submit"
              intent="primary"
              disabled={pickingModels ? !canSave : !canDiscover}
            >
              {pickingModels ? 'Save connection' : 'Connect'}
              <Icon name="arrow" size={16} />
            </Button>
          </div>
        </div>
      ) : (
        <div className="actions mt-2 flex flex-wrap items-center gap-2.5">
          <Button type="submit" intent="primary" disabled={!canSave}>
            Save connection
          </Button>
          <Button intent="quiet" disabled={app.locked} onClick={close}>
            Cancel
          </Button>
        </div>
      )}
      <ActionProgress label={app.busyTarget === 'connection-editor' ? app.busy : ''} />
    </form>
  );
}
