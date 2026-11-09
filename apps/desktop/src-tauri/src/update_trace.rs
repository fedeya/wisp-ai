//! Local, credential-free timings shared by the desktop app and NSIS installer.
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};

pub fn begin(data: &Path) {
    let _ = fs::create_dir_all(data.join("runtime"));
    let _ = fs::write(data.join("runtime/update.log"), "");
    append(data, "download-started");
}

pub fn append(data: &Path, stage: &str) {
    // Ordinary launches don't create a trace. Logging must never block an update
    // or prevent the app from opening if a file cannot be written.
    if let Ok(mut file) = OpenOptions::new()
        .append(true)
        .open(data.join("runtime/update.log"))
    {
        #[cfg(windows)]
        let milliseconds =
            unsafe { windows_sys::Win32::System::SystemInformation::GetTickCount64() };
        #[cfg(not(windows))]
        let milliseconds = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let _ = writeln!(file, "{milliseconds} {stage}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_launches_do_not_create_logs_and_new_updates_reset_only_the_trace() {
        let data = std::env::temp_dir().join(format!(
            "wisp-update-trace-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        append(&data, "app-opened");
        assert!(!data.exists());
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("keep.txt"), "user data").unwrap();
        begin(&data);
        append(&data, "download-verified");
        append(&data, "app-opened");
        let log = fs::read_to_string(data.join("runtime/update.log")).unwrap();
        let stages: Vec<_> = log
            .lines()
            .map(|line| line.split_once(' ').unwrap().1)
            .collect();
        assert_eq!(
            stages,
            ["download-started", "download-verified", "app-opened"]
        );
        begin(&data);
        let log = fs::read_to_string(data.join("runtime/update.log")).unwrap();
        assert_eq!(log.lines().count(), 1);
        assert_eq!(
            fs::read_to_string(data.join("keep.txt")).unwrap(),
            "user data"
        );
        assert!(data.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(data).unwrap();
    }
}
