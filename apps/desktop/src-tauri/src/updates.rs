use super::Host;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::Duration;
use tauri::{Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const STABLE_FEED: &str = "https://github.com/fedeya/wisp-ai/releases/latest/download/latest.json";
const NIGHTLY_FEED: &str =
    "https://github.com/fedeya/wisp-ai/releases/download/nightly/latest.json";

fn default_channel() -> &'static str {
    if env!("CARGO_PKG_VERSION").contains("-nightly.") {
        "nightly"
    } else {
        "stable"
    }
}
fn channel_allows(nightly: bool, current: &semver::Version, remote: &semver::Version) -> bool {
    if nightly {
        remote.pre.as_str().starts_with("nightly.") && remote > current
    } else {
        remote.pre.is_empty()
            && (remote > current
                || (current.pre.as_str().starts_with("nightly.") && remote != current))
    }
}
fn read_channel(data: &std::path::Path) -> Result<String, String> {
    match std::fs::read_to_string(data.join("update-channel.txt")) {
        Ok(value) if value == "stable" || value == "nightly" => Ok(value),
        Ok(_) => Err("Invalid saved update channel.".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(default_channel().into()),
        Err(error) => Err(error.to_string()),
    }
}
#[tauri::command]
pub fn update_channel(
    host: tauri::State<'_, Host>,
    updates: tauri::State<'_, Updates>,
    channel: Option<String>,
) -> Result<String, String> {
    let _operation = updates.begin()?;
    if let Some(channel) = channel {
        if channel != "stable" && channel != "nightly" {
            return Err("Unknown update channel.".into());
        }
        *updates
            .pending
            .lock()
            .map_err(|_| "Update state is unavailable.")? = None;
        std::fs::create_dir_all(&host.data).map_err(|e| e.to_string())?;
        std::fs::write(host.data.join("update-channel.txt"), &channel)
            .map_err(|e| e.to_string())?;
        return Ok(channel);
    }
    read_channel(&host.data)
}

#[derive(Default)]
pub struct Updates {
    pending: Mutex<Option<Update>>,
    busy: AtomicBool,
}

struct Operation<'a>(&'a AtomicBool);
impl Drop for Operation<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
impl Updates {
    fn begin(&self) -> Result<Operation<'_>, String> {
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "An update operation is already in progress.".to_string())?;
        Ok(Operation(&self.busy))
    }
}

#[tauri::command]
pub async fn check_update(
    app: tauri::AppHandle,
    updates: tauri::State<'_, Updates>,
) -> Result<Value, String> {
    // Source builds and unsupported platforms must not replace themselves with a Windows release.
    if cfg!(debug_assertions) || !cfg!(all(windows, target_arch = "x86_64")) {
        return Ok(json!({"supported": false, "update": null}));
    }
    let _operation = updates.begin()?;
    let channel = read_channel(&app.state::<Host>().data)?;
    let nightly = channel == "nightly";
    let update = app
        .updater_builder()
        .endpoints(vec![if nightly { NIGHTLY_FEED } else { STABLE_FEED }
            .parse()
            .map_err(|_| "Invalid update endpoint.")?])
        .map_err(|e| e.to_string())?
        .version_comparator(move |current, remote| {
            channel_allows(nightly, &current, &remote.version)
        })
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    let details = update
        .as_ref()
        .map(|u| json!({"version": u.version, "notes": u.body}));
    *updates
        .pending
        .lock()
        .map_err(|_| "Update state is unavailable.")? = update;
    Ok(json!({"supported": true, "update": details}))
}

#[tauri::command]
pub async fn install_update(
    app: tauri::AppHandle,
    updates: tauri::State<'_, Updates>,
) -> Result<(), String> {
    let _operation = updates.begin()?;
    let mut update = updates
        .pending
        .lock()
        .map_err(|_| "Update state is unavailable.")?
        .clone()
        .ok_or("Check for updates before installing.")?;
    update.timeout = Some(Duration::from_secs(30 * 60));
    let host = app.state::<Host>();
    super::update_trace::begin(&host.data);
    // Download and verify the signature while Wisp is still running.
    let mut downloaded = 0u64;
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                let _ = app.emit(
                    "update-progress",
                    json!({"phase": "downloading", "downloaded": downloaded, "total": total}),
                );
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    super::update_trace::append(&host.data, "download-verified");
    let _ = app.emit("update-progress", json!({"phase": "waiting"}));
    // /stop atomically refuses active turns. Retry only that refusal, preserving replies.
    loop {
        match tauri::async_runtime::spawn_blocking(super::prepare_update)
            .await
            .map_err(|e| e.to_string())?
        {
            Ok(()) => break,
            Err(error) if error == "Wait for the active turn before stopping Wisp" => {
                tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_secs(1)))
                    .await
                    .map_err(|e| e.to_string())?;
            }
            Err(error) => return Err(error),
        }
    }
    super::update_trace::append(&host.data, "bridge-stopped-before-install");
    let _ = app.emit("update-progress", json!({"phase": "installing"}));
    // The NSIS hook also waits for the bridge process to finish releasing its files.
    if let Err(error) = update.install(bytes) {
        super::update_trace::append(&host.data, "installer-launch-failed");
        let _ = super::start_bridge(host).await;
        return Err(error.to_string());
    }
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channels_are_isolated_and_only_returning_to_stable_allows_downgrades() {
        let allowed = |nightly, current: &str, remote: &str| {
            channel_allows(nightly, &current.parse().unwrap(), &remote.parse().unwrap())
        };
        assert!(!allowed(false, "0.1.0", "0.1.1-nightly.100.1"));
        assert!(!allowed(true, "0.1.1-nightly.100.1", "0.2.0"));
        assert!(allowed(true, "0.1.0", "0.1.1-nightly.100.1"));
        assert!(allowed(true, "0.1.1-nightly.9.1", "0.1.1-nightly.10.1"));
        assert!(!allowed(true, "0.1.1-nightly.10.1", "0.1.1-nightly.9.1"));
        assert!(allowed(false, "0.1.1-nightly.10.1", "0.1.0"));
        assert!(!allowed(false, "0.1.1", "0.1.0"));
        assert!(!allowed(false, "0.1.0", "0.1.0"));
    }

    #[test]
    fn checks_and_installs_are_serialized_and_errors_release_the_operation() {
        let updates = Updates::default();
        let operation = updates.begin().unwrap();
        assert!(updates.begin().is_err());
        drop(operation);
        assert!(updates.begin().is_ok());
    }
}
