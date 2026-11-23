use super::native_shell::AfterUpdate;
use super::Host;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
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
const AUTO_INSTALL_FILE: &str = "update-auto-install.txt";
/// The verified installer of a background download. One at a time; a new
/// download, a channel change or the next launch replaces or removes it.
const INSTALLER_FILE: &str = "runtime/update-installer.bin";
const BUSY_TURN: &str = "Wait for the active turn before stopping Wisp";
/// Returned when an automatic install finds a reply running or WoW open; the
/// app retries later.
const AUTOMATIC_BUSY: &str = "Wisp is busy; the update will install later.";

/// Whether a WoW client is running. The bridge's `gameConnected` stays set after
/// the game exits, so automatic updates ask Windows for the process instead.
#[tauri::command]
pub fn game_running() -> bool {
    super::addon_update::wow_running()
}

fn read_auto_install(data: &std::path::Path) -> Result<bool, String> {
    match std::fs::read_to_string(data.join(AUTO_INSTALL_FILE)) {
        Ok(value) if value == "on" => Ok(true),
        Ok(value) if value == "off" => Ok(false),
        Ok(_) => Err("Invalid saved automatic update setting.".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error.to_string()),
    }
}

/// Reads or saves whether downloaded updates install by themselves while Wisp is idle.
#[tauri::command]
pub fn update_auto_install(
    host: tauri::State<'_, Host>,
    enabled: Option<bool>,
) -> Result<bool, String> {
    if let Some(enabled) = enabled {
        std::fs::create_dir_all(&host.data).map_err(|e| e.to_string())?;
        std::fs::write(
            host.data.join(AUTO_INSTALL_FILE),
            if enabled { "on" } else { "off" },
        )
        .map_err(|e| e.to_string())?;
        return Ok(enabled);
    }
    read_auto_install(&host.data)
}

/// An installer downloaded in the background. It waits on disk rather than in
/// memory; the hash, kept in memory, proves it is still the verified download.
struct Prepared {
    version: String,
    path: PathBuf,
    sha256: [u8; 32],
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

impl Prepared {
    fn save(data: &Path, version: &str, bytes: &[u8]) -> Result<Self, String> {
        let path = data.join(INSTALLER_FILE);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
        Ok(Self {
            version: version.into(),
            path,
            sha256: sha256(bytes),
        })
    }

    /// The installer bytes, or None if the file is gone or no longer matches.
    fn load(&self) -> Option<Vec<u8>> {
        std::fs::read(&self.path)
            .ok()
            .filter(|bytes| sha256(bytes) == self.sha256)
    }
}

/// Removes an installer left by a previous run, which no longer has its hash.
pub fn discard_stale_installer(data: &Path) {
    let _ = std::fs::remove_file(data.join(INSTALLER_FILE));
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
        updates.clear_download();
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
    /// The verified installer of a background download.
    downloaded: Mutex<Option<Prepared>>,
    /// Serializes background downloads: a repeated request waits for the one in
    /// flight and then reuses its installer instead of being refused.
    downloading: tauri::async_runtime::Mutex<()>,
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

    fn clear_download(&self) {
        if let Some(prepared) = self.downloaded.lock().ok().and_then(|mut d| d.take()) {
            let _ = std::fs::remove_file(prepared.path);
        }
    }

    fn prepared_version(&self) -> Option<String> {
        let downloaded = self.downloaded.lock().ok()?;
        downloaded.as_ref().map(|prepared| prepared.version.clone())
    }

    /// The verified installer for `version`, if one is downloaded and intact.
    fn downloaded_bytes(&self, version: &str) -> Option<Vec<u8>> {
        let downloaded = self.downloaded.lock().ok()?;
        downloaded
            .as_ref()
            .filter(|prepared| prepared.version == version)?
            .load()
    }

    fn pending_update(&self) -> Result<Update, String> {
        self.pending
            .lock()
            .map_err(|_| "Update state is unavailable.")?
            .clone()
            .ok_or_else(|| "Check for updates before installing.".to_string())
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
    if update.as_ref().map(|u| &u.version) != updates.prepared_version().as_ref() {
        updates.clear_download();
    }
    *updates
        .pending
        .lock()
        .map_err(|_| "Update state is unavailable.")? = update;
    Ok(json!({"supported": true, "update": details}))
}

/// Downloads and verifies the update found by the last check without installing it,
/// so an automatic install later only has to run the installer. Returns its version.
#[tauri::command]
pub async fn download_update(
    app: tauri::AppHandle,
    host: tauri::State<'_, Host>,
    updates: tauri::State<'_, Updates>,
) -> Result<String, String> {
    let _downloading = updates.downloading.lock().await;
    // Read the update only after any earlier download finished, so a request that
    // waited reuses that installer or downloads what the last check found.
    let mut update = updates.pending_update()?;
    if updates.prepared_version().as_ref() == Some(&update.version) {
        return Ok(update.version);
    }
    update.timeout = Some(Duration::from_secs(30 * 60));
    // Report progress too: a manual install that starts meanwhile waits for this
    // download, and its progress bar only moves with these events.
    let bytes = download_with_progress(&app, &update).await?;
    // A check or channel change during the download may have replaced the update.
    if updates.pending_update().map(|u| u.version) != Ok(update.version.clone()) {
        return Err("The update changed while downloading.".into());
    }
    let prepared = Prepared::save(&host.data, &update.version, &bytes)?;
    *updates
        .downloaded
        .lock()
        .map_err(|_| "Update state is unavailable.")? = Some(prepared);
    Ok(update.version)
}

/// Downloads and verifies `update`, emitting `update-progress` for each chunk.
async fn download_with_progress(
    app: &tauri::AppHandle,
    update: &Update,
) -> Result<Vec<u8>, String> {
    let mut downloaded = 0u64;
    update
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
        .map_err(|e| e.to_string())
}

fn main_window_hidden(app: &tauri::AppHandle) -> bool {
    app.get_webview_window("main")
        .is_some_and(|window| !window.is_visible().unwrap_or(true))
}

/// Installs the update found by the last check. An `automatic` install never waits
/// for a reply: it gives up with [`AUTOMATIC_BUSY`] so the app can retry when idle.
#[tauri::command]
pub async fn install_update(
    app: tauri::AppHandle,
    updates: tauri::State<'_, Updates>,
    automatic: Option<bool>,
) -> Result<(), String> {
    let automatic = automatic.unwrap_or(false);
    let _operation = updates.begin()?;
    let mut update = updates.pending_update()?;
    update.timeout = Some(Duration::from_secs(30 * 60));
    let host = app.state::<Host>();
    super::update_trace::begin(&host.data);
    if automatic {
        super::update_trace::append(&host.data, "automatic-install");
    }
    // Wait for a background download of this installer instead of fetching it
    // twice, and keep a new one from starting while this install downloads.
    let downloading = updates.downloading.lock().await;
    let bytes = match updates.downloaded_bytes(&update.version) {
        Some(bytes) => bytes,
        // Download and verify the signature while Wisp is still running.
        None => download_with_progress(&app, &update).await?,
    };
    drop(downloading);
    super::update_trace::append(&host.data, "download-verified");
    // Only a manual install waits for a reply; an automatic one gives up instead.
    if !automatic {
        let _ = app.emit("update-progress", json!({"phase": "waiting"}));
    }
    let _lifecycle = host.lifecycle.lock().await;
    // The installer's window and the bridge restart must never interrupt a game.
    if automatic && game_running() {
        return Err(AUTOMATIC_BUSY.into());
    }
    // /stop atomically refuses active turns. Retry only that refusal, preserving replies.
    loop {
        match super::stop_host(&host).await {
            Ok(()) => break,
            Err(error) if automatic && error == BUSY_TURN => return Err(AUTOMATIC_BUSY.into()),
            Err(error) if error == BUSY_TURN => {
                tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_secs(1)))
                    .await
                    .map_err(|e| e.to_string())?;
            }
            Err(error) => return Err(error),
        }
    }
    super::update_trace::append(&host.data, "bridge-stopped-before-install");
    let _ = app.emit("update-progress", json!({"phase": "installing"}));
    // An update that installs itself while Wisp sits in the tray goes back there;
    // any other update reopens on screen, even after a launch with Windows.
    super::native_shell::set_after_update(
        &host.data,
        if automatic && main_window_hidden(&app) {
            AfterUpdate::Tray
        } else {
            AfterUpdate::Show
        },
    );
    // The NSIS hook also waits for the bridge process to finish releasing its files.
    if let Err(error) = update.install(bytes) {
        super::native_shell::cancel_after_update(&host.data);
        super::update_trace::append(&host.data, "installer-launch-failed");
        let _ = super::start_host(&host).await;
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

    fn temp_data(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wisp-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn automatic_install_defaults_on() {
        let dir = temp_data("auto-install");
        assert!(read_auto_install(&dir).unwrap());
        std::fs::write(dir.join(AUTO_INSTALL_FILE), "off").unwrap();
        assert!(!read_auto_install(&dir).unwrap());
        std::fs::write(dir.join(AUTO_INSTALL_FILE), "maybe").unwrap();
        assert!(read_auto_install(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn downloaded_installers_wait_on_disk_and_only_match_their_version() {
        let dir = temp_data("installer");
        let updates = Updates::default();
        let prepared = Prepared::save(&dir, "0.4.0", &[1, 2, 3]).unwrap();
        let path = prepared.path.clone();
        *updates.downloaded.lock().unwrap() = Some(prepared);
        assert_eq!(updates.downloaded_bytes("0.4.0"), Some(vec![1, 2, 3]));
        assert_eq!(updates.downloaded_bytes("0.4.1"), None);

        // A file changed after verification is never handed to the installer.
        std::fs::write(&path, [9, 9, 9]).unwrap();
        assert_eq!(updates.downloaded_bytes("0.4.0"), None);

        updates.clear_download();
        assert!(!path.exists());
        assert_eq!(updates.prepared_version(), None);

        Prepared::save(&dir, "0.4.0", &[1]).unwrap();
        discard_stale_installer(&dir);
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
