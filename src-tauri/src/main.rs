// Hide the console window on Windows in release builds (debug keeps it for logs).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod appstore;
mod buffer;
mod caption;
mod hooks;
mod metrics;
mod prepare;
mod r2;
mod settings;
mod slides;
mod suggest;

use appstore::{AppInfo, GemFilter};
use caption::Caption;
use prepare::{PreparedApp, Writer};
use serde::Serialize;
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
async fn suggest_apps(
    niche: String,
    hook: String,
    count: usize,
    exclude: Vec<String>,
    filter: GemFilter,
    writer: Writer,
) -> CmdResult<suggest::SuggestResult> {
    blocking(move || suggest::suggest_apps(&niche, &hook, count.clamp(4, 30), &exclude, &filter, writer)).await
}

#[tauri::command]
async fn lookup_links(links: String, filter: GemFilter) -> CmdResult<appstore::LinkLookup> {
    blocking(move || appstore::lookup_links(&links, &filter)).await
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
async fn generate_caption(niche: String, apps: Vec<PreparedApp>, writer: Writer) -> CmdResult<Caption> {
    blocking(move || caption::generate_caption(&niche, &apps, writer)).await
}

#[tauri::command]
async fn suggest_hooks(
    niche: String,
    own_app: Option<AppInfo>,
    apps: Vec<PreparedApp>,
    count: usize,
    used: Vec<String>,
    writer: Writer,
) -> CmdResult<Vec<hooks::Hook>> {
    blocking(move || {
        let brief = hooks::HookBrief { niche: &niche, own_app: own_app.as_ref(), apps: &apps, count, used: &used, how_many: 8 };
        hooks::suggest_hooks(&brief, writer)
    })
    .await
}

#[tauri::command]
fn get_settings(app: AppHandle) -> CmdResult<settings::SettingsView> {
    Ok(settings::view(&data_dir(&app)?))
}

/// For each key: leave it out to keep the stored one, send "" to remove it.
#[tauri::command]
fn save_settings(
    app: AppHandle,
    settings: settings::Settings,
    buffer_key: Option<String>,
    r2_secret: Option<String>,
    metrics_token: Option<String>,
) -> CmdResult<settings::SettingsView> {
    let dir = data_dir(&app)?;
    settings::save(&dir, &settings, buffer_key, r2_secret, metrics_token).map_err(|e| format!("{e:#}"))?;
    Ok(settings::view(&dir))
}

/// Settings plus keys, for moving to another computer (the UI turns it into a paste-able code).
#[tauri::command]
fn export_settings(app: AppHandle) -> CmdResult<settings::Export> {
    Ok(settings::export(&data_dir(&app)?))
}

#[tauri::command]
async fn check_r2(app: AppHandle) -> CmdResult<String> {
    let s = settings::load(&data_dir(&app)?);
    blocking(move || r2::R2::from_settings(&s)?.check()).await
}

#[tauri::command]
async fn buffer_channels() -> CmdResult<Vec<buffer::Channel>> {
    blocking(|| buffer::channels(&settings::buffer_key()?)).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Scheduled {
    post: buffer::BufferPost,
    image_urls: Vec<String>,
}

/// Uploads the slides to R2, then creates a Buffer reminder post for `due_at` (ISO 8601, UTC).
#[tauri::command]
async fn schedule_post(
    app: AppHandle,
    slides: Vec<PathBuf>,
    channel_id: String,
    caption: Caption,
    title: String,
    due_at: String,
) -> CmdResult<Scheduled> {
    let s = settings::load(&data_dir(&app)?);
    blocking(move || {
        let key = settings::buffer_key()?;
        let store = r2::R2::from_settings(&s)?;
        let mut image_urls = Vec::new();
        for path in &slides {
            let folder = path.parent().and_then(|p| p.file_name()).and_then(|n| n.to_str()).unwrap_or("slides");
            let file = path.file_name().and_then(|n| n.to_str()).unwrap_or("slide.jpg");
            let safe = |s: &str| s.chars().map(|c| if c.is_ascii_alphanumeric() || "-_.".contains(c) { c } else { '-' }).collect::<String>();
            // TikTok caps photos at ~2 MP, so upload a 1080-wide copy of each slide.
            let bytes = slides::tiktok_jpeg(path)?;
            image_urls.push(store.upload_bytes(&format!("openugc/{}/tiktok-{}", safe(folder), safe(file)), bytes, "image/jpeg")?);
        }
        let text = caption::post_text(&caption);
        let post = buffer::create_post(
            &key,
            &buffer::NewPost { channel_id: &channel_id, text: &text, title: &title, image_urls: &image_urls, due_at: &due_at },
        )?;
        Ok(Scheduled { post, image_urls })
    })
    .await
}

#[tauri::command]
async fn refresh_post(id: String) -> CmdResult<buffer::BufferPost> {
    blocking(move || buffer::get_post(&settings::buffer_key()?, &id)).await
}

/// A request to the analytics Worker, e.g. ("GET", "/videos?username=x", None).
#[tauri::command]
async fn metrics(app: AppHandle, method: String, path: String, body: Option<serde_json::Value>) -> CmdResult<serde_json::Value> {
    let url = settings::load(&data_dir(&app)?).metrics_url;
    blocking(move || metrics::request(&url, &settings::metrics_token()?, &method, &path, body)).await
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
            lookup_links,
            suggest_apps,
            prepare_app,
            rewrite_overview,
            render_slides,
            generate_caption,
            suggest_hooks,
            get_settings,
            save_settings,
            export_settings,
            check_r2,
            buffer_channels,
            schedule_post,
            refresh_post,
            metrics,
            load_state,
            save_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running OpenUGC");
}
