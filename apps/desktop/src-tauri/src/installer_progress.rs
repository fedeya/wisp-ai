use std::{thread, time::Duration};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, RECT},
    UI::WindowsAndMessaging::{
        GetAncestor, GetClientRect, GetDlgItem, GetParent, GetPropW, GetWindowLongW, GetWindowRect,
        GetWindowThreadProcessId, SendMessageTimeoutW, SetPropW, SetWindowPos, ShowWindowAsync,
        GA_ROOT, GWL_STYLE, SMTO_ABORTIFHUNG, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOZORDER, SW_HIDE,
        SW_SHOWNA, WM_SETTEXT, WS_DISABLED,
    },
};

// Progress bar messages live above WM_USER. These queries pass only integer values.
const PBM_GETRANGE: u32 = 0x407;
const PBM_GETPOS: u32 = 0x408;
const LVM_GETITEMCOUNT: u32 = 0x1004;
const LVM_ENSUREVISIBLE: u32 = 0x1013;

pub(crate) fn show(args: &[String]) {
    let [progress, label] = args else { return };
    let (Ok(progress), Ok(label)) = (progress.parse::<usize>(), label.parse::<usize>()) else {
        return;
    };
    let (progress, label) = (progress as HWND, label as HWND);
    let mut installer = 0;
    unsafe { GetWindowThreadProcessId(label, &mut installer) };
    let root = unsafe { GetAncestor(label, GA_ROOT) };
    if installer == 0 || root.is_null() {
        return;
    }
    let belongs_to_installer = |window| {
        let mut owner = 0;
        unsafe { GetWindowThreadProcessId(window, &mut owner) };
        owner == installer && unsafe { GetAncestor(window, GA_ROOT) } == root
    };
    if !belongs_to_installer(progress) {
        return;
    }

    let Some(maximum) = send(progress, PBM_GETRANGE, 0, 0).filter(|&maximum| maximum > 0) else {
        return;
    };
    let cancel = unsafe { GetDlgItem(root, 2) };
    let page = unsafe { GetParent(progress) };
    let status = unsafe { GetDlgItem(page, 1006) };
    let log = unsafe { GetDlgItem(page, 1016) };
    if [cancel, page, status, log]
        .iter()
        .any(|hwnd| hwnd.is_null())
    {
        return;
    }
    if unsafe { SetPropW(label, windows_sys::w!("WispProgressReady"), 1 as _) } == 0 {
        return;
    }

    let mut previous = None;
    while belongs_to_installer(progress)
        && belongs_to_installer(label)
        && unsafe { GetPropW(label, windows_sys::w!("WispProgressDone")) }.is_null()
    {
        let styled = !unsafe { GetPropW(label, windows_sys::w!("WispProgressStyled")) }.is_null();
        // NSIS enables Cancel only after an abort in the passive installation page.
        if styled && unsafe { GetWindowLongW(cancel, GWL_STYLE) } as u32 & WS_DISABLED == 0 {
            show_failure(root, page, status, log, cancel, progress, label);
            return;
        }
        let installing =
            !unsafe { GetPropW(label, windows_sys::w!("WispProgressInstalling")) }.is_null();
        if let Some(position) = installing
            .then(|| send(progress, PBM_GETPOS, 0, 0))
            .flatten()
        {
            // The success hook sets 100% only after the files are installed.
            let percent = (position.min(maximum) * 100 / maximum).min(99);
            if previous != Some(percent) {
                let text: Vec<u16> = format!("{percent}%\0").encode_utf16().collect();
                if send(label, WM_SETTEXT, 0, text.as_ptr() as LPARAM).is_some() {
                    previous = Some(percent);
                }
            }
        }
        thread::sleep(Duration::from_millis(120));
    }
}

fn show_failure(
    root: HWND,
    page: HWND,
    status: HWND,
    log: HWND,
    cancel: HWND,
    progress: HWND,
    label: HWND,
) {
    let (mut outer, mut client) = (RECT::default(), RECT::default());
    unsafe {
        if GetWindowRect(root, &mut outer) == 0 || GetClientRect(root, &mut client) == 0 {
            return;
        }
        SetWindowPos(
            root,
            std::ptr::null_mut(),
            0,
            0,
            outer.right - outer.left,
            outer.bottom - outer.top + client.bottom * (227 - 137) / 137,
            SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
        );
        ShowWindowAsync(progress, SW_HIDE);
        ShowWindowAsync(label, SW_HIDE);
        ShowWindowAsync(GetDlgItem(root, 1), SW_HIDE); // Next
        ShowWindowAsync(GetDlgItem(root, 3), SW_HIDE); // Back
    }
    place(&client, page, [24, 113, 224, 82]);
    place(&client, status, [0, 0, 224, 14]);
    place(&client, log, [0, 17, 224, 65]);
    place(&client, cancel, [194, 202, 54, 16]);
    let close = windows_sys::w!("Close");
    let _ = send(cancel, WM_SETTEXT, 0, close as LPARAM);
    unsafe {
        ShowWindowAsync(status, SW_SHOWNA);
        ShowWindowAsync(log, SW_SHOWNA);
        ShowWindowAsync(cancel, SW_SHOWNA);
    }
    if let Some(last) = send(log, LVM_GETITEMCOUNT, 0, 0).and_then(|count| count.checked_sub(1)) {
        let _ = send(log, LVM_ENSUREVISIBLE, last, 0);
    }
}

fn place(client: &RECT, window: HWND, [x, y, width, height]: [i32; 4]) {
    // Scale from the compact dialog size defined by WispStyleUpdateFrame.
    unsafe {
        SetWindowPos(
            window,
            std::ptr::null_mut(),
            client.right * x / 272,
            client.bottom * y / 137,
            client.right * width / 272,
            client.bottom * height / 137,
            SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
}

fn send(window: HWND, message: u32, wparam: usize, lparam: LPARAM) -> Option<usize> {
    let mut result = 0;
    let sent = unsafe {
        SendMessageTimeoutW(
            window,
            message,
            wparam,
            lparam,
            SMTO_ABORTIFHUNG,
            100,
            &mut result,
        )
    };
    (sent != 0).then_some(result)
}
