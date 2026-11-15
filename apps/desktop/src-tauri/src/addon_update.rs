use std::{fs, io, path::Path};

// Written by the NSIS post-install hook after a Desktop update completes.
pub const PENDING_FILE: &str = "runtime/addon-update-pending";

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Notice {
    ReloadRequired,
    Failed,
}

pub fn candidate(wow: &Path, outdated: Option<bool>) -> bool {
    outdated != Some(false) && wow.join("Interface/AddOns/WispAI/WispAI.toc").is_file()
}

pub fn differs(source: &Path, installed: &Path) -> io::Result<bool> {
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let target = installed.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            if differs(&entry.path(), &target)? {
                return Ok(true);
            }
        } else {
            let bundled = fs::read(entry.path())?;
            if !matches!(fs::read(target), Ok(bytes) if bundled == bytes) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

#[cfg(windows)]
pub fn wow_running() -> bool {
    use std::mem::size_of;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
    };

    // Enumerate process names so the reminder also works at the login screen.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return false;
        }
        let mut entry = PROCESSENTRY32W {
            dwSize: size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut has_entry = Process32FirstW(snapshot, &mut entry);
        let mut running = false;
        while has_entry != 0 {
            let name = String::from_utf16_lossy(&entry.szExeFile);
            if name.trim_end_matches('\0').eq_ignore_ascii_case("Wow.exe") {
                running = true;
                break;
            }
            has_entry = Process32NextW(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
        running
    }
}

#[cfg(not(windows))]
pub fn wow_running() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_different_preexisting_addon_is_an_update_candidate() {
        let root = std::env::temp_dir().join(format!("wisp-addon-{}", uuid::Uuid::new_v4()));
        let wow = root.join("wow");
        let bundled = root.join("bundled");
        let installed = wow.join("Interface/AddOns/WispAI");
        fs::create_dir_all(&bundled).unwrap();
        fs::create_dir_all(&installed).unwrap();
        let toc = "WispAI.toc";
        fs::write(bundled.join(toc), "## Version: 1.0.0\n").unwrap();

        assert!(differs(&bundled, &installed).unwrap());
        assert!(!candidate(&wow, Some(true)));

        fs::write(installed.join(toc), "## Version: 0.1.2\n").unwrap();
        assert!(candidate(&wow, differs(&bundled, &installed).ok()));

        fs::copy(bundled.join(toc), installed.join(toc)).unwrap();
        assert!(!candidate(&wow, differs(&bundled, &installed).ok()));

        fs::write(bundled.join("Core.lua"), "new code\n").unwrap();
        assert!(candidate(&wow, differs(&bundled, &installed).ok()));
        fs::remove_dir_all(root).unwrap();
    }
}
