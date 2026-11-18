import { useForm, useSelector } from '@tanstack/react-form';
import { parseConnectionModel, type ProviderId } from '@wisp/protocol/providers';
import { useEffect, useRef } from 'react';
import { bridge, call } from '../../api';
import { ActionProgress } from '../ui/ActionProgress';
import Icon from '../ui/Icon';
import { Button, Card, Select } from '../ui/Controls';
import { desktopConnected, desktopLocked } from '../../desktop-controller';
import { useDesktop, useDesktopActions } from '../../use-desktop';
import { ProviderLogo, providerPresentation } from './provider-directory';

const defaultValues: { model: string | null } = { model: null };

export default function DefaultModelSettings({
  onFinish,
  review,
}: {
  onFinish?: () => void;
  review?: { provider: ProviderId; connectionId?: string; onBack: () => void };
}) {
  const app = useDesktop((state) => ({
    savedModel: state.status?.model,
    reviewConnection: review?.connectionId
      ? state.status?.connections.find(({ id }) => id === review.connectionId)
      : undefined,
    online: !!state.status,
    models: state.models,
    modelsError: state.modelsError,
    busy: state.busy,
    busyTarget: state.busyTarget,
    locked: desktopLocked(state),
    connected: desktopConnected(state),
  }));
  const { loadModels, work } = useDesktopActions();
  const heading = useRef<HTMLHeadingElement>(null);
  const models = review
    ? app.models.filter(
        ({ slug }) => parseConnectionModel(slug)?.connection === review.connectionId,
      )
    : app.models;
  const savedModel = app.savedModel ?? '';
  const defaultModel = models.some(({ slug }) => slug === savedModel)
    ? savedModel
    : onFinish && models.length === 1
      ? models[0]?.slug || ''
      : '';

  const modelForm = useForm({
    defaultValues,
    onSubmit: async ({ value, formApi }) => {
      const model = models.some(({ slug }) => slug === value.model) ? value.model : defaultModel;
      if (!model) return;
      if (model === savedModel) {
        if (app.connected) onFinish?.();
        return;
      }
      const saved = await work(
        'Updating default model',
        () => call(bridge.auth.model.$post({ json: { model } })),
        'Default model updated.',
        'model',
      );
      if (saved) {
        formApi.reset();
        onFinish?.();
      }
    },
  });
  useEffect(() => {
    heading.current?.focus();
  }, [review?.provider]);
  const draft = useSelector(modelForm.store, (state) => state.values.model);
  const submitting = useSelector(modelForm.store, (state) => state.isSubmitting);
  const model = models.some(({ slug }) => slug === draft) ? draft : defaultModel;
  const locked = app.locked || submitting;
  const canSave = !locked && !!model && (model !== savedModel || (!!onFinish && app.connected));
  const refreshing = app.busyTarget === 'model';
  const showPicker = !onFinish || models.length > 0 || (refreshing && !app.modelsError);
  const singleModel = review && models.length === 1 ? models[0] : undefined;
  if (!showPicker && !app.modelsError && !review) return null;

  function modelLabel(slug: string, displayName: string) {
    if (!app.reviewConnection) return displayName;
    const id = parseConnectionModel(slug)?.model;
    const saved = app.reviewConnection.models.find((model) => model.id === id);
    return saved?.name || saved?.id || displayName;
  }

  return (
    <Card kind="provider" className="p-4">
      <div>
        {review && (
          <div className="mb-4 flex items-center gap-3">
            <span className="relative">
              <ProviderLogo provider={review.provider} />
              <span className="absolute -right-1 -bottom-1 grid size-[17px] place-items-center rounded-full bg-accent text-[#122b25]">
                <Icon name="check" size={12} />
              </span>
            </span>
            <div>
              <h2 ref={heading} tabIndex={-1} className="text-lg outline-none">
                {providerPresentation(review.provider).name} added
              </h2>
              <p className="m-0 text-sm text-muted">
                {singleModel
                  ? 'Ready for new chats in Wisp.'
                  : models.length
                    ? 'Choose the model for new chats.'
                    : 'Models will appear here when available.'}
              </p>
            </div>
          </div>
        )}
        {app.modelsError && (
          <p
            className="banner error gap-[12px] border border-solid border-[#70473f] px-[16px] py-[12px] flex items-center rounded-[6px] [background:#332522] text-danger mb-[20px] text-sm leading-[1.5] [&_.icon-button]:ml-auto"
            role="status"
          >
            Could not load models: {app.modelsError}
          </p>
        )}
        {(!review || !models.length) && (
          <div className="label-row flex items-center justify-between">
            <h2 className="text-base font-medium">{showPicker ? 'Default model' : 'Models'}</h2>
            <Button
              intent="quiet"
              size="text"
              onClick={() => work('Loading models', loadModels, 'Models refreshed.', 'model')}
              disabled={locked || !app.online}
            >
              <Icon name="refresh" size={14} />
              Refresh
            </Button>
          </div>
        )}
        {showPicker && (
          <form
            className={
              review ? 'grid gap-3' : 'inline-field mt-2 flex flex-wrap items-center gap-2'
            }
            onSubmit={(event) => {
              event.preventDefault();
              if (canSave && !modelForm.state.isSubmitting) void modelForm.handleSubmit();
            }}
          >
            {singleModel ? (
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-y [border-block-style:solid] border-border py-3">
                <span className="text-sm text-muted">Default model</span>
                <strong>{modelLabel(singleModel.slug, singleModel.displayName)}</strong>
              </div>
            ) : (
              <>
                <label className={review ? 'text-sm font-medium' : 'sr-only'} htmlFor="models">
                  Default model for new chats
                </label>
                <modelForm.Field name="model">
                  {(field) => (
                    <Select
                      className="min-w-[180px] flex-1"
                      id="models"
                      name={field.name}
                      value={model || null}
                      onValueChange={field.handleChange}
                      options={models.map(({ slug, displayName }) => ({
                        value: slug,
                        label: modelLabel(slug, displayName),
                      }))}
                      placeholder={models.length ? 'Choose a model' : 'No models available'}
                      disabled={locked || !models.length}
                    />
                  )}
                </modelForm.Field>
              </>
            )}
            <div
              className={review ? 'flex flex-wrap items-center justify-between gap-2' : 'contents'}
            >
              {review && (
                <Button intent="quiet" size="text" disabled={locked} onClick={review.onBack}>
                  Back to providers
                </Button>
              )}
              <Button type="submit" intent={onFinish ? 'primary' : 'default'} disabled={!canSave}>
                {app.busy === 'Updating default model'
                  ? 'Saving…'
                  : onFinish
                    ? 'Finish setup'
                    : 'Set default'}
                {review && <Icon name="arrow" size={16} />}
              </Button>
            </div>
          </form>
        )}
        <ActionProgress label={refreshing ? app.busy : ''} />
        {review && !showPicker && (
          <Button intent="quiet" size="text" disabled={locked} onClick={review.onBack}>
            Back to providers
          </Button>
        )}
        {showPicker && !review && (
          <p className="mt-3 text-sm text-muted">
            Used for new chats. You can change the model and effort in each chat.
          </p>
        )}
      </div>
    </Card>
  );
}
