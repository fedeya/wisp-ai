import { Dialog } from '@base-ui/react/dialog';
import { useRef } from 'react';
import McpForm, { type McpDialogProps } from './McpForm';

export default function McpDialog(props: McpDialogProps) {
  const firstField = useRef<HTMLInputElement>(null);
  return (
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-[20] [background:#050c10b8] [backdrop-filter:blur(5px)]" />
      <Dialog.Viewport className="fixed inset-0 z-[20] grid place-items-center p-[25px]">
        <Dialog.Popup
          className="dialog border border-solid border-[#3c535b] p-[27px] w-[min(600px,_100%)] max-h-[90vh] overflow-auto [background:#1c252b] rounded-[16px] [box-shadow:0_25px_100px_#0009]"
          initialFocus={firstField}
        >
          <McpForm {...props} firstField={firstField} />
        </Dialog.Popup>
      </Dialog.Viewport>
    </Dialog.Portal>
  );
}
