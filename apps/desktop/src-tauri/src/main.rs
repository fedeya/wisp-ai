#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod addon_update;
mod game_detection;
#[cfg(windows)]
mod installer_window;
mod native_shell;
mod telemetry;
mod update_trace;
mod updates;
mod vault;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconEvent},
    Emitter, Manager,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

struct Host {
    data: PathBuf,
    payload: PathBuf,
    child: Mutex<Option<Child>>,
    lifecycle: tauri::async_runtime::Mutex<()>,
    /// Whether the bridge child is meant to be running; see `supervise_bridge`.
    supervised: AtomicBool,
    addon_notice: tauri::async_runtime::Mutex<Option<addon_update::Notice>>,
    client: reqwest::Client,
}

fn hidden(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    #[cfg(not(windows))]
    let _ = command;
}

impl Host {
    fn child_running(&self) -> Result<bool, String> {
        let mut child = self
            .child
            .lock()
            .map_err(|_| "Application state is unavailable.")?;
        match child.as_mut() {
            Some(process) => process
                .try_wait()
                .map(|status| status.is_none())
                .map_err(|error| error.to_string()),
            None => Ok(false),
        }
    }

    fn node(&self) -> PathBuf {
        let engine = self.payload.join("wisp-engine.exe");
        if engine.is_file() {
            return engine;
        }
        self.payload
            .join("runtime")
            .join(if cfg!(windows) { "node.exe" } else { "node" })
    }
    fn command(&self, script: &str) -> Result<Command, String> {
        let mut command = Command::new(self.node());
        command
            .arg(if self.payload.join("wisp-engine.exe").is_file() {
                PathBuf::from(script)
            } else {
                self.payload.join(script)
            })
            .current_dir(&self.payload)
            .env("WISP_DATA_DIR", &self.data)
            .env("WISP_RESOURCE_ROOT", &self.payload)
            .env(
                "WISP_TELEMETRY_RELEASE",
                if telemetry::release_enabled() {
                    "1"
                } else {
                    "0"
                },
            )
            .env(
                "WISP_DESKTOP_EXE",
                std::env::current_exe().map_err(|e| e.to_string())?,
            )
            .env("DO_NOT_TRACK", "1");
        let mut paths = vec![self.payload.join("runtime")];
        if let Some(existing) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&existing));
        }
        command.env(
            "PATH",
            std::env::join_paths(paths).map_err(|e| e.to_string())?,
        );
        hidden(&mut command);
        Ok(command)
    }
    async fn request(&self, method: &str, route: &str, body: Value) -> Result<Value, String> {
        let identity_path = self.data.join("runtime/desktop.json");
        let raw = tauri::async_runtime::spawn_blocking(move || fs::read(identity_path))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|_| "The Wisp service is not running.")?;
        let identity: Value =
            serde_json::from_slice(&raw).map_err(|_| "Invalid bridge identity.")?;
        let port = identity["port"]
            .as_u64()
            .filter(|p| *p > 0 && *p < 65536)
            .ok_or("Invalid bridge port.")?;
        let token = identity["token"]
            .as_str()
            .ok_or("Invalid bridge identity.")?;
        let request = self
            .client
            .request(
                if method == "GET" {
                    reqwest::Method::GET
                } else {
                    reqwest::Method::POST
                },
                format!("http://127.0.0.1:{port}{route}"),
            )
            .bearer_auth(token)
            .timeout(Duration::from_secs(match route {
                "/mcps/test" => 90,
                "/status" | "/stop" => 3,
                _ => 40,
            }));
        let response = if method == "GET" {
            request
        } else {
            request.json(&body)
        }
        .send()
        .await
        .map_err(|_| "The Wisp bridge is not responding.")?;
        let ok = response.status().is_success();
        let value: Value = response
            .json()
            .await
            .map_err(|_| "Unexpected bridge response.")?;
        if !ok {
            return Err(value["error"]
                .as_str()
                .unwrap_or("The operation failed.")
                .to_string());
        }
        Ok(value)
    }
}

fn permitted(method: &str, route: &str) -> bool {
    (method == "GET" && ["/status", "/auth/models"].contains(&route))
        || (method == "POST"
            && [
                "/auth/start",
                "/auth/cancel",
                "/auth/select",
                "/auth/disconnect",
                "/auth/model",
                "/connections/save",
                "/connections/test",
                "/connections/discover",
                "/connections/remove",
                "/search/save",
                "/search/test",
                "/search/remove-exa",
                "/integrations/set",
                "/mcps/test",
                "/mcps/save",
                "/mcps/remove",
                "/panels/action",
                "/routines/action",
                "/routines/open",
                "/simulator/character",
                "/app-update",
            ]
            .contains(&route))
}

#[tauri::command]
async fn bridge_request(
    host: tauri::State<'_, Host>,
    method: String,
    route: String,
    body: Option<Value>,
) -> Result<Value, String> {
    if !permitted(&method, &route) {
        return Err("Unsupported desktop operation.".into());
    }
    let body = body.unwrap_or(json!({}));
    if body.to_string().len() > 100000 {
        return Err("Request is too large.".into());
    }
    host.request(&method, &route, body).await
}

async fn addon_installation(host: &Host) -> Result<(Option<String>, Option<bool>), String> {
    let data = host.data.clone();
    let payload = host.payload.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let wow = fs::read(data.join("config.local.json"))
            .ok()
            .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok())
            .and_then(|config| config["wow"].as_str().map(str::to_owned));
        let outdated = wow.as_deref().and_then(|folder| {
            addon_update::differs(
                &payload.join("addon/WispAI"),
                &Path::new(folder).join("Interface/AddOns/WispAI"),
            )
            .ok()
        });
        (wow, outdated)
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn desktop_info(
    host: tauri::State<'_, Host>,
    telemetry: tauri::State<'_, telemetry::Telemetry>,
) -> Result<Value, String> {
    let (wow, addon_outdated) = addon_installation(&host).await?;
    let addon_notice = *host.addon_notice.lock().await;
    let addon_update_pending = cfg!(all(windows, not(debug_assertions)))
        && host.data.join(addon_update::PENDING_FILE).is_file();
    Ok(json!({
        "wow": wow,
        "configured": wow.is_some(),
        "dataDirectory": host.data.to_string_lossy(),
        "platform": std::env::consts::OS,
        "version": env!("CARGO_PKG_VERSION"),
        "addonOutdated": addon_outdated,
        "addonUpdateNotice": addon_notice,
        "addonUpdatePending": addon_update_pending,
        "telemetryEnabled": telemetry.enabled(),
    }))
}

#[tauri::command]
async fn auto_update_addon(
    app: tauri::AppHandle,
    host: tauri::State<'_, Host>,
) -> Result<Option<Value>, String> {
    if !cfg!(all(windows, not(debug_assertions))) {
        return Ok(None);
    }
    let _operation = host.lifecycle.lock().await;
    let pending = host.data.join(addon_update::PENDING_FILE);
    if !pending.is_file() {
        return Ok(None);
    }
    let (wow, mut outdated) = addon_installation(&host).await?;
    let mut notice = None;
    if let Some(folder) = wow.as_ref() {
        if addon_update::candidate(Path::new(folder), outdated) {
            let result = run_addon_installer(&host, folder.clone()).await;
            telemetry::addon_install_finished(app, result.as_ref().err().map(|(code, _)| *code));
            match result {
                Ok(_) => {
                    outdated = Some(false);
                    if addon_update::wow_running() {
                        notice = Some(addon_update::Notice::ReloadRequired);
                    }
                }
                Err((_, error)) => {
                    tracing::warn!(
                        event = "addon.auto_update_failed",
                        error = %error,
                        "Automatic addon update failed"
                    );
                    notice = Some(addon_update::Notice::Failed);
                }
            }
        } else if let Err(error) = resume_wow_transport(&host, None).await {
            tracing::warn!(
                event = "addon.transport_resume_failed",
                error = %error,
                "Could not resume communication with WoW after checking for an addon update"
            );
            notice = Some(addon_update::Notice::Failed);
        }
    }
    *host.addon_notice.lock().await = notice;
    let _ = fs::remove_file(pending);
    Ok(Some(json!({
        "wow": wow,
        "addonOutdated": outdated,
        "addonUpdateNotice": notice,
        "addonUpdatePending": false,
    })))
}

#[tauri::command]
async fn start_bridge(host: tauri::State<'_, Host>) -> Result<(), String> {
    let _operation = host.lifecycle.lock().await;
    start_host(&host).await
}

async fn start_host(host: &Host) -> Result<(), String> {
    if host.child_running()? || host.request("GET", "/status", json!({})).await.is_ok() {
        return Ok(());
    }
    let mut child = host
        .child
        .lock()
        .map_err(|_| "Application state is unavailable.")?;
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(host.data.join("runtime/bridge.log"))
        .map_err(|e| e.to_string())?;
    let mut command = host.command("src/main.ts")?;
    if cfg!(all(windows, not(debug_assertions)))
        && host.data.join(addon_update::PENDING_FILE).is_file()
    {
        command.env("WISP_DEFER_WOW_TRANSPORT", "1");
    }
    command
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log);
    let process = command.spawn().map_err(|error| {
        tracing::error!(
            component = "desktop",
            event = "bridge.spawn_failed",
            kind = ?error.kind(),
            "Could not spawn the bridge"
        );
        format!("Cannot start Wisp: {error}")
    })?;
    tracing::info!(
        component = "desktop",
        event = "bridge.spawned",
        pid = process.id(),
        "Spawned the bridge"
    );
    *child = Some(process);
    host.mark_stop_requested(false);
    host.supervised.store(true, Ordering::SeqCst);
    Ok(())
}

/// Waits before relaunching a bridge that exited on its own. The step grows
/// with each crash of a bridge that ran less than `BRIDGE_STABLE_AFTER`; the
/// last step repeats.
const BRIDGE_RELAUNCH_DELAYS: [Duration; 5] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(10),
    Duration::from_secs(30),
];
/// A bridge that ran this long before exiting restarts the backoff.
const BRIDGE_STABLE_AFTER: Duration = Duration::from_secs(60);
const BRIDGE_SUPERVISE_INTERVAL: Duration = Duration::from_secs(2);

fn bridge_relaunch_delay(crashes: usize) -> Duration {
    BRIDGE_RELAUNCH_DELAYS[crashes.min(BRIDGE_RELAUNCH_DELAYS.len() - 1)]
}

/// Present while a deliberate bridge stop is in progress or done, by this
/// process or another one (the update helper). Removed when a bridge starts.
const BRIDGE_STOP_MARKER: &str = "runtime/bridge-stop-requested";

impl Host {
    fn stop_requested(&self) -> bool {
        self.data.join(BRIDGE_STOP_MARKER).is_file()
    }

    fn mark_stop_requested(&self, requested: bool) {
        let marker = self.data.join(BRIDGE_STOP_MARKER);
        let result = if requested {
            fs::write(&marker, b"")
        } else {
            fs::remove_file(&marker).or_else(|error| match error.kind() {
                std::io::ErrorKind::NotFound => Ok(()),
                _ => Err(error),
            })
        };
        if let Err(error) = result {
            tracing::warn!(
                component = "desktop",
                event = "bridge.stop_marker_failed",
                error = %error,
                "Could not update the bridge stop marker"
            );
        }
    }

    /// Takes the bridge child if it exited while it was meant to be running.
    /// An exit that another process requested turns supervision off instead.
    fn take_crashed_child(&self) -> Result<Option<std::process::ExitStatus>, String> {
        if !self.supervised.load(Ordering::SeqCst) {
            return Ok(None);
        }
        let mut child = self
            .child
            .lock()
            .map_err(|_| "Application state is unavailable.")?;
        let status = match child.as_mut() {
            Some(process) => process.try_wait().map_err(|error| error.to_string())?,
            None => None,
        };
        if status.is_none() {
            return Ok(None);
        }
        *child = None;
        if self.stop_requested() {
            self.supervised.store(false, Ordering::SeqCst);
            tracing::info!(
                component = "desktop",
                event = "bridge.stopped_elsewhere",
                "The bridge was stopped on request by another Wisp process"
            );
            return Ok(None);
        }
        Ok(status)
    }
}

/// Relaunches the bridge when it exits without a stop request, so a crash
/// does not leave Wisp offline until the app is reopened. Every deliberate
/// stop goes through `stop_host`, which turns supervision off first.
async fn supervise_bridge(app: tauri::AppHandle) {
    let mut crashes = 0usize;
    let mut launched_at = std::time::Instant::now();
    // Set while a relaunch is owed: after a crash, and after a failed spawn.
    let mut relaunching = false;
    loop {
        pause(BRIDGE_SUPERVISE_INTERVAL).await;
        let host = app.state::<Host>();
        if !relaunching {
            let _operation = host.lifecycle.lock().await;
            match host.take_crashed_child() {
                Ok(Some(status)) => {
                    relaunching = true;
                    tracing::warn!(
                        component = "desktop",
                        event = "bridge.exited_unexpectedly",
                        code = ?status.code(),
                        "The bridge exited without a stop request"
                    );
                }
                Ok(None) => continue,
                Err(error) => {
                    tracing::error!(
                        component = "desktop",
                        event = "bridge.supervise_failed",
                        error = %error,
                        "Bridge supervision failed"
                    );
                    continue;
                }
            }
        }
        if launched_at.elapsed() >= BRIDGE_STABLE_AFTER {
            crashes = 0;
        }
        let delay = bridge_relaunch_delay(crashes);
        crashes += 1;
        pause(delay).await;
        let _operation = host.lifecycle.lock().await;
        // A stop request during the wait wins over the relaunch, including
        // one from another process such as the update helper.
        if !host.supervised.load(Ordering::SeqCst) || host.stop_requested() {
            host.supervised.store(false, Ordering::SeqCst);
            relaunching = false;
            continue;
        }
        launched_at = std::time::Instant::now();
        match start_host(&host).await {
            Ok(()) => {
                relaunching = false;
                tracing::info!(
                    component = "desktop",
                    event = "bridge.relaunched",
                    attempt = crashes,
                    "Relaunched the bridge"
                );
            }
            Err(error) => tracing::error!(
                component = "desktop",
                event = "bridge.relaunch_failed",
                attempt = crashes,
                error = %error,
                "Could not relaunch the bridge"
            ),
        }
    }
}

async fn pause(duration: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(duration)).await;
}

async fn stop_host(host: &Host) -> Result<(), String> {
    // Supervision is off while stopping so the supervisor never relaunches a
    // bridge that is exiting on request. A stop that fails (for example the
    // bridge refuses while a reply is running) leaves the app and bridge
    // running, so the previous supervision comes back with it.
    //
    // The flag only reaches this process. The update helper stops the bridge
    // from a separate process while the desktop app may still be open, so the
    // stop is also recorded on disk for that app's supervisor to honor.
    let supervised = host.supervised.swap(false, Ordering::SeqCst);
    host.mark_stop_requested(true);
    let result = request_bridge_stop(host).await;
    if result.is_err() {
        host.mark_stop_requested(false);
        host.supervised.store(supervised, Ordering::SeqCst);
    }
    result
}

async fn request_bridge_stop(host: &Host) -> Result<(), String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        match host.request("POST", "/stop", json!({})).await {
            Ok(_) => break,
            Err(error)
                if error == "The Wisp service is not running."
                    || error == "The Wisp bridge is not responding." =>
            {
                if !host.child_running()? {
                    return Ok(());
                }
                // The child may still be opening the desktop API.
                wait_for_bridge(deadline).await?;
            }
            Err(error) => return Err(error),
        }
    }

    tracing::info!(
        component = "desktop",
        event = "bridge.stop_requested",
        "Bridge accepted the stop request"
    );
    // The listener closes before the child releases SQLite and Eve.
    while host.child_running()? {
        wait_for_bridge(deadline).await?;
    }
    while host.request("GET", "/status", json!({})).await.is_ok() {
        wait_for_bridge(deadline).await?;
    }
    Ok(())
}

async fn wait_for_bridge(deadline: std::time::Instant) -> Result<(), String> {
    if std::time::Instant::now() >= deadline {
        return Err("The Wisp service did not stop. See Diagnostics for details.".into());
    }
    tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(100)))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Choose a folder")
            .blocking_pick_folder()
            .map(|p| p.to_string())
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn install_addon(
    app: tauri::AppHandle,
    host: tauri::State<'_, Host>,
    wow: String,
) -> Result<String, String> {
    let _operation = host.lifecycle.lock().await;
    let mut addon_notice = host.addon_notice.lock().await;
    let result = run_addon_installer(&host, wow).await;
    if result.is_ok() {
        *addon_notice = None;
    }
    telemetry::addon_install_finished(app, result.as_ref().err().map(|(code, _)| *code));
    result.map_err(|(_, message)| message)
}

async fn run_addon_installer(
    host: &Host,
    wow: String,
) -> Result<String, (telemetry::AddonInstallError, String)> {
    use telemetry::AddonInstallError;

    if !Path::new(&wow).join("Wow.exe").is_file()
        && !Path::new(&wow).join("World of Warcraft.app").exists()
    {
        return Err((
            AddonInstallError::InvalidGameFolder,
            "Choose the WoW client folder containing Wow.exe or World of Warcraft.app.".into(),
        ));
    }
    let mut command = host
        .command("scripts/install.ts")
        .map_err(|error| (AddonInstallError::InstallerUnavailable, error))?;
    command
        .arg(&wow)
        .arg("--skip-config")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    wait_for_service(host)
        .await
        .map_err(|error| (AddonInstallError::TransportPause, error))?;
    host.request("POST", "/addon/transport", json!({"action": "pause"}))
        .await
        .map_err(|error| (AddonInstallError::TransportPause, error))?;

    const MESSAGE: &str =
        "Addon installed. Restart WoW after first installation; use /reload for updates.";
    let result = match run_addon_install_command(command).await {
        Ok(()) => resume_wow_transport(host, Some(&wow))
            .await
            .map_err(|error| (AddonInstallError::TransportResume, error)),
        Err(error) => Err(error),
    };
    if result.is_err() {
        restore_wow_transport(host).await;
    }
    result.map(|()| MESSAGE.into())
}

async fn run_addon_install_command(
    mut command: Command,
) -> Result<(), (telemetry::AddonInstallError, String)> {
    use telemetry::AddonInstallError;

    let output = tauri::async_runtime::spawn_blocking(move || command.output())
        .await
        .map_err(|e| (AddonInstallError::InstallerLaunch, e.to_string()))?
        .map_err(|e| (AddonInstallError::InstallerLaunch, e.to_string()))?;
    if !output.status.success() {
        return Err((
            AddonInstallError::InstallerFailed,
            String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(1000)
                .collect(),
        ));
    }
    Ok(())
}

async fn wait_for_service(host: &Host) -> Result<(), String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        match host.request("GET", "/status", json!({})).await {
            Ok(_) => return Ok(()),
            Err(error) if !host.child_running()? || std::time::Instant::now() >= deadline => {
                return Err(error);
            }
            Err(_) => {
                tauri::async_runtime::spawn_blocking(|| {
                    std::thread::sleep(Duration::from_millis(100))
                })
                .await
                .map_err(|error| error.to_string())?;
            }
        }
    }
}

async fn resume_wow_transport(host: &Host, wow: Option<&str>) -> Result<(), String> {
    wait_for_service(host).await?;
    let body = match wow {
        Some(folder) => json!({"action": "resume", "wow": folder}),
        None => json!({"action": "resume"}),
    };
    host.request("POST", "/addon/transport", body).await?;
    Ok(())
}

async fn restore_wow_transport(host: &Host) {
    if let Err(error) = resume_wow_transport(host, None).await {
        tracing::warn!(
            event = "addon.transport_resume_failed",
            error = %error,
            "Could not restore the WoW connection after installation failed"
        );
    }
}

#[tauri::command]
fn open_exa_dashboard(app: tauri::AppHandle) -> Result<(), String> {
    app.opener()
        .open_url("https://dashboard.exa.ai/", None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_sign_in(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed = reqwest::Url::parse(&url).map_err(|_| "Invalid sign-in address.")?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("auth.openai.com")
        || parsed.port().is_some()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("Unexpected sign-in address.".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_logs(app: tauri::AppHandle, host: tauri::State<'_, Host>) -> Result<(), String> {
    app.opener()
        .open_path(host.data.join("runtime").to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn read_logs(host: tauri::State<'_, Host>) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let mut output = String::new();
    for name in ["desktop.log", "bridge.log", "eve.log", "update.log"] {
        if let Ok(mut file) = fs::File::open(host.data.join("runtime").join(name)) {
            let len = file.metadata().map(|m| m.len()).unwrap_or(0);
            let _ = file.seek(SeekFrom::Start(len.saturating_sub(12000)));
            let mut bytes = Vec::new();
            let _ = file.read_to_end(&mut bytes);
            output.push_str(&format!(
                "--- {name} ---\n{}\n",
                String::from_utf8_lossy(&bytes)
            ));
        }
    }
    output
}

#[tauri::command]
async fn import_legacy(host: tauri::State<'_, Host>, source: String) -> Result<String, String> {
    let _operation = host.lifecycle.lock().await;
    if host.data.join("config.local.json").exists() {
        return Err("Import is available before configuring this installation, to avoid overwriting your data.".into());
    }
    stop_host(&host).await?;
    let result = run_legacy_import(&host, source).await;
    let restart = start_host(&host).await;
    let message = result?;
    restart?;
    Ok(message)
}

async fn run_legacy_import(host: &Host, source: String) -> Result<String, String> {
    let mut command = host.command("scripts/migrate-desktop.ts")?;
    command
        .arg(source)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = tauri::async_runtime::spawn_blocking(move || command.output())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr)
            .chars()
            .take(1000)
            .collect());
    }
    Ok("Imported your previous Wisp data.".into())
}

fn prepare_update() -> Result<(), String> {
    let data = vault::data_dir()?;
    let identity = fs::read(data.join("runtime/desktop.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    let pid = identity.as_ref().and_then(|value| value["pid"].as_u64());
    let host = Host {
        data,
        payload: PathBuf::new(),
        child: Mutex::new(None),
        lifecycle: tauri::async_runtime::Mutex::new(()),
        supervised: AtomicBool::new(false),
        addon_notice: Default::default(),
        client: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| e.to_string())?,
    };
    let running = tauri::async_runtime::block_on(host.request("GET", "/status", json!({}))).is_ok();
    tauri::async_runtime::block_on(stop_host(&host))?;
    // The HTTP listener closes before Eve and persistence finish. Wait for the
    // bridge process itself before the installer replaces its runtime files.
    #[cfg(windows)]
    if let Some(pid) = pid.filter(|id| running && *id > 0 && *id <= u32::MAX as u64) {
        use windows_sys::Win32::Foundation::{
            CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0,
        };
        use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject};
        unsafe {
            let process = OpenProcess(0x00100000, 0, pid as u32); // SYNCHRONIZE access only.
            if process.is_null() {
                if GetLastError() != ERROR_INVALID_PARAMETER {
                    return Err("Cannot wait for the previous Wisp bridge.".into());
                }
            } else {
                let result = WaitForSingleObject(process, 20000);
                CloseHandle(process);
                if result != WAIT_OBJECT_0 {
                    return Err("The previous Wisp bridge is still stopping.".into());
                }
            }
        }
    }
    #[cfg(not(windows))]
    let _ = (pid, running);
    Ok(())
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn init_desktop_log(data: &Path) -> std::io::Result<()> {
    let file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(data.join("runtime/desktop.log"))?;
    tracing_subscriber::fmt()
        .with_env_filter("wisp=info")
        .json()
        .flatten_event(true)
        .with_current_span(false)
        .with_span_list(false)
        .with_writer(Mutex::new(file))
        .try_init()
        .map_err(std::io::Error::other)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    #[cfg(windows)]
    if args.get(1).map(String::as_str) == Some("--installer-progress-svelte") {
        installer_window::run(&args[2..]);
        return;
    }
    if args.get(1).map(String::as_str) == Some("--prepare-update") {
        if let Err(error) = prepare_update() {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    if args.get(1).map(String::as_str) == Some("--secret") {
        if let Err(error) = vault::run(&args) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    if args.get(1).map(String::as_str) == Some("--self-test") {
        let result = (|| -> Result<(), String> {
            let payload = std::env::var_os("WISP_PAYLOAD_ROOT")
                .map(PathBuf::from)
                .unwrap_or(
                    std::env::current_exe()
                        .map_err(|e| e.to_string())?
                        .parent()
                        .ok_or("Missing executable directory")?
                        .join("payload"),
                );
            let engine = payload.join("wisp-engine.exe");
            let required: &[&str] = if engine.is_file() {
                &["addon/WispAI/WispAI.toc", "BUILD.json", "package.json"]
            } else {
                &[
                    "src/main.ts",
                    "node_modules/@wisp/agent/agent/agent.ts",
                    "scripts/install.ts",
                    "addon/WispAI/WispAI.toc",
                    "node_modules/eve/bin/eve.js",
                ]
            };
            for name in required {
                if !payload.join(name).is_file() {
                    return Err(format!("Missing resource: {name}"));
                }
            }
            let mut command = Command::new(if engine.is_file() {
                engine.clone()
            } else {
                payload
                    .join("runtime")
                    .join(if cfg!(windows) { "node.exe" } else { "node" })
            });
            hidden(&mut command);
            if !command
                .arg(if engine.is_file() {
                    "--self-test"
                } else {
                    "--version"
                })
                .output()
                .map_err(|e| e.to_string())?
                .status
                .success()
            {
                return Err("Bundled Node did not start".into());
            }
            vault::self_test()
        })();
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        - tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .with_denylist(&["updater"])
                .build(),
        )
        // Windows 11 snap layouts on our own maximize button (see WindowTitleBar.tsx).
        .plugin(
            tauri_plugin_snap_layout::init()
                .button_id("window-maximize")
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name(native_shell::AUTOSTART_NAME)
                .args([native_shell::MINIMIZED_ARG])
                .build(),
        )
        .manage(updates::Updates::default())
        .invoke_handler(tauri::generate_handler![
            telemetry::telemetry_settings,
            telemetry::telemetry_screen,
            telemetry::telemetry_onboarding,
            updates::update_channel,
            bridge_request,
            desktop_info,
            auto_update_addon,
            game_detection::detect_game_folders,
            start_bridge,
            pick_folder,
            install_addon,
            open_sign_in,
            open_exa_dashboard,
            open_logs,
            read_logs,
            import_legacy,
            updates::check_update,
            updates::install_update,
            native_shell::notify,
            native_shell::autostart_enabled,
            native_shell::set_autostart
        ])
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            update_trace::append(&data, "app-opened");
            fs::create_dir_all(data.join("runtime"))?;
            if let Err(error) = init_desktop_log(&data) {
                eprintln!("Could not initialize desktop diagnostics: {error}");
            }
            app.manage(telemetry::Telemetry::new(&data));
            telemetry::start(app.handle().clone());
            let payload = std::env::var_os("WISP_PAYLOAD_ROOT")
                .map(PathBuf::from)
                .unwrap_or(app.path().resource_dir()?.join("payload"));
            app.manage(Host {
                data,
                payload,
                child: Mutex::new(None),
                lifecycle: tauri::async_runtime::Mutex::new(()),
                supervised: AtomicBool::new(false),
                addon_notice: Default::default(),
                client: reqwest::Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .build()
                    .map_err(|e| e.to_string())?,
            });
            tauri::async_runtime::spawn(supervise_bridge(app.handle().clone()));
            let show =
                tauri::menu::MenuItem::with_id(app, "show", "Open Wisp", true, None::<&str>)?;
            let exit =
                tauri::menu::MenuItem::with_id(app, "exit", "Exit Wisp", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(app, &[&show, &exit])?;
            tauri::tray::TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Wisp AI")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .on_menu_event(|app, event| {
                    if event.id.as_ref() == "show" {
                        show_main_window(app);
                    } else if event.id.as_ref() == "exit" {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let host = app.state::<Host>();
                            let _operation = host.lifecycle.lock().await;
                            match stop_host(&host).await {
                                Ok(()) => app.exit(0),
                                Err(error) => {
                                    show_main_window(&app);
                                    let _ = app.emit("desktop-error", error);
                                }
                            }
                        });
                    }
                })
                .build(app)?;
            if let Some(window) = app.get_webview_window("main") {
                native_shell::disable_browser_shortcuts(&window);
                if !native_shell::start_hidden(&app.state::<Host>().data) {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            tracing::info!(
                component = "desktop",
                event = "desktop.started",
                version = app.package_info().version.to_string(),
                "Desktop initialized"
            );
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("Wisp could not start");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_stop_requested_by_another_process_is_not_relaunched() {
        let data = std::env::temp_dir().join(format!("wisp-elsewhere-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(data.join("runtime")).unwrap();
        let host = Host {
            data: data.clone(),
            payload: PathBuf::new(),
            child: Mutex::new(None),
            lifecycle: tauri::async_runtime::Mutex::new(()),
            supervised: AtomicBool::new(true),
            addon_notice: Default::default(),
            client: reqwest::Client::new(),
        };
        let mut command = if cfg!(windows) {
            let mut command = Command::new("cmd");
            command.args(["/C", "exit 0"]);
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", "exit 0"]);
            command
        };
        let mut process = command.spawn().expect("spawn a short-lived child");
        process.wait().expect("the child exits");
        *host.child.lock().unwrap() = Some(process);
        // The update helper's stop_host runs in its own process and leaves only the marker.
        fs::write(data.join(BRIDGE_STOP_MARKER), b"").unwrap();
        assert_eq!(host.take_crashed_child().unwrap(), None);
        assert!(!host.supervised.load(Ordering::SeqCst));
        assert!(host.child.lock().unwrap().is_none());
        let _ = fs::remove_dir_all(data);
    }

    #[test]
    fn a_rejected_stop_keeps_supervising_the_bridge() {
        let data = std::env::temp_dir().join(format!("wisp-stop-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(data.join("runtime")).unwrap();
        // An unusable identity makes the stop request fail like a refused stop.
        fs::write(data.join("runtime/desktop.json"), "{}").unwrap();
        let host = Host {
            data: data.clone(),
            payload: PathBuf::new(),
            child: Mutex::new(None),
            lifecycle: tauri::async_runtime::Mutex::new(()),
            supervised: AtomicBool::new(true),
            addon_notice: Default::default(),
            client: reqwest::Client::new(),
        };
        assert!(tauri::async_runtime::block_on(stop_host(&host)).is_err());
        assert!(host.supervised.load(Ordering::SeqCst));
        assert!(!host.stop_requested(), "a failed stop withdraws its marker");
        fs::remove_file(data.join("runtime/desktop.json")).unwrap();
        assert!(tauri::async_runtime::block_on(stop_host(&host)).is_ok());
        assert!(!host.supervised.load(Ordering::SeqCst));
        assert!(
            host.stop_requested(),
            "a completed stop stays visible to other processes"
        );
        let _ = fs::remove_dir_all(data);
    }

    #[test]
    fn bridge_relaunch_backs_off_and_repeats_the_last_step() {
        assert_eq!(bridge_relaunch_delay(0), Duration::from_secs(1));
        assert_eq!(bridge_relaunch_delay(3), Duration::from_secs(10));
        assert_eq!(bridge_relaunch_delay(4), Duration::from_secs(30));
        assert_eq!(bridge_relaunch_delay(99), Duration::from_secs(30));
    }

    #[test]
    fn only_a_supervised_bridge_that_exited_counts_as_crashed() {
        let host = Host {
            data: PathBuf::new(),
            payload: PathBuf::new(),
            child: Mutex::new(None),
            lifecycle: tauri::async_runtime::Mutex::new(()),
            supervised: AtomicBool::new(false),
            addon_notice: Default::default(),
            client: reqwest::Client::new(),
        };
        let mut command = if cfg!(windows) {
            let mut command = Command::new("cmd");
            command.args(["/C", "exit 3"]);
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", "exit 3"]);
            command
        };
        let mut process = command.spawn().expect("spawn a short-lived child");
        process.wait().expect("the child exits");
        *host.child.lock().unwrap() = Some(process);
        // A bridge stopped on request is not a crash.
        assert_eq!(host.take_crashed_child().unwrap(), None);
        assert!(host.child.lock().unwrap().is_some());
        host.supervised.store(true, Ordering::SeqCst);
        let status = host.take_crashed_child().unwrap().expect("a crash");
        assert_eq!(status.code(), Some(3));
        assert!(host.child.lock().unwrap().is_none());
        assert_eq!(host.take_crashed_child().unwrap(), None);
    }
    #[test]
    fn desktop_routes_are_explicit() {
        assert!(permitted("GET", "/status"));
        assert!(!permitted("POST", "/addon/transport"));
        assert!(permitted("POST", "/mcps/save"));
        assert!(permitted("POST", "/routines/action"));
        assert!(permitted("POST", "/routines/open"));
        assert!(permitted("POST", "/app-update"));
        assert!(!permitted("GET", "/app-update"));
        assert!(!permitted("POST", "/suggestions"));
        assert!(!permitted("GET", "http://example.com"));
        assert!(!permitted("POST", "/model/responses"));
        assert!(!permitted("POST", "/status"));
    }
}
