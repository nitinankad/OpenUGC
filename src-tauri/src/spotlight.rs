//! The "app spotlight" format: a few apps (or just one), each shown on a phone on a calm desk.
//!
//! The hook and the last slide are text in a Mac window over the blurred desk. Each slide in
//! between puts one app's App Store page on the phone's screen, with a short line in a Mac window
//! above it. The writer (Claude or Codex) writes the words; desk photos are made once with
//! Codex image generation (or added by hand) and reused across posts.

use crate::prepare::{self, PreparedApp, Writer};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// What the writer returns.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Script {
    pub hook: String,
    /// Words of the hook drawn in the highlight colour ("" for none).
    pub accent: String,
    /// One line per app slide, in the apps' order.
    pub lines: Vec<String>,
    pub cta: String,
}

const WRITE_INSTRUCTIONS: &str = "\
You write a TikTok photo slideshow that spotlights a few iPhone apps (sometimes just one). It should feel like a real person sharing apps they love, not an ad.

The slides:
1. Hook: text typed in a Mac window on a calm desk. Make people curious enough to swipe. Speak from your own life or to the viewer's problem the apps solve \
(like: apps that finally got me journaling every night, or: if you keep forgetting to text people back). With one app, speak about that app; with several, about what they share. \
Don't name any app. 4 to 12 words, lowercase.
2. App slides: one per app, in the order given. Each shows that app's App Store page on a phone, with a short line in a Mac window above it. \
Say what that app lets you do or why it's nice, one specific thing. 3 to 12 words, casual, lowercase. You may name the app in its own line.
3. Last slide: text in a Mac window under the apps' icons. Tell people where to get them (like: they're all free on the app store) and add a light reason to try them or save the post. \
Under 18 words, lowercase.

Rules:
- Plain words, no hype words like game-changer, revolutionary or must-have. No emojis, hashtags or exclamation marks. Never mention prices.
- Only say things each app's description supports. Don't invent features.
- Write exactly one line per app, in the same order as the apps.
- Don't reuse a hook or line from the already-used lists, and don't reword them closely.
- accent is 1 to 3 words copied exactly from the hook, drawn in a highlight colour. Use \"\" for none.

Reply with only this JSON and nothing else:
{\"hook\": \"...\", \"accent\": \"...\", \"lines\": [\"...\", \"...\"], \"cta\": \"...\"}";

pub struct WriteBrief<'a> {
    /// The apps, one slide each, in slide order.
    pub apps: &'a [PreparedApp],
    pub used_hooks: &'a [String],
    pub used_lines: &'a [String],
}

/// Caps on how much history goes into the prompt.
const MAX_USED: usize = 120;

fn brief(b: &WriteBrief) -> String {
    // Less description each when there are more apps, so the prompt stays a sensible size.
    let room = (5000 / b.apps.len().max(1)).clamp(800, 2500);
    let mut s = String::new();
    for (i, p) in b.apps.iter().enumerate() {
        let a = &p.app;
        let about: String = a.description.chars().take(room).collect();
        s.push_str(&format!(
            "App {}: {} ({})\nShort overview: {}\nApp Store description:\n{}\n\n",
            i + 1,
            a.track_name,
            a.primary_genre_name,
            p.overview.trim(),
            about.trim()
        ));
    }
    s.push_str(&format!("Write {} app line{}, one per app, in this order.\n", b.apps.len(), if b.apps.len() == 1 { "" } else { "s" }));
    let list = |s: &mut String, title: &str, items: &[String]| {
        if items.is_empty() {
            return;
        }
        s.push_str(title);
        for t in items.iter().take(MAX_USED) {
            let t: String = t.chars().take(170).collect();
            s.push_str(&format!("- {t}\n"));
        }
    };
    list(&mut s, "Hooks this account already used:\n", b.used_hooks);
    list(&mut s, "Lines this account already used:\n", b.used_lines);
    s
}

pub fn write_script(b: &WriteBrief, writer: Writer) -> Result<Script> {
    let prompt = brief(b);
    let ask = || match writer {
        Writer::Claude => prepare::run_claude(WRITE_INSTRUCTIONS, &prompt),
        Writer::Codex => prepare::run_codex(WRITE_INSTRUCTIONS, &prompt),
    };
    let count = b.apps.len();
    // A reply that can't be read, or that's short of a line for every app, is usually a
    // one-off, so ask once more before giving up.
    let raw = ask()?;
    match parse(&raw, count) {
        Ok(s) if s.lines.len() == count => Ok(s),
        first => {
            match &first {
                Ok(s) => eprintln!("[spotlight] {} lines for {count} apps:\n{raw}", s.lines.len()),
                Err(e) => eprintln!("[spotlight] unreadable reply ({e:#}):\n{raw}"),
            }
            let raw = ask()?;
            match parse(&raw, count) {
                Ok(s) if s.lines.len() >= first.as_ref().map_or(0, |f| f.lines.len()) => Ok(s),
                Ok(_) => first,
                Err(e) => {
                    eprintln!("[spotlight] unreadable reply again ({e:#}):\n{raw}");
                    first.or(Err(e))
                }
            }
        }
    }
}

/// The first complete JSON object in the reply. Anything around it (a code fence, a note
/// after it, even braces inside the text) is ignored.
fn first_object<T: serde::de::DeserializeOwned>(raw: &str) -> Option<T> {
    raw.match_indices('{').take(8).find_map(|(i, _)| serde_json::Deserializer::from_str(&raw[i..]).into_iter::<T>().next()?.ok())
}

fn parse(raw: &str, count: usize) -> Result<Script> {
    if !raw.contains('{') {
        bail!("The writer didn't return a slideshow. Try again.");
    }
    let out: Script = first_object(raw).context("Couldn't read the slideshow the writer returned. Try again.")?;
    let clean = |s: &str| s.trim().trim_matches(|c| c == '"' || c == '“' || c == '”').trim().to_string();
    let hook = clean(&out.hook);
    let lines: Vec<String> = out.lines.iter().map(|l| clean(l)).filter(|l| !l.is_empty()).take(count).collect();
    if hook.is_empty() || lines.is_empty() {
        bail!("The writer returned an empty slideshow. Try again.");
    }
    // Only keep an accent that really is in the hook, or the slide would highlight nothing.
    let accent = clean(&out.accent);
    let accent = if !accent.is_empty() && hook.to_lowercase().contains(&accent.to_lowercase()) { accent } else { String::new() };
    Ok(Script { hook, accent, lines, cta: clean(&out.cta) })
}

// ---------------------------------------------------------------------------
// Desk photos
// ---------------------------------------------------------------------------

const DESK_PROMPT: &str = "\
Use your image generation tool to create exactly one photorealistic image, portrait orientation (1024x1536).

A calm, peaceful, minimalist desk in soft natural morning light from a nearby window. Warm neutral tones: light wood, linen, cream walls. \
A few quiet objects, slightly out of focus: a ceramic mug, a closed notebook, a small vase of dried pampas grass, the edge of a keyboard. \
No green plants and no other green objects anywhere.

In the centre of the frame, slightly below the middle, an iPhone stands upright in portrait orientation in a simple phone stand on the desk, \
facing the camera straight on, not tilted or rotated. The phone takes up about 40% of the image height, with plain wall above it. \
Its whole screen is one flat, uniform, pure chroma-key green (#00FF00) from edge to edge: no reflections, glare, icons, text, notch shadows or gradients. \
Nothing covers any part of the screen.

No people, hands, text, logos or watermarks.

Save the finished image in the current folder as drawing.png, then reply with only the word done.";

pub fn desks_dir(root: &Path) -> PathBuf {
    root.join("desks")
}

/// How a desk photo's phone screen is found.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScreenSource {
    /// Found automatically: the screen is chroma green.
    Green,
    /// Its four corners were clicked by hand.
    Marked,
    /// Not found yet; needs marking.
    None,
}

/// What's known about a desk photo's screen, kept next to it as `<photo>.screen.json`
/// so it's only worked out (or marked) once.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeskScreen {
    pub source: ScreenSource,
    /// Corners TL, TR, BR, BL in the photo's own pixels.
    #[serde(default)]
    pub quad: Option<[[f32; 2]; 4]>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeskInfo {
    pub path: PathBuf,
    pub screen: DeskScreen,
    /// The photo's size, for marking corners on a scaled-down preview.
    pub width: u32,
    pub height: u32,
}

const PHOTO_EXTS: [&str; 3] = ["png", "jpg", "jpeg"];

fn is_photo(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()).is_some_and(|e| PHOTO_EXTS.contains(&e.to_ascii_lowercase().as_str()))
}

fn sidecar(photo: &Path) -> PathBuf {
    let mut s = photo.as_os_str().to_owned();
    s.push(".screen.json");
    PathBuf::from(s)
}

/// The screen of a desk photo: from its sidecar, or detected now (and remembered).
pub fn desk_screen(photo: &Path) -> Result<(DeskScreen, u32, u32)> {
    let (w, h) = image::image_dimensions(photo).with_context(|| format!("Couldn't open {}", photo.display()))?;
    if let Some(s) = std::fs::read(sidecar(photo)).ok().and_then(|b| serde_json::from_slice::<DeskScreen>(&b).ok()) {
        return Ok((s, w, h));
    }
    let img = image::open(photo).with_context(|| format!("Couldn't open {}", photo.display()))?.to_rgb8();
    let s = match crate::slides::find_screen_scaled(&img) {
        Some((quad, _)) => DeskScreen { source: ScreenSource::Green, quad: Some(quad.map(|(x, y)| [x, y])) },
        None => DeskScreen { source: ScreenSource::None, quad: None },
    };
    let _ = std::fs::write(sidecar(photo), serde_json::to_vec(&s)?);
    Ok((s, w, h))
}

/// Hand-marked corners for a photo, if it has them (they take priority over green detection).
pub fn marked_quad(photo: &Path) -> Option<[(f32, f32); 4]> {
    let s: DeskScreen = serde_json::from_slice(&std::fs::read(sidecar(photo)).ok()?).ok()?;
    match (s.source, s.quad) {
        (ScreenSource::Marked, Some(q)) => Some(q.map(|[x, y]| (x, y))),
        _ => None,
    }
}

/// Saves four clicked corners (in any order) as the photo's screen, or with `None` forgets
/// them and goes back to automatic detection.
pub fn set_screen(photo: &Path, corners: Option<[[f32; 2]; 4]>) -> Result<DeskScreen> {
    let _ = std::fs::remove_file(sidecar(photo));
    let Some(c) = corners else {
        return Ok(desk_screen(photo)?.0);
    };
    let s = DeskScreen { source: ScreenSource::Marked, quad: Some(order_corners(c)) };
    std::fs::write(sidecar(photo), serde_json::to_vec(&s)?)?;
    Ok(s)
}

/// Sorts corners clockwise starting from the top-left one.
fn order_corners(c: [[f32; 2]; 4]) -> [[f32; 2]; 4] {
    let (cx, cy) = (c.iter().map(|p| p[0]).sum::<f32>() / 4.0, c.iter().map(|p| p[1]).sum::<f32>() / 4.0);
    let mut v = c.to_vec();
    v.sort_by(|a, b| (a[1] - cy).atan2(a[0] - cx).total_cmp(&(b[1] - cy).atan2(b[0] - cx)));
    let tl = (0..4).min_by(|&i, &j| (v[i][0] + v[i][1]).total_cmp(&(v[j][0] + v[j][1]))).unwrap();
    v.rotate_left(tl);
    [v[0], v[1], v[2], v[3]]
}

/// Desk photos in the folder, newest first.
pub fn list_desks(root: &Path) -> Vec<DeskInfo> {
    let mut found: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(desks_dir(root))
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| is_photo(p))
        .map(|p| (std::fs::metadata(&p).and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH), p))
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found
        .into_iter()
        .filter_map(|(_, path)| desk_screen(&path).ok().map(|(screen, width, height)| DeskInfo { path, screen, width, height }))
        .collect()
}

/// Copies photos (e.g. dropped onto the window) into the desks folder. Returns the new paths.
pub fn add_desks(root: &Path, photos: &[PathBuf]) -> Result<Vec<PathBuf>> {
    copy_images(&desks_dir(root), "desk", photos)
}

/// Copies your own screenshots into the app's data folder, so slides keep working after the
/// originals move. Returns the new paths, in the order given.
pub fn add_screenshots(root: &Path, shots: &[PathBuf]) -> Result<Vec<PathBuf>> {
    copy_images(&root.join("screenshots"), "shot", shots)
}

/// Saves an uploaded screenshot (its file's bytes, from the file picker) into the data folder.
pub fn save_screenshot(root: &Path, bytes: &[u8]) -> Result<PathBuf> {
    let reader = image::ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format()?;
    let ext = match reader.format() {
        Some(image::ImageFormat::Png) => "png",
        Some(image::ImageFormat::Jpeg) => "jpg",
        _ => bail!("Use a PNG or JPEG screenshot."),
    };
    reader.into_dimensions().context("That screenshot couldn't be opened.")?;
    let dir = root.join("screenshots");
    std::fs::create_dir_all(&dir)?;
    static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let path = dir.join(format!("shot-{}-u{n}.{ext}", chrono::Local::now().format("%Y%m%d-%H%M%S%3f")));
    std::fs::write(&path, bytes).with_context(|| format!("Couldn't save the screenshot to {}", path.display()))?;
    Ok(path)
}

fn copy_images(dir: &Path, prefix: &str, images: &[PathBuf]) -> Result<Vec<PathBuf>> {
    std::fs::create_dir_all(dir)?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S%3f");
    let mut out = Vec::new();
    for (i, src) in images.iter().enumerate() {
        if !is_photo(src) {
            continue;
        }
        image::image_dimensions(src).with_context(|| format!("{} isn't an image that can be opened", src.display()))?;
        let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("jpg").to_ascii_lowercase();
        let path = dir.join(format!("{prefix}-{stamp}-{i}.{ext}"));
        std::fs::copy(src, &path).with_context(|| format!("Couldn't copy {}", src.display()))?;
        out.push(path);
    }
    if out.is_empty() {
        bail!("Drop PNG or JPEG images.");
    }
    Ok(out)
}

/// Generates a new desk photo with Codex and keeps it only if its green screen can be found.
pub fn make_desk(root: &Path) -> Result<PathBuf> {
    let img = crate::drawn::codex_image(DESK_PROMPT, &[])?.to_rgb8();
    if crate::slides::find_screen_scaled(&img).is_none() {
        bail!("Codex made a desk photo, but the phone screen in it wasn't clean green, so it can't hold the app. Try again.");
    }
    let dir = desks_dir(root);
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("desk-{}.png", chrono::Local::now().format("%Y%m%d-%H%M%S")));
    img.save(&path).with_context(|| format!("Couldn't save the desk photo to {}", path.display()))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_script_and_drops_a_missing_accent() {
        let raw = "```json\n{\"hook\": \" the app that got me journaling \", \"accent\": \"nope\", \"lines\": [\"one\", \"\", \"two\", \"three\"], \"cta\": \"search it\"}\n```";
        let s = parse(raw, 2).unwrap();
        assert_eq!(s.hook, "the app that got me journaling");
        assert_eq!(s.accent, "");
        assert_eq!(s.lines, vec!["one", "two"]);
        assert_eq!(s.cta, "search it");
        assert!(parse("{\"hook\": \"\", \"lines\": [\"x\"]}", 3).is_err());
        // Trailing text with a stray brace, and braces inside the strings themselves.
        let raw = "{\"hook\": \"apps {that} help\", \"lines\": [\"one}\"], \"cta\": \"x\"}\nnote: used {name} }";
        let s = parse(raw, 3).unwrap();
        assert_eq!((s.hook.as_str(), s.lines[0].as_str()), ("apps {that} help", "one}"));
    }

    /// Prints the raw reply for the first prepared app with screenshots:
    /// `cargo test spotlight_raw_live -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn spotlight_raw_live() {
        let appdata = std::env::var("APPDATA").unwrap();
        let state: serde_json::Value = serde_json::from_slice(&std::fs::read(Path::new(&appdata).join("com.openugc.OpenUGC/state.json")).unwrap()).unwrap();
        let apps: Vec<PreparedApp> = serde_json::from_value(state["prepared"].clone()).unwrap();
        let picked: Vec<PreparedApp> = apps.iter().filter(|a| a.screenshots.len() >= 3).take(3).cloned().collect();
        let b = WriteBrief { apps: &picked, used_hooks: &[], used_lines: &[] };
        let raw = match std::env::var("OPENUGC_WRITER").as_deref() {
            Ok("codex") => prepare::run_codex(WRITE_INSTRUCTIONS, &brief(&b)).unwrap(),
            _ => prepare::run_claude(WRITE_INSTRUCTIONS, &brief(&b)).unwrap(),
        };
        println!("RAW<<{raw}>>");
        println!("PARSED {:?}", parse(&raw, picked.len()));
    }

    #[test]
    fn saves_uploaded_png_and_rejects_other_bytes() {
        let root = std::env::temp_dir().join("openugc-upload-test");
        let mut png = Vec::new();
        image::RgbImage::from_pixel(4, 8, image::Rgb([1, 2, 3])).write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
        let path = save_screenshot(&root, &png).unwrap();
        assert_eq!(path.extension().unwrap(), "png");
        assert_eq!(image::image_dimensions(&path).unwrap(), (4, 8));
        assert!(save_screenshot(&root, b"not an image").is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn corners_are_ordered_clockwise_from_top_left() {
        let got = order_corners([[610.0, 1190.0], [400.0, 700.0], [390.0, 1200.0], [640.0, 680.0]]);
        assert_eq!(got, [[400.0, 700.0], [640.0, 680.0], [610.0, 1190.0], [390.0, 1200.0]]);
    }
}
