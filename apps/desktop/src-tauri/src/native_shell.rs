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
/// Written right before an update launches the installer, which relaunches Wisp
/// with the arguments of the process it replaced. Without it, a Wisp started
/// with Windows would come back with `--minimized`, and one hidden in the tray
/// would open on screen, whatever the update intended.
///
/// The file holds `tray` to come back hidden; any other content (older builds
/// write an empty file) means come back on screen.
const AFTER_UPDATE_FILE: &str = "runtime/show-after-update";
const TRAY: &str = "tray";

/// Where the window goes on the first launch after an update.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AfterUpdate {
    /// On screen, even when launched with `--minimized`.
    Show,
    /// In the tray: an update that installed itself while Wisp was there.
    Tray,
}

/// Whether the main window stays hidden at launch. Consumes the post-update
/// marker, so it only decides the first launch after an update.
pub fn start_hidden(data: &Path) -> bool {
    start_hidden_with(std::env::args(), data)
}

fn start_hidden_with(mut args: impl Iterator<Item = String>, data: &Path) -> bool {
    let path = data.join(AFTER_UPDATE_FILE);
    let after_update = std::fs::read_to_string(&path).ok().map(|value| {
        let _ = std::fs::remove_file(&path);
        if value == TRAY {
            AfterUpdate::Tray
        } else {
            AfterUpdate::Show
        }
    });
    match after_update {
        Some(after) => after == AfterUpdate::Tray,
        None => args.any(|arg| arg == MINIMIZED_ARG),
    }
}

pub fn set_after_update(data: &Path, after: AfterUpdate) {
    let _ = std::fs::create_dir_all(data.join("runtime"));
    let content = match after {
        AfterUpdate::Show => "",
        AfterUpdate::Tray => TRAY,
    };
    let _ = std::fs::write(data.join(AFTER_UPDATE_FILE), content);
}

pub fn cancel_after_update(data: &Path) {
    let _ = std::fs::remove_file(data.join(AFTER_UPDATE_FILE));
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

        set_after_update(&data, AfterUpdate::Show);
        assert!(!start_hidden_with(args(&autostart), &data));
        assert!(start_hidden_with(args(&autostart), &data));

        set_after_update(&data, AfterUpdate::Show);
        cancel_after_update(&data);
        assert!(start_hidden_with(args(&autostart), &data));
        std::fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn an_update_that_installed_itself_from_the_tray_comes_back_hidden_once() {
        let data = std::env::temp_dir().join(format!(
            "wisp-tray-after-update-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let manual = ["wisp-ai.exe"];
        set_after_update(&data, AfterUpdate::Tray);
        assert!(start_hidden_with(args(&manual), &data));
        assert!(!start_hidden_with(args(&manual), &data));

        // Builds before the tray option wrote an empty marker to mean "show".
        std::fs::write(data.join(AFTER_UPDATE_FILE), "").unwrap();
        assert!(!start_hidden_with(
            args(&["wisp-ai.exe", MINIMIZED_ARG]),
            &data
        ));
        std::fs::remove_dir_all(data).unwrap();
    }
}
