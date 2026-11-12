use prost::Message;
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

// Only decode the installation fields needed from Battle.net's local protobuf database.
#[derive(Message)]
struct InstallationDatabase {
    #[prost(message, repeated, tag = "1")]
    products: Vec<InstalledProduct>,
}

#[derive(Message)]
struct InstalledProduct {
    #[prost(message, optional, tag = "3")]
    client: Option<InstalledClient>,
    #[prost(string, tag = "6")]
    family: String,
}

#[derive(Message)]
struct InstalledClient {
    #[prost(string, tag = "1")]
    location: String,
    #[prost(string, tag = "13")]
    folder: String,
}

fn database_candidates(roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut bases = Vec::new();
    if let Some(program_data) = std::env::var_os("ProgramData") {
        bases.push(PathBuf::from(program_data));
    }
    bases.extend(roots.iter().map(|r| r.join("ProgramData")));
    let mut seen = HashSet::new();
    bases
        .into_iter()
        .map(|p| p.join("Battle.net/Agent/product.db"))
        .filter(|p| seen.insert(p.to_string_lossy().to_lowercase()))
        .collect()
}

fn registered_clients(path: &Path) -> Vec<PathBuf> {
    let Ok(file) = fs::File::open(path) else {
        return Vec::new();
    };
    let mut bytes = Vec::new();
    // Bound allocations and reject oversized or malformed databases.
    if file
        .take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() > 4 * 1024 * 1024
    {
        return Vec::new();
    }
    let Ok(database) = InstallationDatabase::decode(bytes.as_slice()) else {
        return Vec::new();
    };
    database
        .products
        .into_iter()
        .filter(|p| p.family == "wow")
        .filter_map(|p| p.client)
        .flat_map(|c| {
            let location = PathBuf::from(c.location);
            // Registrations can identify either the shared container or the client itself.
            if !location.is_absolute() {
                return Vec::new();
            }
            let mut candidates = vec![location.join("_forever_"), location.clone()];
            if c.folder == "_forever_" {
                candidates.push(location.join(c.folder));
            }
            candidates
        })
        .collect()
}

// Blizzard's product marker identifies Forever, independently of the folder name.
fn small_text(path: &Path) -> String {
    let mut text = String::new();
    if let Ok(file) = fs::File::open(path) {
        let _ = file.take(64 * 1024).read_to_string(&mut text);
    }
    text
}

fn forever(path: &Path) -> bool {
    if !path.join("Wow.exe").is_file() {
        return false;
    }
    let flavor = small_text(&path.join(".flavor.info"));
    if !flavor.is_empty() {
        return flavor
            .lines()
            .next()
            .is_some_and(|s| s.trim() == "Product Flavor!STRING:0")
            && flavor.lines().nth(1).is_some_and(|s| s.trim() == "wowf");
    }
    // Older installations may lack the per-client marker. Only associate the
    // parent's product table with its Forever child, never with a sibling client.
    if path
        .file_name()
        .is_none_or(|s| !s.eq_ignore_ascii_case("_forever_"))
    {
        return false;
    }
    let build = small_text(&path.parent().unwrap_or(path).join(".build.info"));
    let mut rows = build.lines();
    let columns: Vec<_> = rows.next().unwrap_or("").split('|').collect();
    let product = columns.iter().position(|s| s.starts_with("Product!"));
    let active = columns.iter().position(|s| s.starts_with("Active!"));
    match (product, active) {
        (Some(p), Some(a)) => rows.any(|row| {
            let fields: Vec<_> = row.split('|').collect();
            fields.get(p) == Some(&"wowf") && fields.get(a) == Some(&"1")
        }),
        _ => false,
    }
}

#[cfg(windows)]
fn local_disks() -> Vec<PathBuf> {
    use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};
    let mask = unsafe { GetLogicalDrives() };
    (0..26)
        .filter_map(|i| {
            if mask & (1 << i) == 0 {
                return None;
            }
            let root = format!("{}:\\", (b'A' + i) as char);
            let wide: Vec<_> = root.encode_utf16().chain(Some(0)).collect();
            // Fixed disks and removable local volumes; never probe network shares.
            matches!(unsafe { GetDriveTypeW(wide.as_ptr()) }, 2 | 3).then(|| PathBuf::from(root))
        })
        .collect()
}

#[cfg(not(windows))]
fn local_disks() -> Vec<PathBuf> {
    Vec::new()
}

fn scan(
    databases: Vec<PathBuf>,
    budget: Duration,
    mut on_found: impl FnMut(String),
) -> Vec<String> {
    let started = Instant::now();
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    let mut check = |path: &Path| {
        if forever(path) {
            if let Ok(path) = path.canonicalize() {
                let key = path.to_string_lossy().to_lowercase();
                if seen.insert(key) {
                    let folder = path
                        .to_string_lossy()
                        .trim_start_matches("\\\\?\\")
                        .to_string();
                    on_found(folder.clone());
                    found.push(folder);
                }
            }
        }
    };
    // Registered paths work across disks and do not depend on folder depth.
    for database in databases {
        if started.elapsed() >= budget {
            return found;
        }
        for candidate in registered_clients(&database) {
            if started.elapsed() >= budget {
                return found;
            }
            check(&candidate);
        }
    }
    found.sort();
    found
}

#[tauri::command]
pub async fn detect_game_folders(on_found: tauri::ipc::Channel<String>) -> Vec<String> {
    let started = Instant::now();
    let folders = detect_with(move |folder| {
        let _ = on_found.send(folder);
    })
    .await;
    tracing::info!(
        component = "desktop",
        event = "wow.folder_detection_finished",
        count = folders.len(),
        elapsed_ms = started.elapsed().as_millis() as u64,
        "WoW folder detection finished"
    );
    folders
}

async fn detect_with(mut on_found: impl FnMut(String) + Send + 'static) -> Vec<String> {
    // Keep the UI responsive even if a volume stalls on an I/O operation.
    let (send, receive) = std::sync::mpsc::channel();
    let partial = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let progress = partial.clone();
    std::thread::spawn(move || {
        let disks = local_disks();
        let databases = database_candidates(&disks);
        let folders = scan(databases, Duration::from_secs(3), |folder| {
            if let Ok(mut folders) = progress.lock() {
                folders.push(folder.clone());
            }
            on_found(folder);
        });
        let _ = send.send(folders);
    });
    tauri::async_runtime::spawn_blocking(move || {
        receive
            .recv_timeout(Duration::from_millis(3500))
            .unwrap_or_else(|_| partial.lock().map(|p| p.clone()).unwrap_or_default())
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn discovers_only_registered_installations_and_deduplicates_them() {
        let root = std::env::temp_dir().join(format!("wisp-db-detection-{}", std::process::id()));
        let registered = root.join("custom/deep/location/_forever_");
        let fallback = root.join("disk/World of Warcraft/_forever_");
        for game in [&registered, &fallback] {
            fs::create_dir_all(game).unwrap();
            fs::write(game.join("Wow.exe"), "").unwrap();
            fs::write(game.join(".flavor.info"), "Product Flavor!STRING:0\nwowf\n").unwrap();
        }
        let db = root.join("product.db");
        let product = || InstalledProduct {
            family: "wow".into(),
            client: Some(InstalledClient {
                location: registered.parent().unwrap().to_string_lossy().into(),
                folder: "_forever_".into(),
            }),
        };
        fs::write(
            &db,
            InstallationDatabase {
                products: vec![product(), product()],
            }
            .encode_to_vec(),
        )
        .unwrap();
        let mut published = Vec::new();
        let results = scan(vec![db.clone()], Duration::from_secs(2), |p| {
            published.push(p)
        });
        assert_eq!(published.len(), 1);
        assert_eq!(results.len(), 1);
        assert_eq!(
            Path::new(&published[0]).canonicalize().unwrap(),
            registered.canonicalize().unwrap()
        );
        fs::write(&db, [0x0a, 0xff]).unwrap();
        assert!(registered_clients(&db).is_empty());
        assert!(scan(vec![db.clone()], Duration::from_secs(1), |_| {}).is_empty());
        assert!(registered_clients(&root.join("missing.db")).is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "Read-only smoke test on real disks; set WISP_EXPECT_GAME to the expected client folder"]
    fn detects_real_installation() {
        let expected =
            PathBuf::from(std::env::var_os("WISP_EXPECT_GAME").expect("Set WISP_EXPECT_GAME"))
                .canonicalize()
                .unwrap();
        for run in 1..=3 {
            let started = Instant::now();
            let folders = tauri::async_runtime::block_on(detect_with(move |folder| {
                println!("Run {run}: result at {:?}: {folder}", started.elapsed());
            }));
            println!("Run {run}: {:?}; folders: {folders:?}", started.elapsed());
            assert!(
                folders
                    .iter()
                    .any(|p| Path::new(p).canonicalize().ok().as_ref() == Some(&expected)),
                "Expected installation was not returned by the real detector"
            );
        }
        let registered = database_candidates(&local_disks()).iter().any(|db| {
            registered_clients(db)
                .iter()
                .any(|p| p.canonicalize().ok().as_ref() == Some(&expected) && forever(p))
        });
        println!("Expected client registered in Battle.net and validated: {registered}");
    }

    #[test]
    fn rejects_other_clients_and_accepts_forever_metadata() {
        let root = std::env::temp_dir().join(format!("wisp-detection-{}", std::process::id()));
        let game = root.join("disk-e/Blizzard/World of Warcraft/_forever_");
        let retail = root.join("disk-c/World of Warcraft/_retail_");
        fs::create_dir_all(&game).unwrap();
        fs::create_dir_all(&retail).unwrap();
        fs::write(game.join("Wow.exe"), "").unwrap();
        fs::write(retail.join("Wow.exe"), "").unwrap();
        fs::write(
            game.join(".flavor.info"),
            "Product Flavor!STRING:0\r\nwowf\r\n",
        )
        .unwrap();
        fs::write(
            retail.join(".flavor.info"),
            "Product Flavor!STRING:0\nwow\n",
        )
        .unwrap();
        assert!(forever(&game));
        assert!(!forever(&retail));
        assert_eq!(scan(vec![], Duration::from_secs(2), |_| {}).len(), 0);
        fs::remove_file(game.join(".flavor.info")).unwrap();
        fs::write(
            game.parent().unwrap().join(".build.info"),
            "Active!DEC:1|Product!STRING:0\n1|wowf\n",
        )
        .unwrap();
        assert!(forever(&game));
        fs::write(
            game.join(".flavor.info"),
            "Product Flavor!STRING:0\nwow_classic\n",
        )
        .unwrap();
        assert!(!forever(&game));
        assert!(scan(vec![], Duration::ZERO, |_| {}).is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
