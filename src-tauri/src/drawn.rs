//! The "relatable drawings" format: one short line of text above a black-ink stick-figure
//! drawing on every slide, ending with a plug for the account's app.
//!
//! The local Claude or Codex CLI writes the script. Drawings come from Codex's built-in image
//! generation, or from Claude as SVG (it can't make images) rasterised with resvg. Either way
//! the drawing is cleaned to grey ink on white and cropped to the ink, so slides can lay it out
//! and blend it onto any background colour.

use crate::appstore::AppInfo;
use crate::prepare::{self, Writer};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// One slide: its line of text and what its drawing shows.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DrawnSlide {
    pub text: String,
    pub scene: String,
    /// The finished drawing (grey ink on white PNG), once drawn.
    pub image: Option<PathBuf>,
}

/// What the writer returns. `slides[0]` is the hook.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Script {
    pub slides: Vec<DrawnSlide>,
    /// Words of the hook drawn in the highlight colour ("" for none).
    pub accent: String,
    pub plug: Option<DrawnSlide>,
}

const WRITE_INSTRUCTIONS: &str = "\
You write TikTok photo slideshows for a relatable mental-health and adult-life account. Every slide is one short line of text above a simple black-and-white stick-figure drawing. Viewers should think \"this is literally me\" and save or send it to a friend.

The slideshow:
1. Hook: the title slide, like \"Hidden signs of loneliness\", \"5 signs of high functioning depression\", \"Things you do when you have no close friends\". At most 60 characters. If it has a number, it must equal the number of points.
2. Points: specific, relatable signs, habits or feelings about the topic, one per slide. Write them in second person (\"You feel like no one really knows you\") or as a gerund (\"Feeling like a burden when reaching out first\"). 25 to 120 characters each. Concrete everyday moments, not clinical definitions. Vary how they start. No numbering.
3. Plug (only when the account has an app): the last slide recommends the account's app like a friend would: name the app and say how it helps with this exact topic, in one or two sentences, at most 170 characters. Only claim what the app's description supports. No hype words, no \"link in bio\", no prices.

Rules for all text: sentence case, plain words, no emojis, no hashtags, no quotes, no exclamation marks. Stay on everyday struggles like loneliness, friendships, burnout, overthinking and self-worth. Never mention self-harm, suicide, eating disorders, medication or diagnosis.

Accent: one to three words of the hook that name the topic (like \"loneliness\"). They are drawn in red, and must appear in the hook exactly as written.

Scene: for every slide, describe its drawing in one sentence of 8 to 25 words: one simple moment with one or two stick figures and at most two props, with a pose or expression that shows the feeling. No words, letters or numbers in the scene. For the plug, show someone calmer or connecting with others while using their phone.

Don't reuse any hook from the already-used list.

Reply with only this JSON and nothing else:
{\"hook\": {\"text\": \"...\", \"scene\": \"...\"}, \"accent\": \"...\", \"points\": [{\"text\": \"...\", \"scene\": \"...\"}], \"plug\": {\"text\": \"...\", \"scene\": \"...\"}}
Set \"plug\" to null when the account has no app.";

pub struct WriteBrief<'a> {
    pub topic: &'a str,
    pub points: usize,
    pub own_app: Option<&'a AppInfo>,
    pub used: &'a [String],
}

fn brief(b: &WriteBrief) -> String {
    let mut s = format!("Topic: {}\nNumber of points: {}\n", b.topic.trim(), b.points);
    match b.own_app {
        Some(a) => {
            let about: String = a.description.chars().take(1500).collect();
            s.push_str(&format!("The account's app: {} ({}). App Store description:\n{}\n", a.track_name, a.primary_genre_name, about));
        }
        None => s.push_str("The account has no app, so set plug to null.\n"),
    }
    if !b.used.is_empty() {
        s.push_str(&format!("Already-used hooks: {}\n", b.used.join("; ")));
    }
    s
}

pub fn write_script(b: &WriteBrief, writer: Writer) -> Result<Script> {
    if b.topic.trim().is_empty() {
        bail!("Enter a topic first, like adult friendships or burnout.");
    }
    let prompt = brief(b);
    let raw = match writer {
        Writer::Claude => prepare::run_claude(WRITE_INSTRUCTIONS, &prompt)?,
        Writer::Codex => prepare::run_codex(WRITE_INSTRUCTIONS, &prompt)?,
    };
    let mut script = parse_script(&raw)?;
    if b.own_app.is_none() {
        script.plug = None;
    }
    Ok(script)
}

fn parse_script(raw: &str) -> Result<Script> {
    #[derive(Deserialize)]
    struct Part {
        #[serde(default)]
        text: String,
        #[serde(default)]
        scene: String,
    }
    #[derive(Deserialize)]
    struct Out {
        hook: Part,
        #[serde(default)]
        accent: String,
        #[serde(default)]
        points: Vec<Part>,
        #[serde(default)]
        plug: Option<Part>,
    }
    let json = match (raw.find('{'), raw.rfind('}')) {
        (Some(a), Some(b)) if a < b => &raw[a..=b],
        _ => bail!("The writer didn't return a slideshow. Try again."),
    };
    let out: Out = serde_json::from_str(json).context("Couldn't read the slideshow the writer returned")?;
    let clean = |s: &str| s.trim().trim_matches(|c| c == '"' || c == '“' || c == '”').trim().to_string();
    let slide = |p: &Part| DrawnSlide { text: clean(&p.text), scene: clean(&p.scene), image: None };
    let mut slides = vec![slide(&out.hook)];
    slides.extend(out.points.iter().map(slide).filter(|s| !s.text.is_empty()));
    if slides[0].text.is_empty() || slides.len() < 2 {
        bail!("The writer returned an empty slideshow. Try again.");
    }
    // Only keep an accent that really is in the hook, or the slide would highlight nothing.
    let accent = clean(&out.accent);
    let accent = if !accent.is_empty() && slides[0].text.to_lowercase().contains(&accent.to_lowercase()) { accent } else { String::new() };
    let plug = out.plug.as_ref().map(slide).filter(|p| !p.text.is_empty());
    Ok(Script { slides, accent, plug })
}

// ---------------------------------------------------------------------------
// Drawings
// ---------------------------------------------------------------------------

const STYLE: &str = "\
Minimalist hand-drawn cartoon in black ink on a plain pure white background, like a quick pen sketch: \
thin, slightly wobbly black outlines; simple stick-figure people with big round heads, dot eyes, small expressive eyebrows and mouths, \
and single-line arms and legs; minimal simple props. No colour, no grey shading, no fills, no shadows, no background scenery, \
no frame, and no text, letters or numbers anywhere. One single centred scene with plenty of white space around it.";

const SVG_INSTRUCTIONS: &str = "\
You draw illustrations for TikTok slides as SVG code.

Style: minimalist hand-drawn black-ink stick-figure cartoon, like a quick pen sketch. Big round heads, dot eyes, small expressive eyebrows and mouths, \
single-line arms and legs, minimal simple props. Make the pose and face clearly show the feeling. Lines slightly wobbly, like a pen.

Technical rules:
- One <svg> element with xmlns=\"http://www.w3.org/2000/svg\" and viewBox=\"0 0 800 800\".
- A white background rect, then black strokes only: stroke=\"#111\", stroke-width between 4 and 6, stroke-linecap and stroke-linejoin round, fill=\"none\". Eyes may be small filled black circles.
- Only path, line, polyline, circle, ellipse, rect and g elements. No text, images, gradients, filters, scripts, styles or links.
- Keep the drawing centred with margin around it.

Reply with only the SVG code.";

/// Draws `scene` and saves it as a cleaned PNG in `out_dir`. `style_ref` is an earlier drawing
/// from the same post, so the whole slideshow keeps one line style.
pub fn draw(scene: &str, artist: Writer, style_ref: Option<&Path>, out_dir: &Path) -> Result<PathBuf> {
    if scene.trim().is_empty() {
        bail!("Describe what the drawing should show first.");
    }
    std::fs::create_dir_all(out_dir)?;
    let img = match artist {
        Writer::Codex => draw_with_codex(scene, style_ref)?,
        Writer::Claude => draw_with_claude(scene)?,
    };
    let clean = clean_drawing(&img).context("The drawing came back blank. Try drawing it again.")?;
    static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let path = out_dir.join(format!("{}-{n}.png", chrono::Local::now().format("%Y%m%d-%H%M%S%3f")));
    clean.save(&path).with_context(|| format!("Couldn't save the drawing to {}", path.display()))?;
    Ok(path)
}

fn draw_with_codex(scene: &str, style_ref: Option<&Path>) -> Result<image::DynamicImage> {
    static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("openugc-draw-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    let has_ref = style_ref.is_some_and(|p| std::fs::copy(p, dir.join("style.png")).is_ok());

    let mut prompt = format!(
        "Use your image generation tool to create exactly one image.\n\nStyle: {STYLE}\n\nScene: {}\n\n",
        scene.trim()
    );
    if has_ref {
        prompt.push_str("style.png in this folder is another drawing from the same slideshow. Match its line weight and drawing style exactly, but draw the new scene, not its content.\n\n");
    }
    prompt.push_str("Save the finished image in the current folder as drawing.png, then reply with only the word done.");

    let started = SystemTime::now();
    let args = [
        "exec",
        "--skip-git-repo-check",
        "--sandbox", "workspace-write",
        "--ephemeral",
        "--color", "never",
        "-c", "model_reasoning_effort=low",
        "-",
    ];
    let result = prepare::run_cli("codex", &args, &prompt, Some(&dir)).and_then(|_| {
        let saved = dir.join("drawing.png");
        let path = if saved.exists() { saved } else { newest_codex_image(started).context("Codex didn't make an image. Check that `codex` is logged in and image generation is on (codex features list).")? };
        image::open(&path).with_context(|| format!("Couldn't open the drawing at {}", path.display()))
    });
    let _ = std::fs::remove_dir_all(&dir);
    result
}

/// Codex keeps every generated image in ~/.codex/generated_images; used when it didn't copy the file.
fn newest_codex_image(since: SystemTime) -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    let root = PathBuf::from(home).join(".codex").join("generated_images");
    let mut best: Option<(SystemTime, PathBuf)> = None;
    let mut stack = vec![root];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).ok()?.flatten() {
            let p = e.path();
            let Ok(meta) = e.metadata() else { continue };
            if meta.is_dir() {
                stack.push(p);
            } else if let Ok(t) = meta.modified() {
                if t >= since && best.as_ref().is_none_or(|(bt, _)| t > *bt) {
                    best = Some((t, p));
                }
            }
        }
    }
    best.map(|(_, p)| p)
}

fn draw_with_claude(scene: &str) -> Result<image::DynamicImage> {
    let raw = prepare::run_claude(SVG_INSTRUCTIONS, &format!("Scene: {}", scene.trim()))?;
    let svg = match (raw.find("<svg"), raw.rfind("</svg>")) {
        (Some(a), Some(b)) if a < b => &raw[a..b + "</svg>".len()],
        _ => bail!("Claude didn't return a drawing. Try again."),
    };
    rasterise_svg(svg)
}

fn rasterise_svg(svg: &str) -> Result<image::DynamicImage> {
    use resvg::{tiny_skia, usvg};
    // No resources folder, so the SVG can't pull in files or images from disk.
    let tree = usvg::Tree::from_str(svg, &usvg::Options::default()).context("Claude's drawing wasn't valid SVG. Try again.")?;
    let size = tree.size();
    let scale = 1400.0 / size.width().max(size.height());
    let (w, h) = ((size.width() * scale).ceil() as u32, (size.height() * scale).ceil() as u32);
    let mut pm = tiny_skia::Pixmap::new(w.max(1), h.max(1)).context("empty drawing")?;
    pm.fill(tiny_skia::Color::WHITE);
    resvg::render(&tree, tiny_skia::Transform::from_scale(scale, scale), &mut pm.as_mut());
    // Opaque after the white fill, so premultiplied RGBA is plain RGB.
    let rgb: Vec<u8> = pm.data().chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect();
    let img = image::RgbImage::from_raw(w.max(1), h.max(1), rgb).context("bad drawing data")?;
    Ok(image::DynamicImage::ImageRgb8(img))
}

/// Grey ink on pure white, cropped to the ink with a small margin and at most 1400 px.
/// Returns None for a blank image.
pub(crate) fn clean_drawing(img: &image::DynamicImage) -> Option<image::GrayImage> {
    let mut g = img.to_luma8();
    // Paper tint and JPEG noise go to pure white so the slide background shows through cleanly.
    for p in g.pixels_mut() {
        if p.0[0] > 225 {
            p.0[0] = 255;
        }
    }
    let (w, h) = g.dimensions();
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0, 0);
    for (x, y, p) in g.enumerate_pixels() {
        if p.0[0] < 160 {
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
        }
    }
    if x1 <= x0 || y1 <= y0 {
        return None;
    }
    let pad = ((x1 - x0).max(y1 - y0) as f32 * 0.03) as u32;
    let (x0, y0) = (x0.saturating_sub(pad), y0.saturating_sub(pad));
    let (x1, y1) = ((x1 + pad).min(w - 1), (y1 + pad).min(h - 1));
    let crop = image::imageops::crop_imm(&g, x0, y0, x1 - x0 + 1, y1 - y0 + 1).to_image();
    let (cw, ch) = crop.dimensions();
    let s = 1400.0 / cw.max(ch) as f32;
    Some(if s < 1.0 {
        image::imageops::resize(&crop, (cw as f32 * s).round() as u32, (ch as f32 * s).round() as u32, image::imageops::FilterType::Lanczos3)
    } else {
        crop
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_script_and_drops_a_missing_accent() {
        let raw = "```json\n{\"hook\": {\"text\": \"Hidden signs of loneliness\", \"scene\": \"a man alone\"}, \"accent\": \"loneliness\", \
                   \"points\": [{\"text\": \"You feel like no one really knows you\", \"scene\": \"crowd\"}, {\"text\": \"\", \"scene\": \"x\"}], \
                   \"plug\": {\"text\": \"Penpal helps you write to people who write back.\", \"scene\": \"phone\"}}\n```";
        let s = parse_script(raw).unwrap();
        assert_eq!(s.slides.len(), 2);
        assert_eq!(s.accent, "loneliness");
        assert!(s.plug.is_some());

        let raw = "{\"hook\": {\"text\": \"Signs you need a break\", \"scene\": \"a\"}, \"accent\": \"burnout\", \"points\": [{\"text\": \"You dread mornings\", \"scene\": \"b\"}], \"plug\": null}";
        let s = parse_script(raw).unwrap();
        assert_eq!(s.accent, "");
        assert!(s.plug.is_none());
    }

    /// Writes with Claude and draws the hook with Codex, using your CLI logins:
    /// `cargo test write_and_draw_live -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn write_and_draw_live() {
        let brief = WriteBrief { topic: "adult friendships", points: 5, own_app: None, used: &[] };
        let script = write_script(&brief, Writer::Claude).unwrap();
        for s in &script.slides {
            println!("- {} [{}]", s.text, s.scene);
        }
        println!("accent: {:?}", script.accent);
        let out = std::env::temp_dir().join("openugc-drawn-live");
        let t = std::time::Instant::now();
        let hook = draw(&script.slides[0].scene, Writer::Codex, None, &out).unwrap();
        println!("drew {} in {:?}", hook.display(), t.elapsed());
        let mut slides = script.slides.clone();
        slides[0].image = Some(hook);
        let r = crate::slides::render_drawn(&slides, &script.accent, None, &Default::default(), &out.join("slides")).unwrap();
        println!("rendered {} slides to {}", r.slides.len(), r.dir.display());
    }

    #[test]
    fn svg_is_rasterised_and_cropped_to_the_ink() {
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800"><rect width="800" height="800" fill="#fff"/>
            <circle cx="400" cy="300" r="80" stroke="#111" stroke-width="5" fill="none"/><line x1="400" y1="380" x2="400" y2="600" stroke="#111" stroke-width="5"/></svg>"##;
        let img = rasterise_svg(svg).unwrap();
        let clean = clean_drawing(&img).unwrap();
        let (w, h) = clean.dimensions();
        // Cropped to the figure (taller than wide), not the full square canvas.
        assert!(h > w && w < 600, "{w}x{h}");
        assert!(clean_drawing(&image::DynamicImage::ImageLuma8(image::GrayImage::from_pixel(50, 50, image::Luma([250])))).is_none());
    }
}
