//! App settings. Plain values live in settings.json; API keys live in the OS keychain
//! (Windows Credential Manager / macOS Keychain) and are never sent back to the UI.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

const KEYCHAIN_SERVICE: &str = "com.openugc.OpenUGC";
const BUFFER_KEY: &str = "buffer-api-key";
const R2_SECRET: &str = "r2-secret-access-key";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub r2_account_id: String,
    pub r2_access_key_id: String,
    pub r2_bucket: String,
    /// Public base URL for the bucket, e.g. https://pub-xxxx.r2.dev or a custom domain.
    pub r2_public_url: String,
}

/// What the UI sees: the plain settings plus whether each secret is stored.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    #[serde(flatten)]
    pub settings: Settings,
    pub has_buffer_key: bool,
    pub has_r2_secret: bool,
}

pub fn load(dir: &Path) -> Settings {
    std::fs::read(dir.join("settings.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

pub fn view(dir: &Path) -> SettingsView {
    SettingsView {
        settings: load(dir),
        has_buffer_key: secret(BUFFER_KEY).is_some(),
        has_r2_secret: secret(R2_SECRET).is_some(),
    }
}

/// Saves plain settings. For each secret: None leaves it alone, "" deletes it, anything else replaces it.
pub fn save(dir: &Path, s: &Settings, buffer_key: Option<String>, r2_secret: Option<String>) -> Result<()> {
    let clean = Settings {
        r2_account_id: s.r2_account_id.trim().to_string(),
        r2_access_key_id: s.r2_access_key_id.trim().to_string(),
        r2_bucket: s.r2_bucket.trim().to_string(),
        r2_public_url: s.r2_public_url.trim().trim_end_matches('/').to_string(),
    };
    let tmp = dir.join("settings.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&clean)?)?;
    std::fs::rename(&tmp, dir.join("settings.json"))?;
    if let Some(v) = buffer_key {
        set_secret(BUFFER_KEY, v.trim())?;
    }
    if let Some(v) = r2_secret {
        set_secret(R2_SECRET, v.trim())?;
    }
    Ok(())
}

/// Everything needed to set up another computer, keys included.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Export {
    pub settings: Settings,
    pub buffer_key: String,
    pub r2_secret: String,
}

pub fn export(dir: &Path) -> Export {
    Export {
        settings: load(dir),
        buffer_key: secret(BUFFER_KEY).unwrap_or_default(),
        r2_secret: secret(R2_SECRET).unwrap_or_default(),
    }
}

pub fn buffer_key() -> Result<String> {
    secret(BUFFER_KEY).context("Add your Buffer API key in Settings first")
}

pub fn r2_secret() -> Result<String> {
    secret(R2_SECRET).context("Add your R2 secret access key in Settings first")
}

fn entry(name: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, name).context("Couldn't open the system keychain")
}

fn secret(name: &str) -> Option<String> {
    entry(name).ok()?.get_password().ok().filter(|s| !s.is_empty())
}

fn set_secret(name: &str, value: &str) -> Result<()> {
    let e = entry(name)?;
    if value.is_empty() {
        match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err).context("Couldn't remove the key from the system keychain"),
        }
    } else {
        e.set_password(value).context("Couldn't save the key to the system keychain")
    }
}
