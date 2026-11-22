//! Talks to the OpenUGC metrics Worker (see backend/). The API token stays here in Rust;
//! the UI only names the method and path.

use anyhow::{bail, Context, Result};
use serde_json::Value;

const METHODS: [&str; 4] = ["GET", "POST", "PUT", "DELETE"];

pub fn request(base: &str, token: &str, method: &str, path: &str, body: Option<Value>) -> Result<Value> {
    let base = base.trim().trim_end_matches('/');
    if base.is_empty() {
        bail!("Add your analytics Worker URL in Settings first");
    }
    if !base.starts_with("https://") && !base.starts_with("http://localhost") && !base.starts_with("http://127.0.0.1") {
        bail!("The analytics Worker URL should start with https://");
    }
    if !METHODS.contains(&method) || !path.starts_with('/') || path.contains("://") {
        bail!("Bad analytics request: {method} {path}");
    }
    let client = reqwest::blocking::Client::builder()
        .user_agent("OpenUGC/0.1")
        .timeout(std::time::Duration::from_secs(60))
        .build()?;
    let mut req = client
        .request(method.parse()?, format!("{base}{path}"))
        .bearer_auth(token);
    if let Some(b) = body {
        req = req.json(&b);
    }
    let res = req.send().context("Couldn't reach the analytics Worker. Check its URL in Settings")?;
    let status = res.status();
    let text = res.text().unwrap_or_default();
    let json: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    match status.as_u16() {
        200..=299 => Ok(json),
        // "A scrape is already in progress" and similar: not an error for the UI.
        409 => Ok(json),
        401 => bail!("The analytics Worker didn't accept the API token. It must match the API_TOKEN secret on the Worker"),
        404 if json.is_null() => bail!("Nothing at {base}. Check the analytics Worker URL in Settings"),
        code => {
            let msg = json.get("error").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| text.chars().take(200).collect());
            bail!("The analytics Worker said {code}: {msg}")
        }
    }
}
