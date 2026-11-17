import { AlertDialog } from '@base-ui/react/alert-dialog';
import { useDesktop, useDesktopActions } from '../../use-desktop';
import { button } from './Controls/styles';
import { Button } from './Controls';

export default function ConfirmationDialog() {
  const confirm = useDesktop((state) => state.confirm);
  const { setConfirmation } = useDesktopActions();
  return (
    <AlertDialog.Root
      open={!!confirm}
      onOpenChange={(open) => {
        if (!open) setConfirmation(null);
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-[20] [background:#050c10b8] [backdrop-filter:blur(5px)]" />
        <AlertDialog.Viewport className="fixed inset-0 z-[20] grid place-items-center p-[25px]">
          <AlertDialog.Popup className="dialog confirmation border border-solid border-border-strong p-[27px] w-[min(600px,_100%)] max-h-[90vh] overflow-auto bg-surface rounded-[16px] [box-shadow:0_25px_100px_#0009] max-w-[460px]">
            <AlertDialog.Title className="leading-[1.6] text-[17px]">
              {confirm?.label}
            </AlertDialog.Title>
            <footer className="gap-[12px] flex justify-end mt-[22px]">
              <AlertDialog.Close className={button()}>Cancel</AlertDialog.Close>
              <Button
                intent="danger"
                onClick={() => {
                  const action = confirm?.run;
                  setConfirmation(null);
                  void action?.();
                }}
              >
                Confirm
              </Button>
            </footer>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
