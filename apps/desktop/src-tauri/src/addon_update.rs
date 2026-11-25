use std::{fs, io, path::Path};

// Written after a packaged Desktop update: the NSIS hook on Windows, and the
// AppImage updater just before it replaces itself on Linux.
pub const PENDING_FILE: &str = "runtime/addon-update-pending";

/// Release builds on Windows and Linux refresh an existing addon after an update.
pub fn packaged_desktop() -> bool {
    !cfg!(debug_assertions) && cfg!(any(windows, target_os = "linux"))
}

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

pub fn process_is_wow(comm: &str, cmdline: &[u8]) -> bool {
    if comm
        .trim_end_matches(['\0', '\n', '\r'])
        .trim()
        .eq_ignore_ascii_case("Wow.exe")
    {
        return true;
    }
    cmdline.split(|byte| *byte == 0).any(|arg| {
        let text = String::from_utf8_lossy(arg);
        // Wine command lines keep Windows separators even when read on Linux.
        text.rsplit(['/', '\\'])
            .next()
            .is_some_and(|name| name.eq_ignore_ascii_case("Wow.exe"))
    })
}

#[cfg(target_os = "linux")]
pub fn wow_running() -> bool {
    let Ok(entries) = fs::read_dir("/proc") else {
        return false;
    };
    for entry in entries.flatten() {
        if !entry
            .file_name()
            .to_string_lossy()
            .chars()
            .all(|c| c.is_ascii_digit())
        {
            continue;
        }
        let comm = fs::read_to_string(entry.path().join("comm")).unwrap_or_default();
        let cmdline = fs::read(entry.path().join("cmdline")).unwrap_or_default();
        if process_is_wow(&comm, &cmdline) {
            return true;
        }
    }
    false
}

#[cfg(not(any(windows, target_os = "linux")))]
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

    #[test]
    fn wow_is_recognized_from_the_process_name_or_a_wine_command_line() {
        assert!(process_is_wow("Wow.exe\n", b""));
        assert!(process_is_wow("wow.exe", b""));
        assert!(!process_is_wow("wine\n", b"wine\0notepad.exe\0"));
        assert!(process_is_wow(
            "wine64\n",
            b"wine64\0Z:\\Games\\World of Warcraft\\_forever_\\Wow.exe\0"
        ));
        assert!(!process_is_wow("Wow.exe.bak\n", b"Wow.exe.bak\0"));
    }
}
