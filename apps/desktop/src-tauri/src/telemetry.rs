use posthog_rs::{Client, ClientOptionsBuilder, Event};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::Manager;

const TOKEN: &str = "phc_se29yi8DLMmFxhRcqQrzrSs9vGLzAiEGmsaMvjotDdTE";
const HOST: &str = "https://us.i.posthog.com";

fn filter_event(file: &Path, mut event: Event) -> Option<Event> {
    let preferences: Preferences = serde_json::from_slice(&fs::read(file).ok()?).ok()?;
    if !preferences.enabled {
        return None;
    }
    let keys: Vec<_> = event
        .properties()
        .keys()
        .filter(|key| {
            ![
                "surface",
                "app_version",
                "channel",
                "os",
                "arch",
                "section",
                "$process_person_profile",
                "$geoip_disable",
                "$lib",
                "$lib_version",
            ]
            .contains(&key.as_str())
        })
        .cloned()
        .collect();
    for key in keys {
        event.remove_prop(&key);
    }
    Some(event)
}

#[derive(Clone, Serialize, Deserialize)]
struct Preferences {
    enabled: bool,
    #[serde(rename = "installationId")]
    installation_id: String,
    #[serde(default, rename = "firstOpenSent")]
    first_open_sent: bool,
}

pub struct Telemetry {
    file: PathBuf,
    operation: Mutex<()>,
    client: tauri::async_runtime::Mutex<Option<Client>>,
}

pub fn release_enabled() -> bool {
    !cfg!(debug_assertions)
        && std::env::var_os("WISP_PAYLOAD_ROOT").is_none()
        && std::env::var("DO_NOT_TRACK").as_deref() != Ok("1")
}

impl Telemetry {
    pub fn new(data: &std::path::Path) -> Self {
        Self {
            file: data.join("telemetry.json"),
            operation: Mutex::new(()),
            client: tauri::async_runtime::Mutex::new(None),
        }
    }

    fn read(&self) -> Result<Preferences, String> {
        match fs::read(&self.file) {
            Ok(bytes) => {
                let preferences: Preferences =
                    serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                uuid::Uuid::parse_str(&preferences.installation_id).map_err(|e| e.to_string())?;
                Ok(preferences)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let preferences = Preferences {
                    enabled: true,
                    installation_id: uuid::Uuid::new_v4().to_string(),
                    first_open_sent: false,
                };
                self.save(&preferences)?;
                Ok(preferences)
            }
            Err(error) => Err(error.to_string()),
        }
    }

    fn save(&self, preferences: &Preferences) -> Result<(), String> {
        let temporary = self
            .file
            .with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            fs::write(
                &temporary,
                serde_json::to_vec(preferences).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            fs::rename(&temporary, &self.file).map_err(|e| e.to_string())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result
    }

    pub fn enabled(&self) -> bool {
        let Ok(_guard) = self.operation.lock() else {
            return false;
        };
        self.read().map(|p| p.enabled).unwrap_or(false)
    }

    fn settings(&self, enabled: Option<bool>) -> Result<Value, String> {
        let _guard = self
            .operation
            .lock()
            .map_err(|_| "Usage analytics settings are unavailable.")?;
        let mut preferences = self.read()?;
        if let Some(enabled) = enabled {
            preferences.enabled = enabled;
            self.save(&preferences)?;
        }
        Ok(
            json!({ "enabled": preferences.enabled, "active": preferences.enabled && release_enabled() }),
        )
    }

    async fn send(&self, event: &str, extra: Value) -> bool {
        if !release_enabled() {
            return false;
        }
        let mut client = self.client.lock().await;
        let id = {
            let Ok(_guard) = self.operation.lock() else {
                return false;
            };
            match self.read() {
                Ok(p) if p.enabled => p.installation_id,
                _ => return false,
            }
        };
        let mut properties = json!({
            "surface": "desktop", "app_version": env!("CARGO_PKG_VERSION"),
            "channel": if env!("CARGO_PKG_VERSION").contains("-nightly.") { "nightly" } else { "stable" },
            "os": std::env::consts::OS, "arch": std::env::consts::ARCH,
            "$process_person_profile": false, "$geoip_disable": true
        });
        if let Some(extra) = extra.as_object() {
            properties.as_object_mut().unwrap().extend(extra.clone());
        }
        if client.is_none() {
            let file = self.file.clone();
            let Ok(options) = ClientOptionsBuilder::default()
                .api_key(TOKEN.to_string())
                .host(HOST)
                .request_timeout_seconds(3u64)
                .max_capture_attempts(1u32)
                .disable_geoip(true)
                .is_server(false)
                .before_send(move |event| filter_event(&file, event))
                .build()
            else {
                return false;
            };
            *client = Some(posthog_rs::client(options).await);
        }
        let mut sdk_event = Event::new(event, id.as_str());
        for (key, value) in properties.as_object().unwrap() {
            if sdk_event.insert_prop(key, value).is_err() {
                return false;
            }
        }
        // Confirm delivery before persisting firstOpenSent; no manual HTTP protocol.
        client
            .as_ref()
            .unwrap()
            .capture_immediate(sdk_event)
            .await
            .map(|summary| summary.submitted() == 1 && summary.all_persisted())
            .unwrap_or(false)
    }

    pub async fn opened(&self) {
        if !release_enabled() {
            return;
        }
        let first = {
            let Ok(_guard) = self.operation.lock() else {
                return;
            };
            match self.read() {
                Ok(p) if p.enabled => !p.first_open_sent,
                _ => return,
            }
        };
        if first && self.send("app_first_open", json!({})).await {
            if let Ok(_guard) = self.operation.lock() {
                if let Ok(mut preferences) = self.read() {
                    preferences.first_open_sent = true;
                    let _ = self.save(&preferences);
                }
            }
        }
        self.send("app_opened", json!({})).await;
        self.send("app_active", json!({})).await;
    }
}

#[tauri::command]
pub fn telemetry_settings(
    telemetry: tauri::State<'_, Telemetry>,
    enabled: Option<bool>,
) -> Result<Value, String> {
    telemetry.settings(enabled)
}

#[tauri::command]
pub async fn telemetry_screen(
    telemetry: tauri::State<'_, Telemetry>,
    screen: String,
) -> Result<(), String> {
    if [
        "Overview",
        "Connections",
        "Integrations",
        "Memory",
        "Panels",
        "Routines",
        "Settings",
        "Diagnostics",
    ]
    .contains(&screen.as_str())
    {
        telemetry
            .send("desktop_section_viewed", json!({ "section": screen }))
            .await;
    }
    Ok(())
}

pub fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        app.state::<Telemetry>().opened().await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (PathBuf, Telemetry) {
        let directory =
            std::env::temp_dir().join(format!("wisp-telemetry-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let telemetry = Telemetry::new(&directory);
        (directory, telemetry)
    }
    #[test]
    fn preferences_default_on_and_preserve_identity_and_opt_out() {
        let (directory, telemetry) = fixture();
        assert!(telemetry.enabled());
        let id = telemetry.read().unwrap().installation_id;
        telemetry.settings(Some(false)).unwrap();
        let restarted = Telemetry::new(&directory);
        assert!(!restarted.enabled());
        assert_eq!(restarted.read().unwrap().installation_id, id);
        restarted.settings(Some(true)).unwrap();
        assert_eq!(restarted.read().unwrap().installation_id, id);
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn corrupt_preferences_fail_closed_without_resetting_opt_out() {
        let (directory, telemetry) = fixture();
        fs::write(&telemetry.file, b"broken").unwrap();
        assert!(!telemetry.enabled());
        assert!(telemetry.settings(None).is_err());
        assert_eq!(fs::read(&telemetry.file).unwrap(), b"broken");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn sdk_hook_rechecks_opt_out_and_removes_ambient_properties() {
        let (directory, telemetry) = fixture();
        assert!(telemetry.enabled());
        let mut event = Event::new("app_active", "random-installation");
        event.insert_prop("app_version", "0.1.0").unwrap();
        event.insert_prop("email", "PRIVATE").unwrap();
        let filtered = filter_event(&telemetry.file, event.clone()).unwrap();
        assert_eq!(
            filtered.properties().get("app_version"),
            Some(&json!("0.1.0"))
        );
        assert!(!filtered.properties().contains_key("email"));
        telemetry.settings(Some(false)).unwrap();
        assert!(filter_event(&telemetry.file, event).is_none());
        fs::remove_dir_all(directory).unwrap();
    }
}
