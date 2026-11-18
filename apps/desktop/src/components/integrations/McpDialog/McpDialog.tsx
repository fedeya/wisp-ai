import { Dialog } from '@base-ui/react/dialog';
import { useRef } from 'react';
import { dialogBackdrop, floatingSurface } from '../../ui/Controls/styles';
import McpForm, { type McpDialogProps } from './McpForm';

export default function McpDialog(props: McpDialogProps) {
  const firstField = useRef<HTMLInputElement>(null);
  return (
    <Dialog.Portal>
      <Dialog.Backdrop className={dialogBackdrop} />
      <Dialog.Viewport className="fixed inset-0 z-[20] grid place-items-center p-[25px]">
        <Dialog.Popup
          className={`dialog p-6 w-[min(600px,_100%)] max-h-[90vh] overflow-auto ${floatingSurface}`}
          initialFocus={firstField}
        >
          <McpForm {...props} firstField={firstField} />
        </Dialog.Popup>
      </Dialog.Viewport>
    </Dialog.Portal>
  );
}
