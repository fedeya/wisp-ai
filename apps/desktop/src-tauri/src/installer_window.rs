use serde::Serialize;
use std::{
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tauri::{LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM},
    UI::WindowsAndMessaging::{
        GetAncestor, GetDlgItem, GetParent, GetPropW, GetWindowLongW, IsWindow, IsWindowVisible,
        PostMessageW, SendMessageTimeoutW, SetLayeredWindowAttributes, SetPropW, ShowWindowAsync,
        GA_ROOT, GWL_STYLE, LWA_ALPHA, SMTO_ABORTIFHUNG, SW_HIDE, SW_SHOWNA, WM_COMMAND,
        WM_GETTEXT, WS_DISABLED,
    },
};

struct Installer {
    root: usize,
    progress: usize,
    label: usize,
    status: usize,
    cancel: usize,
    trace: PathBuf,
    presented: AtomicBool,
    terminal: AtomicBool,
    failed: AtomicBool,
}

#[derive(Serialize)]
struct UpdateStatus {
    phase: &'static str,
    percent: Option<usize>,
    log: Vec<String>,
    error: Option<String>,
}

fn property(window: usize, name: *const u16) -> bool {
    !unsafe { GetPropW(window as HWND, name) }.is_null()
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

#[tauri::command]
fn updater_ready(
    window: tauri::WebviewWindow,
    installer: tauri::State<'_, Installer>,
) -> Result<(), String> {
    if property(installer.label, windows_sys::w!("WispProgressDone"))
        || unsafe { IsWindow(installer.root as HWND) } == 0
    {
        window.app_handle().exit(0);
        return Err("The installer is no longer available.".into());
    }
    if unsafe {
        SetPropW(
            installer.label as HWND,
            windows_sys::w!("WispProgressReady"),
            1 as _,
        )
    } == 0
    {
        window.app_handle().exit(0);
        return Err("The installer is no longer available.".into());
    }
    Ok(())
}

#[tauri::command]
fn updater_status(
    window: tauri::WebviewWindow,
    installer: tauri::State<'_, Installer>,
) -> UpdateStatus {
    let root = installer.root as HWND;
    let alive = unsafe { IsWindow(root) } != 0;
    let done = property(installer.label, windows_sys::w!("WispProgressDone"));
    let success = property(installer.label, windows_sys::w!("WispProgressSucceeded"));
    let preparing = || UpdateStatus {
        phase: "preparing",
        percent: None,
        log: vec![],
        error: None,
    };
    if done && !success {
        window.app_handle().exit(0);
        return preparing();
    }
    if alive && unsafe { IsWindowVisible(root) } != 0 {
        // NSIS hides its window after acknowledging the ready signal.
        if !installer.presented.load(Ordering::Acquire) {
            return preparing();
        }
        if unsafe { GetWindowLongW(root, GWL_STYLE) } as u32 & WS_DISABLED == 0 {
            unsafe { ShowWindowAsync(root, SW_HIDE) };
        }
    } else if !installer.presented.swap(true, Ordering::AcqRel) && window.show().is_err() {
        // If showing Svelte fails after the handoff, give the installer its window back.
        unsafe {
            SetLayeredWindowAttributes(root, 0, 255, LWA_ALPHA);
            ShowWindowAsync(root, SW_SHOWNA);
        }
        window.app_handle().exit(0);
        return preparing();
    }

    let failed = !alive
        || unsafe { GetWindowLongW(installer.cancel as HWND, GWL_STYLE) } as u32 & WS_DISABLED == 0;
    if success {
        if !installer.terminal.swap(true, Ordering::AcqRel) {
            let app = window.app_handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(300));
                app.exit(0);
            });
        }
        return UpdateStatus {
            phase: "reopening",
            percent: Some(100),
            log: vec![],
            error: None,
        };
    }
    if failed {
        if !installer.failed.swap(true, Ordering::AcqRel) {
            let _ = window.set_size(LogicalSize::new(454, 382));
            let _ = window.set_focus();
        }
        let mut native_text = [0u16; 1024];
        let len = send(
            installer.status as HWND,
            WM_GETTEXT,
            native_text.len(),
            native_text.as_mut_ptr() as _,
        )
        .unwrap_or(0)
        .min(native_text.len());
        let details = String::from_utf16_lossy(&native_text[..len]);
        let error = if !alive {
            "The installer closed before the update finished.".to_owned()
        } else if details.is_empty() {
            "The installation stopped. Try updating Wisp again.".to_owned()
        } else {
            details
        };
        let mut log = read_trace(&installer.trace);
        log.push(error.clone());
        return UpdateStatus {
            phase: "failed",
            percent: None,
            log,
            error: Some(error),
        };
    }

    let installing = property(installer.label, windows_sys::w!("WispProgressInstalling"));
    let progress = installer.progress as HWND;
    let percent = if installing {
        send(progress, 0x407, 0, 0)
            .filter(|&range| range > 0)
            .and_then(|range| {
                send(progress, 0x408, 0, 0)
                    .map(|position| (position.min(range) * 100 / range).min(99))
            })
    } else {
        None
    };
    UpdateStatus {
        phase: if installing {
            "installing"
        } else {
            "preparing"
        },
        percent,
        log: vec![],
        error: None,
    }
}

#[tauri::command]
fn updater_close(window: tauri::WebviewWindow, installer: tauri::State<'_, Installer>) {
    if installer.failed.load(Ordering::Acquire) {
        unsafe { PostMessageW(installer.root as HWND, WM_COMMAND, 2, 0) };
        window.app_handle().exit(0);
    }
}

fn read_trace(path: &std::path::Path) -> Vec<String> {
    let trace = std::fs::read_to_string(path).unwrap_or_default();
    let mut stages: Vec<_> = trace
        .lines()
        .rev()
        .take(12)
        .filter_map(|line| {
            let (_, stage) = line.split_once(' ')?;
            let label = match stage.trim() {
                "download-verified" => "Update package verified.",
                "installer-ready" => "Installer started.",
                "bridge-stopped" => "Wisp closed for installation.",
                "copying-files" => "Installing application files.",
                _ => return None,
            };
            Some(label.to_owned())
        })
        .collect();
    stages.reverse();
    stages
}

pub(crate) fn run(args: &[String]) {
    let [progress, label, trace] = args else {
        return;
    };
    let (Ok(progress), Ok(label)) = (progress.parse::<usize>(), label.parse::<usize>()) else {
        return;
    };
    let root = unsafe { GetAncestor(label as HWND, GA_ROOT) };
    if root.is_null() || unsafe { GetAncestor(progress as HWND, GA_ROOT) } != root {
        return;
    }
    let page = unsafe { GetParent(progress as HWND) };
    let installer = Installer {
        root: root as usize,
        progress,
        label,
        status: unsafe { GetDlgItem(page, 1006) } as usize,
        cancel: unsafe { GetDlgItem(root, 2) } as usize,
        trace: trace.into(),
        presented: AtomicBool::new(false),
        terminal: AtomicBool::new(false),
        failed: AtomicBool::new(false),
    };
    if installer.status == 0 || installer.cancel == 0 {
        return;
    }
    let Ok(executable) = std::env::current_exe() else {
        return;
    };
    let Some(directory) = executable
        .parent()
        .map(|parent| parent.join("updater-webview"))
    else {
        return;
    };
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    let result = tauri::Builder::default()
        .manage(installer)
        .invoke_handler(tauri::generate_handler![
            updater_ready,
            updater_status,
            updater_close
        ])
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "updater", WebviewUrl::App("updater.html".into()))
                .title("Wisp AI Update")
                .inner_size(454.0, 270.0)
                .data_directory(directory)
                .incognito(true)
                .resizable(false)
                .decorations(false)
                .background_color(tauri::window::Color(20, 25, 29, 255))
                .visible(false)
                .center()
                .build()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let installer = window.state::<Installer>();
                if installer.failed.load(Ordering::Acquire) {
                    unsafe { PostMessageW(installer.root as HWND, WM_COMMAND, 2, 0) };
                } else {
                    api.prevent_close();
                }
            }
        })
        .run(context);
    if let Err(error) = result {
        eprintln!("{error}");
    }
}
