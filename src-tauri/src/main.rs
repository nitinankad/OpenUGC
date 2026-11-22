// Hide the console window on Windows in release builds (debug keeps it for logs).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod appstore;
mod prepare;
mod slides;

use appstore::{AppInfo, GemFilter};
use prepare::{PreparedApp, Writer};
use slides::{RenderedSlideshow, SlideOptions};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

type CmdResult<T> = Result<T, String>;

fn data_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Run blocking work (HTTP, the claude CLI) off the async runtime.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn search_gems(niche: String, filter: GemFilter) -> CmdResult<Vec<AppInfo>> {
    blocking(move || appstore::find_hidden_gems(&niche, &filter)).await
}

#[tauri::command]
async fn find_app(query: String, country: String) -> CmdResult<Vec<AppInfo>> {
    blocking(move || appstore::find_app(&query, &country)).await
}

#[tauri::command]
async fn prepare_app(app: AppHandle, info: AppInfo, writer: Writer) -> CmdResult<PreparedApp> {
    let root = data_dir(&app)?;
    blocking(move || prepare::prepare(&info, &root, writer)).await
}

#[tauri::command]
async fn rewrite_overview(info: AppInfo, writer: Writer) -> CmdResult<String> {
    blocking(move || prepare::generate_overview(&info, writer)).await
}

#[tauri::command]
async fn render_slides(app: AppHandle, apps: Vec<PreparedApp>, options: SlideOptions) -> CmdResult<RenderedSlideshow> {
    let stamp = chrono::Local::now().format("%Y-%m-%d_%H%M%S").to_string();
    let dir = data_dir(&app)?.join("slideshows").join(stamp);
    blocking(move || slides::render_slideshow(&apps, &options, &dir)).await
}

#[tauri::command]
fn load_state(app: AppHandle) -> CmdResult<serde_json::Value> {
    let path = data_dir(&app)?.join("state.json");
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
        Err(_) => Ok(serde_json::Value::Null),
    }
}

#[tauri::command]
fn save_state(app: AppHandle, state: serde_json::Value) -> CmdResult<()> {
    let dir = data_dir(&app)?;
    let tmp = dir.join("state.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(&state).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join("state.json")).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            search_gems,
            find_app,
            prepare_app,
            rewrite_overview,
            render_slides,
            load_state,
            save_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running OpenUGC");
}
