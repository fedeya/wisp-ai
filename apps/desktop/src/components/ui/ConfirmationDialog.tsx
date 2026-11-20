import { AlertDialog } from '@base-ui/react/alert-dialog';
import { useDesktop, useDesktopActions } from '../../use-desktop';
import { button, dialogBackdrop, floatingSurface } from './styles';
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
        <AlertDialog.Backdrop className={dialogBackdrop} />
        <AlertDialog.Viewport className="fixed inset-0 z-[20] grid place-items-center p-[25px]">
          <AlertDialog.Popup
            className={`dialog confirmation p-6 w-[min(600px,_100%)] max-h-[90vh] overflow-auto ${floatingSurface} max-w-[460px]`}
          >
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
