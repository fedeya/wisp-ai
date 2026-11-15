import { useForm, useSelector } from '@tanstack/react-form';
import { useEffect } from 'react';
import { request } from '../../api';
import { ActionProgress } from '../ui/ActionProgress';
import Icon from '../ui/Icon';
import { Button, Card, Select } from '../ui/Controls';
import { desktopLocked } from '../../desktop-controller';
import { useDesktop, useDesktopActions } from '../../use-desktop';

export default function DefaultModelSettings() {
  const app = useDesktop((state) => ({
    savedModel: state.status?.model,
    online: !!state.status,
    models: state.models,
    modelsError: state.modelsError,
    busy: state.busy,
    busyTarget: state.busyTarget,
    locked: desktopLocked(state),
  }));
  const { loadModels, work } = useDesktopActions();
  const savedModel = app.savedModel ?? '';
  const defaultModel = app.models.some(({ slug }) => slug === savedModel)
    ? savedModel
    : app.models[0]?.slug || '';

  const modelForm = useForm({
    defaultValues: { model: defaultModel },
    onSubmit: ({ value }) =>
      work(
        'Updating default model',
        () => request('/auth/model', { model: value.model }),
        'Default model updated.',
        'model',
      ),
  });
  const model = useSelector(modelForm.store, (state) => state.values.model);

  useEffect(() => {
    if (
      app.models.length &&
      model !== defaultModel &&
      !app.models.some(({ slug }) => slug === model)
    ) {
      modelForm.resetField('model');
    }
  }, [app.models, defaultModel, model, modelForm]);
  return (
    <Card kind="provider">
      <h2>Default model</h2>
      <div className="field-section border-t-[1px] [border-top-style:solid] border-t-[var(--border)] mt-[26px] pt-[22px]">
        {app.modelsError && (
          <p
            className="banner error gap-[12px] border border-solid border-[#70473f] px-[16px] py-[12px] flex items-center rounded-[9px] [background:#332522] text-[#f0b4aa] mb-[20px] text-[13px] leading-[1.5] [&_.icon-button]:ml-auto"
            role="status"
          >
            Could not load models: {app.modelsError}
          </p>
        )}
        <div className="label-row flex items-center justify-between">
          <label className="text-[12px] font-medium text-[#bdcccf]" htmlFor="models">
            Default model for new chats
          </label>
          <Button
            intent="quiet"
            size="text"
            onClick={() => work('Loading models', loadModels, 'Models refreshed.', 'model')}
            disabled={app.locked || !app.online}
          >
            <Icon name="refresh" size={14} />
            Refresh
          </Button>
        </div>
        <form
          className="inline-field gap-[12px] mt-[10px] flex items-center"
          onSubmit={(event) => {
            event.preventDefault();
            if (
              !app.locked &&
              app.models.length &&
              model &&
              model !== savedModel &&
              !modelForm.state.isSubmitting
            ) {
              void modelForm.handleSubmit();
            }
          }}
        >
          <modelForm.Field name="model">
            {(field) => (
              <Select
                className="flex-[1]"
                id="models"
                name={field.name}
                value={app.models.length ? field.state.value : ''}
                onChange={({ currentTarget }) => field.handleChange(currentTarget.value)}
                disabled={app.locked || !app.models.length}
              >
                <option value="" disabled>
                  Connect a provider first
                </option>
                {app.models.map(({ slug, displayName }) => (
                  <option key={slug} value={slug}>
                    {displayName}
                  </option>
                ))}
              </Select>
            )}
          </modelForm.Field>
          <Button
            type="submit"
            disabled={app.locked || !app.models.length || !model || model === savedModel}
          >
            {app.busy === 'Updating default model' ? 'Saving…' : 'Set default'}
          </Button>
        </form>
        <ActionProgress label={app.busyTarget === 'model' ? app.busy : ''} />
        <p className="field-hint text-[11px]! text-muted mt-[12px]">
          You can choose a different model and effort inside each chat.
        </p>
      </div>
      <p className="privacy-note gap-[7px] text-[11px]! flex items-center mt-[25px] text-[#789c91]!">
        <Icon name="check" size={16} />
        Credentials stay protected by your operating system.
      </p>
    </Card>
  );
}
