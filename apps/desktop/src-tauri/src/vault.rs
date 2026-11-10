use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Read, Write},
    path::PathBuf,
};

pub fn data_dir() -> Result<PathBuf, String> {
    std::env::var_os("WISP_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs::data_dir().map(|p| p.join("com.wisp.ai")))
        .ok_or_else(|| "Cannot find the application data directory".into())
}

pub fn run(args: &[String]) -> Result<(), String> {
    if args.len() != 4 || args[1] != "--secret" {
        return Err("Invalid secret operation".into());
    }
    let key = &args[3];
    if key.len() > 500 {
        return Err("Invalid secret key".into());
    }
    let mut input = Vec::new();
    if args[2] == "write" {
        io::stdin()
            .take(1024 * 1024 + 1)
            .read_to_end(&mut input)
            .map_err(|_| "Cannot read secret")?;
        if input.len() > 1024 * 1024 {
            return Err("Secret is too large".into());
        }
    }
    let output = platform(&args[2], key, &input)?;
    io::stdout()
        .write_all(&output)
        .map_err(|_| "Cannot return secret".into())
}
pub fn self_test() -> Result<(), String> {
    let key = format!("wisp-self-test-{}", std::process::id());
    let sample = "private-é-测试".as_bytes();
    platform("write", &key, b"previous")?;
    platform("write", &key, sample)?;
    let result = platform("read", &key, &[]);
    platform("write", &key, &[])?;
    if result? != sample {
        return Err("Credential round-trip failed".into());
    }
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn protected_credentials_round_trip() {
        super::self_test().unwrap();
    }
}

#[cfg(windows)]
fn platform(operation: &str, key: &str, input: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };
    let folder = data_dir()?.join("secrets");
    fs::create_dir_all(&folder).map_err(|_| "Cannot create secret store")?;
    let file = folder.join(format!("{:x}.bin", Sha256::digest(key.as_bytes())));
    let raw = if operation == "read" {
        match fs::read(&file) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(vec![]),
            Err(_) => return Err("Cannot read secret store".into()),
        }
    } else if operation == "write" {
        if input.is_empty() {
            if file.exists() {
                fs::remove_file(&file).map_err(|_| "Cannot remove secret")?;
            }
            return Ok(vec![]);
        }
        input.to_vec()
    } else {
        return Err("Invalid secret operation".into());
    };
    let source = CRYPT_INTEGER_BLOB {
        cbData: raw.len() as u32,
        pbData: raw.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        if operation == "read" {
            CryptUnprotectData(
                &source,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptProtectData(
                &source,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err("Windows could not protect or unlock this secret".into());
    }
    let bytes = unsafe {
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as _);
        bytes
    };
    if operation == "write" {
        let temporary = file.with_extension(format!("{}.tmp", std::process::id()));
        fs::write(&temporary, bytes).map_err(|_| "Cannot write secret")?;
        fs::rename(temporary, file).map_err(|_| "Cannot commit secret")?;
        Ok(vec![])
    } else {
        Ok(bytes)
    }
}

#[cfg(target_os = "macos")]
fn platform(operation: &str, key: &str, input: &[u8]) -> Result<Vec<u8>, String> {
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };
    let directory = data_dir()?;
    // Existing application profiles keep their original Keychain service.
    let development = std::env::var_os("WISP_DEV_INSTANCE").is_some()
        || std::env::var_os("WISP_SHARED_DATA_DIR").is_some();
    let service = if development {
        format!(
            "com.wisp.ai.{:x}",
            Sha256::digest(directory.to_string_lossy().as_bytes())
        )
    } else {
        "com.wisp.ai".into()
    };
    match operation {
        "read" => match get_generic_password(&service, key) {
            Ok(v) => Ok(v),
            Err(e) if e.code() == -25300 => Ok(vec![]),
            Err(_) => Err("Cannot unlock Keychain".into()),
        },
        "write" if input.is_empty() => {
            match delete_generic_password(&service, key) {
                Ok(_) => {}
                Err(e) if e.code() == -25300 => {}
                Err(_) => return Err("Cannot remove Keychain secret".into()),
            }
            Ok(vec![])
        }
        "write" => {
            set_generic_password(&service, key, input)
                .map_err(|_| "Cannot save Keychain secret")?;
            Ok(vec![])
        }
        _ => Err("Invalid secret operation".into()),
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
fn platform(_: &str, _: &str, _: &[u8]) -> Result<Vec<u8>, String> {
    Err("Credential storage is not available on this platform yet".into())
}
