#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod game_detection;
#[cfg(windows)]
mod installer_window;
mod telemetry;
mod update_trace;
mod updates;
mod vault;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
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
            .map_err(|_| "Start Wisp first.")?;
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
            .timeout(Duration::from_secs(if route == "/mcps/test" {
                90
            } else {
                40
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

#[tauri::command]
async fn desktop_info(
    host: tauri::State<'_, Host>,
    telemetry: tauri::State<'_, telemetry::Telemetry>,
) -> Result<Value, String> {
    let telemetry_enabled = telemetry.enabled();
    let data = host.data.clone();
    let payload = host.payload.clone();
    tauri::async_runtime::spawn_blocking(move || {
    let config = fs::read(data.join("config.local.json"))
        .ok()
        .and_then(|s| serde_json::from_slice::<Value>(&s).ok())
        .unwrap_or(json!({}));
    let addon_outdated = config["wow"].as_str().and_then(|wow| {
        addon_differs(
            &payload.join("addon/WispAI"),
            &Path::new(wow).join("Interface/AddOns/WispAI"),
        )
        .ok()
    });
    json!({"wow":config["wow"], "configured":config["wow"].as_str().is_some(), "dataDirectory":data.to_string_lossy(), "platform": std::env::consts::OS, "version": env!("CARGO_PKG_VERSION"), "addonOutdated": addon_outdated, "telemetryEnabled": telemetry_enabled})

    }).await.map_err(|e| e.to_string())
}

fn addon_differs(source: &Path, installed: &Path) -> std::io::Result<bool> {
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let target = installed.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            if addon_differs(&entry.path(), &target)? {
                return Ok(true);
            }
        } else if fs::read(entry.path())? != fs::read(target).unwrap_or_default() {
            return Ok(true);
        }
    }
    Ok(false)
}

#[tauri::command]
async fn start_bridge(host: tauri::State<'_, Host>) -> Result<(), String> {
    if host.request("GET", "/status", json!({})).await.is_ok() {
        return Ok(());
    }
    if !host.data.join("config.local.json").is_file() {
        return Err("Choose your WoW folder and install the addon first.".into());
    }
    let mut child = host
        .child
        .lock()
        .map_err(|_| "Application state is unavailable.")?;
    if let Some(process) = child.as_mut() {
        if process.try_wait().map_err(|e| e.to_string())?.is_none() {
            return Ok(());
        }
    }
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(host.data.join("runtime/bridge.log"))
        .map_err(|e| e.to_string())?;
    let mut command = host.command("src/main.ts")?;
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
    Ok(())
}

async fn stop_host(host: &Host) -> Result<(), String> {
    match host.request("POST", "/stop", json!({})).await {
        Ok(_) => {
            tracing::info!(
                component = "desktop",
                event = "bridge.stop_requested",
                "Bridge accepted the stop request"
            );
            for _ in 0..50 {
                if host.request("GET", "/status", json!({})).await.is_err() {
                    break;
                }
                tauri::async_runtime::spawn_blocking(|| {
                    std::thread::sleep(Duration::from_millis(100))
                })
                .await
                .map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        Err(error)
            if error == "Start Wisp first." || error == "The Wisp bridge is not responding." =>
        {
            Ok(())
        }
        Err(error) => Err(error),
    }
}

#[tauri::command]
async fn stop_bridge(host: tauri::State<'_, Host>) -> Result<(), String> {
    stop_host(&host).await
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
async fn install_addon(host: tauri::State<'_, Host>, wow: String) -> Result<String, String> {
    if !Path::new(&wow).join("Wow.exe").is_file()
        && !Path::new(&wow).join("World of Warcraft.app").exists()
    {
        return Err(
            "Choose the WoW client folder containing Wow.exe or World of Warcraft.app.".into(),
        );
    }
    stop_host(&host).await?;
    let mut command = host.command("scripts/install.ts")?;
    command
        .arg(wow)
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
    Ok("Addon installed. Restart WoW after first installation; use /reload for updates.".into())
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
    if host.data.join("config.local.json").exists() {
        return Err("Import is available before configuring this installation, to avoid overwriting your data.".into());
    }
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
    Ok("Imported your previous Wisp data. You can start Wisp now.".into())
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
        .manage(updates::Updates::default())
        .invoke_handler(tauri::generate_handler![
            telemetry::telemetry_settings,
            telemetry::telemetry_screen,
            updates::update_channel,
            bridge_request,
            desktop_info,
            game_detection::detect_game_folders,
            start_bridge,
            stop_bridge,
            pick_folder,
            install_addon,
            open_sign_in,
            open_exa_dashboard,
            open_logs,
            read_logs,
            import_legacy,
            updates::check_update,
            updates::install_update
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
                client: reqwest::Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .build()
                    .map_err(|e| e.to_string())?,
            });
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
    fn desktop_routes_are_explicit() {
        assert!(permitted("GET", "/status"));
        assert!(permitted("POST", "/mcps/save"));
        assert!(permitted("POST", "/routines/action"));
        assert!(permitted("POST", "/routines/open"));
        assert!(!permitted("POST", "/suggestions"));
        assert!(!permitted("GET", "http://example.com"));
        assert!(!permitted("POST", "/model/responses"));
        assert!(!permitted("POST", "/status"));
    }
}
