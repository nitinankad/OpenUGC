// Hide the console window on Windows in release builds (debug keeps it for logs).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod appstore;
mod caption;
mod drawn;
mod hooks;
mod metrics;
mod phone;
mod prepare;
mod r2;
mod settings;
mod slides;
mod suggest;

use appstore::{AppInfo, GemFilter};
use caption::Caption;
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
async fn generate_caption(
    hook: Option<String>,
    niche: String,
    apps: Vec<PreparedApp>,
    own_app_id: Option<u64>,
    writer: Writer,
) -> CmdResult<Caption> {
    blocking(move || {
        let hook = hook.unwrap_or_default();
        let brief = caption::CaptionBrief { hook: &hook, niche: &niche, apps: &apps, own_app_id };
        caption::generate_caption(&brief, writer)
    })
    .await
}

#[tauri::command]
async fn suggest_hooks(
    style: Option<hooks::HookStyle>,
    niche: String,
    own_app: Option<AppInfo>,
    apps: Vec<PreparedApp>,
    count: usize,
    used: Vec<String>,
    writer: Writer,
) -> CmdResult<Vec<hooks::Hook>> {
    blocking(move || {
        let brief = hooks::HookBrief { style: style.unwrap_or_default(), niche: &niche, own_app: own_app.as_ref(), apps: &apps, count, used: &used, how_many: 8 };
        hooks::suggest_hooks(&brief, writer)
    })
    .await
}

#[tauri::command]
async fn write_drawn(topic: String, points: usize, own_app: Option<AppInfo>, used: Vec<String>, writer: Writer) -> CmdResult<drawn::Script> {
    blocking(move || {
        let brief = drawn::WriteBrief { topic: &topic, points: points.clamp(3, 9), own_app: own_app.as_ref(), used: &used };
        drawn::write_script(&brief, writer)
    })
    .await
}

/// Draws one scene with Codex (image generation) or Claude (SVG) and returns the saved PNG.
#[tauri::command]
async fn draw_scene(app: AppHandle, scene: String, artist: Writer, style_ref: Option<PathBuf>) -> CmdResult<PathBuf> {
    let dir = data_dir(&app)?.join("drawings");
    blocking(move || drawn::draw(&scene, artist, style_ref.as_deref(), &dir)).await
}

#[tauri::command]
async fn render_drawn(
    app: AppHandle,
    slides: Vec<drawn::DrawnSlide>,
    accent: String,
    plug: Option<drawn::DrawnSlide>,
    plug_app: Option<AppInfo>,
    style: slides::DrawnStyle,
) -> CmdResult<RenderedSlideshow> {
    let root = data_dir(&app)?;
    let stamp = chrono::Local::now().format("%Y-%m-%d_%H%M%S").to_string();
    let dir = root.join("slideshows").join(stamp);
    blocking(move || {
        // The plug shows the app's icon; fetch it once into the shared app folder.
        let icon = match &plug_app {
            Some(a) => match appstore::hires_icon(a) {
                Some(url) => {
                    let folder = root.join("apps").join(a.track_id.to_string());
                    std::fs::create_dir_all(&folder)?;
                    let client = reqwest::blocking::Client::builder().user_agent("OpenUGC/0.1").timeout(std::time::Duration::from_secs(60)).build()?;
                    prepare::download(&client, &url, &folder.join("icon.png")).ok()
                }
                None => None,
            },
            None => None,
        };
        let plug = match (&plug, &plug_app) {
            (Some(s), Some(a)) => Some((s, slides::PlugApp { name: &a.track_name, icon: icon.as_deref() })),
            _ => None,
        };
        slides::render_drawn(&slides, &accent, plug, &style, &dir)
    })
    .await
}

#[tauri::command]
async fn generate_drawn_caption(topic: String, slides: Vec<String>, writer: Writer) -> CmdResult<Caption> {
    blocking(move || caption::generate_drawn_caption(&topic, &slides, writer)).await
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
    r2_secret: Option<String>,
    metrics_token: Option<String>,
) -> CmdResult<settings::SettingsView> {
    let dir = data_dir(&app)?;
    settings::save(&dir, &settings, r2_secret, metrics_token).map_err(|e| format!("{e:#}"))?;
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

/// Uploads the slides and a save-to-phone page to R2. Pass the earlier `folder` with
/// `images: false` to just refresh the page's caption and title.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn send_to_phone(
    app: AppHandle,
    slides: Vec<PathBuf>,
    name: String,
    account: String,
    title: String,
    caption: Caption,
    folder: Option<String>,
    images: bool,
) -> CmdResult<phone::PhonePage> {
    let s = settings::load(&data_dir(&app)?);
    blocking(move || {
        let store = r2::R2::from_settings(&s)?;
        let text = caption::post_text(&caption);
        let upload = phone::Upload {
            slides: &slides,
            name: &name,
            account: &account,
            title: &title,
            caption: &text,
            folder: folder.as_deref(),
            images,
        };
        phone::send(&store, &upload)
    })
    .await
}

#[tauri::command]
fn qr_code(text: String) -> CmdResult<String> {
    phone::qr_svg(&text).map_err(|e| format!("{e:#}"))
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
            write_drawn,
            draw_scene,
            render_drawn,
            generate_drawn_caption,
            get_settings,
            save_settings,
            export_settings,
            check_r2,
            send_to_phone,
            qr_code,
            metrics,
            load_state,
            save_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running OpenUGC");
}
