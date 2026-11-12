use std::{thread, time::Duration};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM},
    UI::WindowsAndMessaging::{
        GetAncestor, GetPropW, GetWindowThreadProcessId, SendMessageTimeoutW, GA_ROOT,
        SMTO_ABORTIFHUNG, WM_SETTEXT,
    },
};

// Progress bar messages live above WM_USER. These queries pass only integer values.
const PBM_GETRANGE: u32 = 0x407;
const PBM_GETPOS: u32 = 0x408;

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
    let mut previous = None;
    while belongs_to_installer(progress)
        && belongs_to_installer(label)
        && unsafe { GetPropW(label, windows_sys::w!("WispProgressDone")) }.is_null()
    {
        if let Some(position) = send(progress, PBM_GETPOS, 0, 0) {
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
