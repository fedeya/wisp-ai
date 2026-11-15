import { useForm, useSelector } from '@tanstack/react-form';
import { request } from '../../api';
import { ActionProgress } from '../ui/ActionProgress';
import Icon from '../ui/Icon';
import { Button, Card, Select } from '../ui/Controls';
import { desktopConnected, desktopLocked } from '../../desktop-controller';
import { useDesktop, useDesktopActions } from '../../use-desktop';

const defaultValues: { model: string | null } = { model: null };

export default function DefaultModelSettings({ onFinish }: { onFinish?: () => void }) {
  const app = useDesktop((state) => ({
    savedModel: state.status?.model,
    online: !!state.status,
    models: state.models,
    modelsError: state.modelsError,
    busy: state.busy,
    busyTarget: state.busyTarget,
    locked: desktopLocked(state),
    connected: desktopConnected(state),
  }));
  const { loadModels, work } = useDesktopActions();
  const savedModel = app.savedModel ?? '';
  const defaultModel = app.models.some(({ slug }) => slug === savedModel)
    ? savedModel
    : app.models[0]?.slug || '';

  const modelForm = useForm({
    defaultValues,
    onSubmit: async ({ value, formApi }) => {
      const model = app.models.some(({ slug }) => slug === value.model)
        ? value.model
        : defaultModel;
      if (!model) return;
      if (model === savedModel) {
        if (app.connected) onFinish?.();
        return;
      }
      const saved = await work(
        'Updating default model',
        () => request('/auth/model', { model }),
        'Default model updated.',
        'model',
      );
      if (saved) {
        formApi.reset();
        onFinish?.();
      }
    },
  });
  const draft = useSelector(modelForm.store, (state) => state.values.model);
  const submitting = useSelector(modelForm.store, (state) => state.isSubmitting);
  const model = app.models.some(({ slug }) => slug === draft) ? draft : defaultModel;
  const locked = app.locked || submitting;
  const canSave = !locked && !!model && (model !== savedModel || (!!onFinish && app.connected));

  return (
    <Card kind="provider" className={onFinish ? 'p-5' : undefined}>
      {!onFinish && <h2>Default model</h2>}
      <div
        className={
          onFinish
            ? undefined
            : 'field-section mt-[26px] border-t border-solid border-border pt-[22px]'
        }
      >
        {app.modelsError && (
          <p
            className="banner error gap-[12px] border border-solid border-[#70473f] px-[16px] py-[12px] flex items-center rounded-[9px] [background:#332522] text-[#f0b4aa] mb-[20px] text-[13px] leading-[1.5] [&_.icon-button]:ml-auto"
            role="status"
          >
            Could not load models: {app.modelsError}
          </p>
        )}
        <div className="label-row flex items-center justify-between">
          <label
            className={
              onFinish ? 'text-[16px] font-semibold' : 'text-[12px] font-medium text-[#bdcccf]'
            }
            htmlFor="models"
          >
            Default model for new chats
          </label>
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
        <form
          className="inline-field gap-[12px] mt-[10px] flex flex-wrap items-center"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave && !modelForm.state.isSubmitting) void modelForm.handleSubmit();
          }}
        >
          <modelForm.Field name="model">
            {(field) => (
              <Select
                className="min-w-[180px] flex-1"
                id="models"
                name={field.name}
                value={model || null}
                onValueChange={field.handleChange}
                options={app.models.map(({ slug, displayName }) => ({
                  value: slug,
                  label: displayName,
                }))}
                placeholder="Connect a provider first"
                disabled={locked || !app.models.length}
              />
            )}
          </modelForm.Field>
          <Button type="submit" intent={onFinish ? 'primary' : 'default'} disabled={!canSave}>
            {app.busy === 'Updating default model'
              ? 'Saving…'
              : onFinish
                ? 'Finish setup'
                : 'Set default'}
          </Button>
        </form>
        <ActionProgress label={app.busyTarget === 'model' ? app.busy : ''} />
        <p className="field-hint text-[11px]! text-muted mt-[12px]">
          You can choose a different model and effort inside each chat.
        </p>
      </div>
      {!onFinish && (
        <p className="privacy-note gap-[7px] text-[11px]! flex items-center mt-[25px] text-[#789c91]!">
          <Icon name="check" size={16} />
          Credentials stay protected by your operating system.
        </p>
      )}
    </Card>
  );
}
