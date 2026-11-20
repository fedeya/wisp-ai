import { Dialog } from '@base-ui/react/dialog';
import { useRef } from 'react';
import type { Mcp } from '../../api';
import { desktopLocked } from '../../desktop-controller';
import { useDesktop, useDesktopActions } from '../../use-desktop';
import { button } from '../ui/styles';
import Icon from '../ui/Icon';
import McpDialog, { type McpFormActions } from './McpDialog';

export function McpDialogTrigger({ server }: { server?: Mcp }) {
  const actions = useRef<Dialog.Root.Actions>(null);
  const formRef = useRef<McpFormActions>(null);
  const locked = useDesktop(desktopLocked);
  const { refreshAfterWrite } = useDesktopActions();
  return (
    <Dialog.Root
      actionsRef={actions}
      disablePointerDismissal
      onOpenChange={(open, details) => {
        if (!open && details.reason !== 'imperative-action' && formRef.current?.isSubmitting()) {
          details.cancel();
        }
      }}
    >
      <Dialog.Trigger className={button()} disabled={locked}>
        {!server && <Icon name="plus" size={17} />}
        {server ? 'Edit' : 'Add MCP'}
      </Dialog.Trigger>
      <McpDialog
        server={server ?? null}
        formRef={formRef}
        close={() => actions.current?.close()}
        saved={refreshAfterWrite}
      />
    </Dialog.Root>
  );
}
