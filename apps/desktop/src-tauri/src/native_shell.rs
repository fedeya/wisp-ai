//! Desktop-app behaviour that WebView2 does not give us by default: no browser
//! accelerator keys in release builds, native notifications while the window is
//! out of sight, and launching with Windows.
use std::path::Path;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_notification::NotificationExt as _;

/// Registry value name used by the autostart entry. The NSIS uninstall hook
/// removes the same value, so keep both in sync.
pub const AUTOSTART_NAME: &str = "Wisp AI";
/// Passed by the autostart entry so Wisp starts in the tray instead of on screen.
pub const MINIMIZED_ARG: &str = "--minimized";
/// Written right before an update launches the installer. The installer
/// relaunches Wisp with the arguments of the process it replaced, so a Wisp
/// that was started with Windows would come back with `--minimized` and stay in
/// the tray. The marker makes that relaunch open on screen instead.
const SHOW_AFTER_UPDATE_FILE: &str = "runtime/show-after-update";

/// Whether the main window stays hidden at launch. Consumes the post-update
/// marker, so only the first launch after an update ignores `--minimized`.
pub fn start_hidden(data: &Path) -> bool {
    start_hidden_with(std::env::args(), data)
}

fn start_hidden_with(mut args: impl Iterator<Item = String>, data: &Path) -> bool {
    let after_update = std::fs::remove_file(data.join(SHOW_AFTER_UPDATE_FILE)).is_ok();
    args.any(|arg| arg == MINIMIZED_ARG) && !after_update
}

pub fn show_after_update(data: &Path) {
    let _ = std::fs::create_dir_all(data.join("runtime"));
    let _ = std::fs::write(data.join(SHOW_AFTER_UPDATE_FILE), "");
}

pub fn cancel_show_after_update(data: &Path) {
    let _ = std::fs::remove_file(data.join(SHOW_AFTER_UPDATE_FILE));
}

/// Turns off WebView2's browser shortcuts (F5, Ctrl+R, Ctrl+F, Ctrl+P, F12,
/// zoom…). Editing keys such as Ctrl+C/V/Z keep working. Debug builds keep
/// them so the dev tools and reload stay available.
pub fn disable_browser_shortcuts(window: &WebviewWindow) {
    #[cfg(all(windows, not(debug_assertions)))]
    {
        let _ = window.with_webview(|webview| unsafe {
            use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
            use windows_core::Interface;
            let Ok(core) = webview.controller().CoreWebView2() else {
                return;
            };
            let Ok(settings) = core.Settings() else {
                return;
            };
            if let Ok(settings) = settings.cast::<ICoreWebView2Settings3>() {
                let _ = settings.SetAreBrowserAcceleratorKeysEnabled(false);
            }
        });
    }
    #[cfg(not(all(windows, not(debug_assertions))))]
    let _ = window;
}

fn main_window_in_view(app: &AppHandle) -> bool {
    app.get_webview_window("main").is_some_and(|window| {
        window.is_visible().unwrap_or(false)
            && !window.is_minimized().unwrap_or(false)
            && window.is_focused().unwrap_or(false)
    })
}

fn clip(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

/// Shows a Windows notification, but only when the user is not already looking
/// at Wisp: in-app feedback covers that case.
#[tauri::command]
pub fn notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    if main_window_in_view(&app) {
        return Ok(());
    }
    app.notification()
        .builder()
        .title(clip(&title, 80))
        .body(clip(&body, 240))
        .show()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn autostart_enabled(app: AppHandle) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let launcher = app.autolaunch();
    if enabled {
        launcher.enable()
    } else {
        launcher.disable()
    }
    .map_err(|error| error.to_string())?;
    launcher.is_enabled().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> impl Iterator<Item = String> {
        list.iter()
            .map(|arg| arg.to_string())
            .collect::<Vec<_>>()
            .into_iter()
    }

    #[test]
    fn only_the_first_launch_after_an_update_ignores_minimized() {
        let data = std::env::temp_dir().join(format!(
            "wisp-show-after-update-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let autostart = ["wisp-ai.exe", MINIMIZED_ARG];
        assert!(start_hidden_with(args(&autostart), &data));
        assert!(!start_hidden_with(args(&["wisp-ai.exe"]), &data));

        show_after_update(&data);
        assert!(!start_hidden_with(args(&autostart), &data));
        assert!(start_hidden_with(args(&autostart), &data));

        show_after_update(&data);
        cancel_show_after_update(&data);
        assert!(start_hidden_with(args(&autostart), &data));
        std::fs::remove_dir_all(data).unwrap();
    }
}
