//! Renders TikTok slideshow images (2160x2700, 4:5) entirely in Rust:
//! text is shaped with rustybuzz and filled as vector paths with tiny-skia,
//! and the iPhone mockup is drawn flat, then perspective-warped onto the hook slide.

use crate::drawn::DrawnSlide;
use crate::prepare::PreparedApp;
use anyhow::{bail, Context, Result};
use rustybuzz::ttf_parser::{GlyphId, OutlineBuilder};
use rustybuzz::{Face, UnicodeBuffer};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tiny_skia::{
    Color, FillRule, GradientStop, LinearGradient, Mask, Paint, Path as SkPath, PathBuilder, Pixmap,
    PixmapPaint, Point, SpreadMode, Stroke, Transform,
};

pub const W: u32 = 2160;
pub const H: u32 = 2700;


static DISPLAY_BOLD: &[u8] = include_bytes!("../fonts/InterDisplay-Bold.ttf");
static DISPLAY_REGULAR: &[u8] = include_bytes!("../fonts/InterDisplay-Regular.ttf");
static DISPLAY_SEMIBOLD: &[u8] = include_bytes!("../fonts/InterDisplay-SemiBold.ttf");
static TEXT_LIGHT: &[u8] = include_bytes!("../fonts/Inter-Light.ttf");
/// Rounded handwriting for the relatable-drawings format (Mali, SIL Open Font License).
static HAND: &[u8] = include_bytes!("../fonts/Mali-SemiBold.ttf");

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SlideOptions {
    pub hook_accent: String,
    pub hook_line2: String,
    pub hook_line3: String,
    /// Shown as "(part N)" under the title; 0 hides it.
    pub part: u32,
    pub cta_accent: String,
    pub cta_line2: String,
    pub cta_line3: String,
    /// Hex colours chosen in the app, e.g. "#0b8a67".
    pub background: String,
    pub accent: String,
    pub text: String,
    pub wallpaper: String,
}

impl Default for SlideOptions {
    fn default() -> Self {
        Self {
            hook_accent: "hidden gems".into(),
            hook_line2: "of the".into(),
            hook_line3: "App Store".into(),
            part: 1,
            cta_accent: "save & follow".into(),
            cta_line2: "for more".into(),
            cta_line3: "hidden gems".into(),
            background: "#ffffff".into(),
            accent: "#0b8a67".into(),
            text: "#15171c".into(),
            wallpaper: "#e9ecef".into(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedSlideshow {
    pub dir: PathBuf,
    pub slides: Vec<PathBuf>,
}

/// Resolved slide colours.
struct Palette {
    bg: [u8; 3],
    accent: [u8; 3],
    ink: [u8; 3],
    muted: [u8; 3],
    wall_top: [u8; 3],
    wall_mid: [u8; 3],
    wall_bottom: [u8; 3],
}

impl Palette {
    fn from(o: &SlideOptions) -> Result<Self> {
        let bg = parse_hex(&o.background).context("background colour")?;
        let ink = parse_hex(&o.text).context("text colour")?;
        let wall = parse_hex(&o.wallpaper).context("phone wallpaper colour")?;
        Ok(Self {
            bg,
            accent: parse_hex(&o.accent).context("accent colour")?,
            ink,
            muted: mix(ink, bg, 0.45),
            wall_top: mix(wall, [255, 255, 255], 0.55),
            wall_mid: wall,
            wall_bottom: mix(wall, [0, 0, 0], 0.35),
        })
    }
}

/// Parses "#rgb" or "#rrggbb".
fn parse_hex(s: &str) -> Result<[u8; 3]> {
    let h = s.trim().trim_start_matches('#');
    let full: String = match h.len() {
        3 => h.chars().flat_map(|c| [c, c]).collect(),
        6 => h.to_string(),
        _ => bail!("\"{s}\" isn't a hex colour like #1a2b3c"),
    };
    let v = u32::from_str_radix(&full, 16).with_context(|| format!("\"{s}\" isn't a hex colour"))?;
    Ok([(v >> 16) as u8, (v >> 8) as u8, v as u8])
}

/// Linear blend: t = 0 gives `a`, t = 1 gives `b`.
fn mix(a: [u8; 3], b: [u8; 3], t: f32) -> [u8; 3] {
    let f = |x: u8, y: u8| (x as f32 + (y as f32 - x as f32) * t).round() as u8;
    [f(a[0], b[0]), f(a[1], b[1]), f(a[2], b[2])]
}

struct Fonts {
    bold: Face<'static>,
    regular: Face<'static>,
    semibold: Face<'static>,
    light: Face<'static>,
}

impl Fonts {
    fn load() -> Result<Self> {
        let f = |b: &'static [u8]| Face::from_slice(b, 0).context("bundled font failed to load");
        Ok(Self { bold: f(DISPLAY_BOLD)?, regular: f(DISPLAY_REGULAR)?, semibold: f(DISPLAY_SEMIBOLD)?, light: f(TEXT_LIGHT)? })
    }
}

/// Renders hook + one slide per app + CTA into `out_dir` as JPEGs.
pub fn render_slideshow(apps: &[PreparedApp], opts: &SlideOptions, out_dir: &Path) -> Result<RenderedSlideshow> {
    if apps.is_empty() {
        bail!("Add at least one prepared app before making slides.");
    }
    let pal = Palette::from(opts)?;
    std::fs::create_dir_all(out_dir)?;
    let fonts = Fonts::load()?;
    let icons: Vec<Option<Pixmap>> = apps
        .iter()
        .map(|a| a.icon.as_deref().and_then(|p| load_pixmap(p).ok()))
        .collect();

    let mut slides = Vec::new();
    let mut save = |name: &str, pm: &Pixmap| -> Result<()> {
        let path = out_dir.join(name);
        save_jpeg(pm, &path)?;
        slides.push(path);
        Ok(())
    };

    save("01-hook.jpg", &hook_slide(&fonts, &pal, opts, &icons))?;
    for (i, app) in apps.iter().enumerate() {
        let pm = app_slide(&fonts, &pal, app, icons[i].as_ref())?;
        save(&format!("{:02}-{}.jpg", i + 2, slug(&app.app.track_name)), &pm)?;
    }
    save(&format!("{:02}-cta.jpg", apps.len() + 2), &cta_slide(&fonts, &pal, opts, &icons))?;

    Ok(RenderedSlideshow { dir: out_dir.to_path_buf(), slides })
}

// ---------------------------------------------------------------------------
// Slides
// ---------------------------------------------------------------------------

fn blank(pal: &Palette) -> Pixmap {
    let mut pm = Pixmap::new(W, H).unwrap();
    pm.fill(rgb(pal.bg[0], pal.bg[1], pal.bg[2]));
    pm
}

fn hook_slide(f: &Fonts, pal: &Palette, o: &SlideOptions, icons: &[Option<Pixmap>]) -> Pixmap {
    let mut pm = blank(pal);

    // Phone first so the headline always sits on top of its shadow.
    let phone = phone_mockup(pal, icons);
    // Shrunk around the middle of its top edge, then pushed down so less of it shows and its top
    // clears the headline; it still runs off the bottom.
    const PHONE_SCALE: f32 = 0.74;
    const PHONE_DROP: f32 = 300.0;
    let (ax, ay) = (1385.0, 845.0);
    let quad = [(720.0, 905.0), (2050.0, 785.0), (2110.0, 3730.0), (705.0, 3610.0)]
        .map(|(x, y): (f32, f32)| (ax + (x - ax) * PHONE_SCALE, ay + (y - ay) * PHONE_SCALE + PHONE_DROP));
    drop_shadow(&mut pm, &quad, (46.0 * PHONE_SCALE, 34.0 * PHONE_SCALE), 0.42);
    warp_onto(&mut pm, &phone, &quad);

    // Shrink all three lines together until the widest fits, keeping the top edge in place.
    let x = 216.0;
    let max_w = W as f32 - 2.0 * x;
    let mut size: f32 = 190.0;
    let widest = |s: f32| {
        text_width(&f.bold, &o.hook_accent, s, -0.035)
            .max(text_width(&f.regular, &o.hook_line2, s, -0.035))
            .max(text_width(&f.regular, &o.hook_line3, s, -0.035))
    };
    while widest(size) > max_w && size > 110.0 {
        size -= 4.0;
    }
    let top = 405.0 - 0.73 * 190.0;
    let (b1, gap) = (top + 0.73 * size, 1.1 * size);
    draw_text(&mut pm, &f.bold, &o.hook_accent, size, -0.035, x, b1, pal.accent);
    draw_text(&mut pm, &f.regular, &o.hook_line2, size, -0.035, x, b1 + gap, pal.ink);
    draw_text(&mut pm, &f.regular, &o.hook_line3, size, -0.035, x, b1 + 2.0 * gap, pal.ink);
    if o.part > 0 {
        draw_text(&mut pm, &f.regular, &format!("(part {})", o.part), 128.0, -0.03, x, b1 + 2.0 * gap + 365.0, pal.ink);
    }
    pm
}

fn app_slide(f: &Fonts, pal: &Palette, p: &PreparedApp, icon: Option<&Pixmap>) -> Result<Pixmap> {
    let mut pm = blank(pal);
    let cx = W as f32 / 2.0;

    // Icon in a thin rounded outline.
    let (ix, iy, is) = (904.0, 216.0, 392.0);
    let radius = is * 0.225;
    if let Some(icon) = icon {
        draw_image_cover(&mut pm, icon, ix, iy, is, is, radius);
    }
    let outline = rounded_rect(ix, iy, is, is, radius);
    let mut paint = solid(pal.ink, 255);
    paint.anti_alias = true;
    pm.stroke_path(&outline, &paint, &Stroke { width: 3.0, ..Default::default() }, Transform::identity(), None);

    // App name: shrink to fit long names, never wrap.
    let name = display_name(&p.app.track_name);
    let mut size = 128.0;
    while text_width(&f.bold, &name, size, -0.02) > 1780.0 && size > 70.0 {
        size -= 4.0;
    }
    draw_text_centered(&mut pm, &f.bold, &name, size, -0.02, cx, 783.0, pal.ink);

    // Overview: balanced, centered lines; shrink if it would run past four lines.
    let mut size = 63.0;
    let mut lines = balanced_wrap(&f.light, p.overview.trim(), size, 1130.0);
    while lines.len() > 4 && size > 46.0 {
        size -= 3.0;
        lines = balanced_wrap(&f.light, p.overview.trim(), size, 1180.0);
    }
    let line_h = size * 1.15;
    for (i, line) in lines.iter().enumerate() {
        draw_text_centered(&mut pm, &f.light, line, size, -0.005, cx, 945.0 + i as f32 * line_h, pal.ink);
    }

    // Up to three screenshots in a row (centred when there are fewer).
    let shots: Vec<Pixmap> = p.screenshots.iter().take(3).filter_map(|s| load_pixmap(s).ok()).collect();
    let (sw, sh, gap, top) = (560.0, 1215.0, 24.0, 1269.0);
    let total = shots.len() as f32 * sw + (shots.len().saturating_sub(1)) as f32 * gap;
    let mut x = (W as f32 - total) / 2.0;
    for shot in &shots {
        draw_image_cover(&mut pm, shot, x, top, sw, sh, 41.0);
        x += sw + gap;
    }
    Ok(pm)
}

fn cta_slide(f: &Fonts, pal: &Palette, o: &SlideOptions, icons: &[Option<Pixmap>]) -> Pixmap {
    let mut pm = blank(pal);
    let x = 216.0;
    let size = 190.0;
    draw_text(&mut pm, &f.bold, &o.cta_accent, size, -0.035, x, 405.0, pal.accent);
    draw_text(&mut pm, &f.regular, &o.cta_line2, size, -0.035, x, 614.0, pal.ink);
    draw_text(&mut pm, &f.regular, &o.cta_line3, size, -0.035, x, 823.0, pal.ink);

    // Recap row of the apps from this slideshow.
    let present: Vec<&Pixmap> = icons.iter().flatten().collect();
    if !present.is_empty() {
        let n = present.len() as f32;
        let gap = 40.0;
        let s = ((W as f32 - 2.0 * 216.0 - gap * (n - 1.0)) / n).min(300.0);
        let total = n * s + (n - 1.0) * gap;
        let mut ix = (W as f32 - total) / 2.0;
        let iy = 2050.0;
        let rects: Vec<(f32, f32, f32, f32)> = (0..present.len()).map(|i| (ix + i as f32 * (s + gap), iy, s, s)).collect();
        soft_shadows(&mut pm, &rects, s * 0.225, 22.0, 0.22);
        for icon in present {
            draw_image_cover(&mut pm, icon, ix, iy, s, s, s * 0.225);
            ix += s + gap;
        }
        draw_text_centered(&mut pm, &f.semibold, "all apps from this post", 58.0, -0.01, W as f32 / 2.0, iy + s + 120.0, pal.muted);
    }
    pm
}

// ---------------------------------------------------------------------------
// Relatable drawings format: a line of handwriting above a stick-figure drawing
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DrawnStyle {
    pub background: String,
    pub text: String,
    pub accent: String,
}

impl Default for DrawnStyle {
    fn default() -> Self {
        Self { background: "#faf9f6".into(), text: "#111111".into(), accent: "#e0201b".into() }
    }
}

/// The last slide's app: shown as its icon and name under the drawing.
pub struct PlugApp<'a> {
    pub name: &'a str,
    pub icon: Option<&'a Path>,
}

struct DrawnPalette {
    bg: [u8; 3],
    ink: [u8; 3],
    accent: [u8; 3],
}

/// Renders the hook and points (`slides[0]` is the hook), then the plug, into `out_dir` as JPEGs.
pub fn render_drawn(
    slides: &[DrawnSlide],
    accent: &str,
    plug: Option<(&DrawnSlide, PlugApp)>,
    style: &DrawnStyle,
    out_dir: &Path,
) -> Result<RenderedSlideshow> {
    if slides.iter().all(|s| s.text.trim().is_empty()) {
        bail!("Write the slides first.");
    }
    let pal = DrawnPalette {
        bg: parse_hex(&style.background).context("background colour")?,
        ink: parse_hex(&style.text).context("text colour")?,
        accent: parse_hex(&style.accent).context("highlight colour")?,
    };
    let face = Face::from_slice(HAND, 0).context("bundled font failed to load")?;
    let drawing = |s: &DrawnSlide, i: usize| -> Result<Option<image::GrayImage>> {
        match &s.image {
            Some(p) => Ok(Some(image::open(p).with_context(|| format!("Couldn't open the drawing for slide {}", i + 1))?.to_luma8())),
            None => Ok(None),
        }
    };
    std::fs::create_dir_all(out_dir)?;
    let mut out = Vec::new();
    let mut save = |name: String, pm: &Pixmap| -> Result<()> {
        let path = out_dir.join(name);
        save_jpeg(pm, &path)?;
        out.push(path);
        Ok(())
    };
    let shown: Vec<&DrawnSlide> = slides.iter().filter(|s| !s.text.trim().is_empty()).collect();
    for (i, s) in shown.iter().enumerate() {
        let (size, acc) = if i == 0 { (150.0, accent) } else { (132.0, "") };
        let pm = drawn_slide(&face, &pal, s.text.trim(), acc, size, drawing(s, i)?.as_ref(), None);
        let name = if i == 0 { "01-hook.jpg".to_string() } else { format!("{:02}-{}.jpg", i + 1, slug(&s.text)) };
        save(name, &pm)?;
    }
    if let Some((s, app)) = plug {
        if !s.text.trim().is_empty() {
            let icon = app.icon.and_then(|p| load_pixmap(p).ok());
            let pm = drawn_slide(&face, &pal, s.text.trim(), "", 120.0, drawing(s, shown.len())?.as_ref(), Some((icon.as_ref(), app.name)));
            save(format!("{:02}-{}.jpg", shown.len() + 1, slug(app.name)), &pm)?;
        }
    }
    Ok(RenderedSlideshow { dir: out_dir.to_path_buf(), slides: out })
}

fn drawn_slide(
    face: &Face,
    pal: &DrawnPalette,
    text: &str,
    accent: &str,
    base_size: f32,
    drawing: Option<&image::GrayImage>,
    badge: Option<(Option<&Pixmap>, &str)>,
) -> Pixmap {
    let mut pm = Pixmap::new(W, H).unwrap();
    pm.fill(rgb(pal.bg[0], pal.bg[1], pal.bg[2]));
    let cx = W as f32 / 2.0;

    // Balanced, centred lines; long lines shrink rather than run past five lines.
    let max_w = 1720.0;
    let mut size = base_size;
    let mut lines = balanced_wrap(face, text, size, max_w);
    while lines.len() > 5 && size > 92.0 {
        size -= 4.0;
        lines = balanced_wrap(face, text, size, max_w);
    }
    let line_h = size * 1.42;
    let cap = size * 0.72;
    let block = (lines.len() as f32 - 1.0) * line_h + size;
    // The text block sits around 30% of the way down, like the reference slides; alone it's centred.
    let centre = if drawing.is_some() || badge.is_some() { H as f32 * 0.30 } else { H as f32 * 0.5 };
    let first = (centre - block / 2.0 + cap).max(300.0);

    let hot = hot_words(text, accent);
    let space = text_width(face, " ", size, 0.0);
    let mut k = 0;
    for (li, line) in lines.iter().enumerate() {
        let baseline = first + li as f32 * line_h;
        let mut x = cx - text_width(face, line, size, 0.0) / 2.0;
        for word in line.split_whitespace() {
            let color = if hot.get(k).copied().unwrap_or(false) { pal.accent } else { pal.ink };
            draw_text(&mut pm, face, word, size, 0.0, x, baseline, color);
            x += text_width(face, word, size, 0.0) + space;
            k += 1;
        }
    }
    let text_bottom = first + (lines.len() as f32 - 1.0) * line_h + size * 0.3;

    let bottom = if badge.is_some() { H as f32 - 600.0 } else { H as f32 - 200.0 };
    if let Some(img) = drawing {
        let top = text_bottom + 130.0;
        let box_h = (bottom - top).max(320.0);
        let (iw, ih) = (img.width() as f32, img.height() as f32);
        let s = (1200.0 / iw).min(box_h.min(1020.0) / ih);
        let (dw, dh) = ((iw * s).round().max(1.0) as u32, (ih * s).round().max(1.0) as u32);
        let x = ((W - dw.min(W)) / 2) as usize;
        let y = (top + (box_h - dh as f32) * 0.3).max(0.0) as usize;
        multiply_ink(&mut pm, &image::imageops::resize(img, dw, dh, image::imageops::FilterType::Lanczos3), x, y);
    }

    match badge {
        // Icon and name in a row under the drawing.
        Some((icon, name)) if drawing.is_some() => {
            let (is, gap, ns) = (230.0, 50.0, 100.0);
            let name = display_name(name);
            let nw = text_width(face, &name, ns, 0.0).min(W as f32 - 2.0 * 200.0 - is - gap);
            let row = if icon.is_some() { is + gap + nw } else { nw };
            let x = (W as f32 - row) / 2.0;
            let y = H as f32 - 470.0;
            if let Some(icon) = icon {
                soft_shadows(&mut pm, &[(x, y, is, is)], is * 0.225, 18.0, 0.22);
                draw_image_cover(&mut pm, icon, x, y, is, is, is * 0.225);
            }
            let nx = if icon.is_some() { x + is + gap } else { x };
            draw_text(&mut pm, face, &name, ns, 0.0, nx, y + is / 2.0 + ns * 0.35, pal.ink);
        }
        // No drawing: a large icon with the name under it.
        Some((icon, name)) => {
            let is = 440.0;
            let y = (text_bottom + 220.0).min(H as f32 - is - 400.0);
            if let Some(icon) = icon {
                let x = (W as f32 - is) / 2.0;
                soft_shadows(&mut pm, &[(x, y, is, is)], is * 0.225, 24.0, 0.22);
                draw_image_cover(&mut pm, icon, x, y, is, is, is * 0.225);
            }
            draw_text_centered(&mut pm, face, &display_name(name), 110.0, 0.0, cx, y + is + 170.0, pal.ink);
        }
        None => {}
    }
    pm
}

/// Multiplies grey ink onto the slide, so white paper disappears into any background colour.
fn multiply_ink(pm: &mut Pixmap, ink: &image::GrayImage, x0: usize, y0: usize) {
    let (w, h) = (pm.width() as usize, pm.height() as usize);
    let data = pm.data_mut();
    for (x, y, p) in ink.enumerate_pixels() {
        let (x, y) = (x0 + x as usize, y0 + y as usize);
        if x >= w || y >= h || p.0[0] == 255 {
            continue;
        }
        let i = (y * w + x) * 4;
        let l = p.0[0] as u16;
        for c in &mut data[i..i + 3] {
            *c = ((*c as u16 * l + 127) / 255) as u8;
        }
    }
}

/// Which words of `text` belong to the accent phrase, matched as a run of words.
fn hot_words(text: &str, accent: &str) -> Vec<bool> {
    let norm = |w: &str| w.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase();
    let words: Vec<String> = text.split_whitespace().map(norm).collect();
    let want: Vec<String> = accent.split_whitespace().map(norm).filter(|w| !w.is_empty()).collect();
    let mut hot = vec![false; words.len()];
    if !want.is_empty() {
        if let Some(i) = (0..words.len().saturating_sub(want.len() - 1)).find(|&i| words[i..i + want.len()] == want[..]) {
            hot[i..i + want.len()].iter_mut().for_each(|h| *h = true);
        }
    }
    hot
}

// ---------------------------------------------------------------------------
// App spotlight format: the app on a phone in a desk photo, plus Mac-window text slides
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SpotLine {
    pub text: String,
    /// Index into the app's screenshots.
    pub shot: usize,
    /// Your own screenshot, used instead of the App Store one.
    pub image: Option<PathBuf>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Spotlight {
    pub hook: String,
    /// Words of the hook drawn in `color`.
    pub accent: String,
    pub lines: Vec<SpotLine>,
    pub cta: String,
    pub window_title: String,
    /// Highlight colour: the hook's accent words, the text cursor and the Get button.
    pub color: String,
}

impl Default for Spotlight {
    fn default() -> Self {
        Self { hook: String::new(), accent: String::new(), lines: vec![], cta: String::new(), window_title: "Notes".into(), color: "#0a84ff".into() }
    }
}

const WIN_INK: [u8; 3] = [0x1D, 0x1D, 0x1F];
const WIN_MUTED: [u8; 3] = [0x6E, 0x6E, 0x73];

/// Renders the hook window, one slide per line with its screenshot on the phone, and the
/// last window (if it has text) into `out_dir` as JPEGs.
pub fn render_spotlight(
    apps: &[PreparedApp],
    s: &Spotlight,
    desk: &Path,
    marked: Option<[(f32, f32); 4]>,
    out_dir: &Path,
) -> Result<RenderedSlideshow> {
    if s.hook.trim().is_empty() {
        bail!("Write the hook first.");
    }
    if apps.is_empty() {
        bail!("Prepare the post's apps first.");
    }
    // One slide per app; `lines` follows the apps' order.
    let blank = SpotLine::default();
    let lines: Vec<&SpotLine> = (0..apps.len()).map(|i| s.lines.get(i).unwrap_or(&blank)).collect();
    for (i, (app, l)) in apps.iter().zip(&lines).enumerate() {
        if l.text.trim().is_empty() {
            bail!("Write the line for slide {} ({}) first.", i + 2, app.app.track_name);
        }
        if app.screenshots.is_empty() && l.image.is_none() {
            bail!("{} has no App Store screenshots, so add your own on its slide.", app.app.track_name);
        }
    }
    let color = parse_hex(&s.color).context("highlight colour")?;
    let fonts = Fonts::load()?;
    let mut scene = DeskScene::load(desk, marked)?;
    std::fs::create_dir_all(out_dir)?;
    let icons: Vec<Option<Pixmap>> = apps.iter().map(|a| a.icon.as_deref().and_then(|p| load_pixmap(p).ok())).collect();

    let mut out = Vec::new();
    let mut save = |name: String, mut pm: Pixmap| -> Result<()> {
        film_grain(&mut pm);
        let path = out_dir.join(name);
        save_jpeg(&pm, &path)?;
        out.push(path);
        Ok(())
    };
    // The phone's App Store page, at about an iPhone's pixel width and the screen's shape.
    let (qw, qh) = scene.screen_size();
    let (pw, ph) = (1179.0, (1179.0 * qh / qw).clamp(1179.0 * 1.6, 1179.0 * 2.6));
    let mut pages = Vec::with_capacity(apps.len());
    for (i, (app, l)) in apps.iter().zip(&lines).enumerate() {
        let store: Vec<Pixmap> = app.screenshots.iter().take(10).map(|p| load_pixmap(p)).collect::<Result<_>>()?;
        let own = match &l.image {
            Some(own) => Some(load_pixmap(own).with_context(|| format!("Couldn't open your screenshot for slide {}", i + 2))?),
            None => None,
        };
        // The carousel starts at this slide's screenshot and runs on through the store's.
        let start = if store.is_empty() { 0 } else { l.shot.min(store.len() - 1) };
        let shots: Vec<&Pixmap> = match &own {
            Some(own) => std::iter::once(own).chain(store.iter()).collect(),
            None => store[start..].iter().chain(store[..start].iter()).collect(),
        };
        pages.push(app_store_page(&fonts, app, icons[i].as_ref(), &shots, pw, ph));
    }
    // The window slides sit on the blurred desk with the first app's page lit on the phone.
    scene.blurred = blur_scene(&with_screen(&scene, &pages[0]));

    save("01-hook.jpg".into(), hook_window_slide(&fonts, &scene, s, color))?;
    for (i, (page, l)) in pages.iter().zip(&lines).enumerate() {
        let pm = screen_slide(&fonts, &scene, page, l.text.trim(), &s.window_title, color);
        save(format!("{:02}-{}.jpg", i + 2, slug(&apps[i].app.track_name)), pm)?;
    }
    if !s.cta.trim().is_empty() {
        let pm = if apps.len() == 1 {
            cta_window_slide(&fonts, &scene, &apps[0], icons[0].as_ref(), s, color)
        } else {
            recap_window_slide(&fonts, &scene, &icons, s)
        };
        save(format!("{:02}-get-them.jpg", apps.len() + 2), pm)?;
    }
    Ok(RenderedSlideshow { dir: out_dir.to_path_buf(), slides: out })
}

/// Where a desk photo's phone screen is.
pub(crate) struct Screen {
    /// Corners TL, TR, BR, BL in image pixels.
    pub quad: [(f32, f32); 4],
    /// How much of each pixel is screen, 0 to 255, at the image's size.
    pub alpha: image::GrayImage,
}

fn greenness(p: &image::Rgb<u8>) -> i32 {
    p[1] as i32 - p[0].max(p[2]) as i32
}

/// Finds the chroma-green phone screen: the largest clearly green blob, which has to be a
/// reasonably big, upright, four-cornered shape.
pub(crate) fn find_screen(img: &image::RgbImage) -> Option<Screen> {
    let (w, h) = (img.width() as usize, img.height() as usize);
    let seed: Vec<bool> = img.pixels().map(|p| p[1] > 140 && greenness(p) > 80).collect();

    // Largest 4-connected blob.
    let mut label = vec![0u32; w * h];
    let (mut best_size, mut best_id, mut next) = (0usize, 0u32, 1u32);
    let mut stack = Vec::new();
    for start in 0..w * h {
        if !seed[start] || label[start] != 0 {
            continue;
        }
        label[start] = next;
        stack.push(start);
        let mut size = 0;
        while let Some(i) = stack.pop() {
            size += 1;
            let (x, y) = (i % w, i / w);
            let mut near = [usize::MAX; 4];
            if x > 0 { near[0] = i - 1; }
            if x + 1 < w { near[1] = i + 1; }
            if y > 0 { near[2] = i - w; }
            if y + 1 < h { near[3] = i + w; }
            for j in near {
                if j != usize::MAX && seed[j] && label[j] == 0 {
                    label[j] = next;
                    stack.push(j);
                }
            }
        }
        if size > best_size {
            (best_size, best_id) = (size, next);
        }
        next += 1;
    }
    if best_size < w * h / 100 {
        return None;
    }

    // Corners: the blob's extreme points along both diagonals.
    let (mut tl, mut tr, mut br, mut bl) = ((0usize, 0usize), (0, 0), (0, 0), (0, 0));
    let (mut s_min, mut s_max, mut d_min, mut d_max) = (i64::MAX, i64::MIN, i64::MAX, i64::MIN);
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0, 0);
    for (i, &l) in label.iter().enumerate() {
        if l != best_id {
            continue;
        }
        let (x, y) = (i % w, i / w);
        let (s, d) = ((x + y) as i64, x as i64 - y as i64);
        if s < s_min { s_min = s; tl = (x, y); }
        if s > s_max { s_max = s; br = (x, y); }
        if d > d_max { d_max = d; tr = (x, y); }
        if d < d_min { d_min = d; bl = (x, y); }
        (x0, y0, x1, y1) = (x0.min(x), y0.min(y), x1.max(x), y1.max(y));
    }
    let f = |p: (usize, usize)| (p.0 as f32 + 0.5, p.1 as f32 + 0.5);
    let quad = [f(tl), f(tr), f(br), f(bl)];
    let area = 0.5 * (0..4).map(|i| {
        let (a, b) = (quad[i], quad[(i + 1) % 4]);
        a.0 * b.1 - b.0 * a.1
    }).sum::<f32>().abs();
    let dist = |a: (f32, f32), b: (f32, f32)| ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt();
    let (qw, qh) = ((dist(quad[0], quad[1]) + dist(quad[3], quad[2])) / 2.0, (dist(quad[0], quad[3]) + dist(quad[1], quad[2])) / 2.0);
    // A tilted or partly covered screen doesn't fill its corner quad, or isn't portrait.
    let fill = best_size as f32 / area.max(1.0);
    if !(0.85..=1.3).contains(&fill) || qh < qw * 1.2 {
        return None;
    }

    // Alpha: solid inside the quad (so glare spots are covered too), and soft at the blob's
    // edges, where pixels are part green.
    let pad = 6;
    let (x0, y0, x1, y1) = (x0.saturating_sub(pad), y0.saturating_sub(pad), (x1 + pad).min(w - 1), (y1 + pad).min(h - 1));
    let mut alpha = image::GrayImage::new(w as u32, h as u32);
    let inside = |px: f32, py: f32| {
        (0..4).all(|i| {
            let (a, b) = (quad[i], quad[(i + 1) % 4]);
            (b.0 - a.0) * (py - a.1) - (b.1 - a.1) * (px - a.0) >= 0.0
        })
    };
    let near_blob = |x: usize, y: usize| {
        let r = 3;
        (y.saturating_sub(r)..=(y + r).min(h - 1)).any(|yy| (x.saturating_sub(r)..=(x + r).min(w - 1)).any(|xx| label[yy * w + xx] == best_id))
    };
    for y in y0..=y1 {
        for x in x0..=x1 {
            let a = if inside(x as f32 + 0.5, y as f32 + 0.5) {
                255
            } else if near_blob(x, y) {
                let g = greenness(img.get_pixel(x as u32, y as u32));
                ((g - 20) * 255 / 60).clamp(0, 255) as u8
            } else {
                0
            };
            alpha.put_pixel(x as u32, y as u32, image::Luma([a]));
        }
    }
    Some(Screen { quad, alpha })
}

/// `find_screen` on a copy at most 1600 px on its long side (stock photos can be huge). Returns
/// the corners in the photo's own pixels and the coverage at the smaller size.
pub(crate) fn find_screen_scaled(img: &image::RgbImage) -> Option<([(f32, f32); 4], image::GrayImage)> {
    let (w, h) = img.dimensions();
    let k = (w.max(h) as f32 / 1600.0).max(1.0);
    if k <= 1.0 {
        return find_screen(img).map(|s| (s.quad, s.alpha));
    }
    let small = image::imageops::resize(img, (w as f32 / k).round() as u32, (h as f32 / k).round() as u32, image::imageops::FilterType::Triangle);
    let (sx, sy) = (w as f32 / small.width() as f32, h as f32 / small.height() as f32);
    find_screen(&small).map(|s| (s.quad.map(|(x, y)| (x * sx, y * sy)), s.alpha))
}

/// A desk photo cropped to the slide, with its phone screen located.
struct DeskScene {
    photo: Pixmap,
    /// Screen coverage per slide pixel, for a green screen. A hand-marked screen has none:
    /// the screenshot is drawn with rounded corners straight onto the quad.
    alpha: Option<Vec<u8>>,
    quad: [(f32, f32); 4],
    /// Blurred and dimmed, for the window slides.
    blurred: Pixmap,
    /// The room's light around the phone, used to tint the screen so it sits in the photo.
    ambient: [u8; 3],
}

impl DeskScene {
    fn load(path: &Path, marked: Option<[(f32, f32); 4]>) -> Result<Self> {
        let src = image::open(path).with_context(|| format!("Couldn't open the desk photo {}", path.display()))?.to_rgb8();
        let (src_quad, green) = match marked {
            Some(q) => (q, None),
            None => {
                let (q, a) = find_screen_scaled(&src).context(
                    "Couldn't find the phone screen in this desk photo. Mark its four corners, or use a photo where the whole screen is solid bright green.",
                )?;
                (q, Some(a))
            }
        };
        // Cover the slide, zoomed in so the screen is about half the slide's height (but not
        // blown up past 1.6x the plain cover crop), with the phone a little below the middle.
        let (w, h) = (src.width() as f32, src.height() as f32);
        let cover = (W as f32 / w).max(H as f32 / h);
        let src_qh = ((src_quad[3].1 - src_quad[0].1) + (src_quad[2].1 - src_quad[1].1)) / 2.0;
        let s = cover.max((H as f32 * 0.46 / src_qh.max(1.0)).min(cover * 1.6));
        let (dw, dh) = (((w * s).round() as u32).max(W), ((h * s).round() as u32).max(H));
        let cx = src_quad.iter().map(|p| p.0).sum::<f32>() / 4.0 * s;
        let cy = src_quad.iter().map(|p| p.1).sum::<f32>() / 4.0 * s;
        let ox = (cx - W as f32 / 2.0).clamp(0.0, (dw - W) as f32).round() as u32;
        let oy = (cy - H as f32 * 0.6).clamp(0.0, (dh - H) as f32).round() as u32;
        use image::imageops::{crop_imm, resize, FilterType};
        let photo = crop_imm(&resize(&src, dw, dh, FilterType::Lanczos3), ox, oy, W, H).to_image();
        let alpha = green.map(|a| crop_imm(&resize(&a, dw, dh, FilterType::Triangle), ox, oy, W, H).to_image().into_raw());
        let quad = src_quad.map(|(x, y)| (x * s - ox as f32, y * s - oy as f32));
        let covered = |i: usize| alpha.as_ref().is_some_and(|a| a[i] > 0);

        // Opaque RGBA; where a green screen's edge is part green, take the green cast out of the photo.
        let mut data = Vec::with_capacity((W * H * 4) as usize);
        for (i, p) in photo.pixels().enumerate() {
            let [r, mut g, b] = p.0;
            if covered(i) {
                g = g.min(r.max(b));
            }
            data.extend_from_slice(&[r, g, b, 255]);
        }
        let photo = Pixmap::from_vec(data, tiny_skia::IntSize::from_wh(W, H).unwrap()).context("bad desk photo")?;

        // Average colour in a ring around the phone, outside the screen.
        let (bx0, bx1) = (quad.iter().map(|p| p.0).fold(f32::MAX, f32::min), quad.iter().map(|p| p.0).fold(f32::MIN, f32::max));
        let (by0, by1) = (quad.iter().map(|p| p.1).fold(f32::MAX, f32::min), quad.iter().map(|p| p.1).fold(f32::MIN, f32::max));
        let m = (bx1 - bx0) * 0.6;
        let (rx0, rx1) = ((bx0 - m).max(0.0) as u32, (bx1 + m).min(W as f32 - 1.0) as u32);
        let (ry0, ry1) = ((by0 - m).max(0.0) as u32, (by1 + m).min(H as f32 - 1.0) as u32);
        let mut sum = [0u64; 3];
        let mut n = 0u64;
        let d = photo.data();
        for y in (ry0..=ry1).step_by(3) {
            for x in (rx0..=rx1).step_by(3) {
                let i = (y * W + x) as usize;
                let inside_marked = alpha.is_none() && x as f32 > bx0 && (x as f32) < bx1 && y as f32 > by0 && (y as f32) < by1;
                if !covered(i) && !inside_marked {
                    for k in 0..3 {
                        sum[k] += d[i * 4 + k] as u64;
                    }
                    n += 1;
                }
            }
        }
        let ambient = if n > 0 { [0, 1, 2].map(|k| (sum[k] / n) as u8) } else { [200, 200, 200] };

        let blurred = blur_scene(&photo);
        Ok(Self { photo, alpha, quad, blurred, ambient })
    }

    /// The screen's average width and height on the slide.
    fn screen_size(&self) -> (f32, f32) {
        let q = self.quad;
        let dist = |a: (f32, f32), b: (f32, f32)| ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt();
        ((dist(q[0], q[1]) + dist(q[3], q[2])) / 2.0, (dist(q[0], q[3]) + dist(q[1], q[2])) / 2.0)
    }

    fn screen_top(&self) -> f32 {
        self.quad.iter().map(|p| p.1).fold(f32::MAX, f32::min)
    }
}

/// Soft background for the window slides: blurred at quarter size and dimmed a touch.
fn blur_scene(photo: &Pixmap) -> Pixmap {
    let q = 4.0;
    let mut small = Pixmap::new(W / 4, H / 4).unwrap();
    let paint = PixmapPaint { quality: tiny_skia::FilterQuality::Bilinear, ..Default::default() };
    small.draw_pixmap(0, 0, photo.as_ref(), &paint, Transform::from_scale(1.0 / q, 1.0 / q), None);
    box_blur_clamped(&mut small, 6, 3);
    let mut pm = Pixmap::new(W, H).unwrap();
    pm.draw_pixmap(0, 0, small.as_ref(), &paint, Transform::from_scale(q, q), None);
    let dim = tiny_skia::Rect::from_xywh(0.0, 0.0, W as f32, H as f32).unwrap();
    pm.fill_rect(dim, &solid([0x10, 0x0C, 0x08], 34), Transform::identity(), None);
    pm
}

/// Faint, even grain so the crisp screen and the window match the photo's texture.
fn film_grain(pm: &mut Pixmap) {
    let mut seed: u32 = 0x9E37_79B9;
    for px in pm.data_mut().chunks_exact_mut(4) {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        let n = (seed % 9) as i16 - 4;
        for c in &mut px[..3] {
            *c = (*c as i16 + n).clamp(0, 255) as u8;
        }
    }
}

/// The desk photo with an App Store page on the phone and the line in a window above it.
fn screen_slide(f: &Fonts, d: &DeskScene, page: &Pixmap, text: &str, title: &str, color: [u8; 3]) -> Pixmap {
    let mut pm = with_screen(d, page);
    line_window(&mut pm, f, title, text, d.screen_top(), color);
    pm
}

/// The desk photo with `page` on the phone's screen.
fn with_screen(d: &DeskScene, page: &Pixmap) -> Pixmap {
    let mut pm = d.photo.clone();
    let q = d.quad;
    let (sw, sh) = (page.width() as f32, page.height() as f32);

    // The screen: the page, a faint reflection, and a tint toward the room's light.
    let mut screen = page.clone();
    let mut glare = Paint::default();
    glare.anti_alias = true;
    glare.shader = LinearGradient::new(
        Point::from_xy(0.0, 0.0),
        Point::from_xy(sw * 0.8, sh * 0.45),
        vec![GradientStop::new(0.0, Color::from_rgba8(255, 255, 255, 30)), GradientStop::new(1.0, Color::from_rgba8(255, 255, 255, 0))],
        SpreadMode::Pad,
        Transform::identity(),
    )
    .unwrap();
    let full = tiny_skia::Rect::from_xywh(0.0, 0.0, sw, sh).unwrap();
    screen.fill_rect(full, &glare, Transform::identity(), None);
    let tint = [0, 1, 2].map(|k| 0.9 + 0.1 * d.ambient[k] as f32 / 255.0);
    for px in screen.data_mut().chunks_exact_mut(4) {
        for k in 0..3 {
            px[k] = (px[k] as f32 * tint[k]).round() as u8;
        }
    }

    match &d.alpha {
        // Green screen: pad the page with its own edge colour and warp it a little oversized, so
        // the page lands exactly on the screen and the padding reaches the rounded corners; the
        // photo's green mask trims it to the exact shape.
        Some(alpha) => {
            const OVER: f32 = 1.04;
            let (pw, ph) = ((sw * OVER).round() as u32, (sh * OVER).round() as u32);
            let mut padded = Pixmap::new(pw, ph).unwrap();
            let edge = &screen.data()[..4];
            padded.fill(Color::from_rgba8(edge[0], edge[1], edge[2], 255));
            let (ox, oy) = ((pw as f32 - sw) / 2.0, (ph as f32 - sh) / 2.0);
            padded.draw_pixmap(ox.round() as i32, oy.round() as i32, screen.as_ref(), &PixmapPaint::default(), Transform::identity(), None);
            let c = (q.iter().map(|p| p.0).sum::<f32>() / 4.0, q.iter().map(|p| p.1).sum::<f32>() / 4.0);
            let quad = q.map(|p| (c.0 + (p.0 - c.0) * OVER, c.1 + (p.1 - c.1) * OVER));
            let mut layer = Pixmap::new(W, H).unwrap();
            warp_onto(&mut layer, &padded, &quad);
            let src = layer.data();
            let dst = pm.data_mut();
            for (i, &a) in alpha.iter().enumerate() {
                if a == 0 {
                    continue;
                }
                let a = a as f32 / 255.0;
                let p = i * 4;
                let sa = src[p + 3] as f32;
                for k in 0..3 {
                    let sc = if sa > 0.0 { src[p + k] as f32 * 255.0 / sa } else { 16.0 };
                    dst[p + k] = (dst[p + k] as f32 * (1.0 - a) + sc * a).round().clamp(0.0, 255.0) as u8;
                }
            }
        }
        // Marked corners: give the screen an iPhone's rounded corners and warp it on as is.
        None => {
            let mut rounded = Pixmap::new(screen.width(), screen.height()).unwrap();
            let mut mask = Mask::new(screen.width(), screen.height()).unwrap();
            mask.fill_path(&rounded_rect(0.0, 0.0, sw, sh, sw * 0.12), FillRule::Winding, true, Transform::identity());
            rounded.draw_pixmap(0, 0, screen.as_ref(), &PixmapPaint::default(), Transform::identity(), Some(&mask));
            warp_onto(&mut pm, &rounded, &q);
        }
    }
    pm
}

/// The slide's line typed into a window above the phone (or below it if the phone sits high).
fn line_window(pm: &mut Pixmap, f: &Fonts, title: &str, text: &str, screen_top: f32, color: [u8; 3]) {
    let (w, pad) = (1700.0, 92.0);
    let max_w = w - 2.0 * pad;
    let mut size: f32 = 92.0;
    let mut lines = greedy_wrap(&f.bold, text, size, max_w);
    while lines.len() > 3 && size > 68.0 {
        size -= 4.0;
        lines = greedy_wrap(&f.bold, text, size, max_w);
    }
    let line_h = size * 1.18;
    let h = 112.0 + pad * 0.9 + (lines.len() as f32 - 1.0) * line_h + size * 0.8 + pad;
    let mut y = 170.0;
    if screen_top < y + h + 60.0 {
        y = H as f32 - 170.0 - h;
    }
    let x = (W as f32 - w) / 2.0;
    let top = mac_window(pm, f, title, x, y, w, h);
    let mut end = (x + pad, top);
    for (i, l) in lines.iter().enumerate() {
        let baseline = top + pad * 0.9 + size * 0.74 + i as f32 * line_h;
        draw_text(pm, &f.bold, l, size, -0.02, x + pad, baseline, WIN_INK);
        end = (x + pad + text_width(&f.bold, l, size, -0.02), baseline);
    }
    let caret = tiny_skia::Rect::from_xywh(end.0 + size * 0.1, end.1 - size * 0.8, (size * 0.07).max(5.0), size * 0.98).unwrap();
    pm.fill_rect(caret, &solid(color, 255), Transform::identity(), None);
}

/// Cuts `text` with an ellipsis so it fits `max_w`.
fn ellipsize(face: &Face, text: &str, size: f32, max_w: f32) -> String {
    let text = text.trim();
    if text_width(face, text, size, 0.0) <= max_w {
        return text.to_string();
    }
    let mut chars: Vec<char> = text.chars().collect();
    while !chars.is_empty() {
        chars.pop();
        let s = chars.iter().collect::<String>().trim_end().to_string() + "\u{2026}";
        if text_width(face, &s, size, 0.0) <= max_w {
            return s;
        }
    }
    "\u{2026}".into()
}

/// A rating count as the App Store shows it: 12345 is "12K".
fn short_count(n: u64) -> String {
    match n {
        0..=999 => n.to_string(),
        1_000..=9_999 => format!("{:.1}K", n as f64 / 1e3).replace(".0K", "K"),
        10_000..=999_999 => format!("{}K", n / 1_000),
        _ => format!("{:.1}M", n as f64 / 1e6).replace(".0M", "M"),
    }
}

fn star_path(cx: f32, cy: f32, r: f32) -> SkPath {
    let mut pb = PathBuilder::new();
    for i in 0..10 {
        let a = -std::f32::consts::FRAC_PI_2 + i as f32 * std::f32::consts::PI / 5.0;
        let rr = if i % 2 == 0 { r } else { r * 0.45 };
        let (x, y) = (cx + rr * a.cos(), cy + rr * a.sin());
        if i == 0 {
            pb.move_to(x, y)
        } else {
            pb.line_to(x, y)
        }
    }
    pb.close();
    pb.finish().unwrap()
}

/// The app's App Store page as the phone's screen shows it, `w` by `h` pixels, laid out in iPhone
/// points (393 wide). The screenshot carousel starts with `shots[0]`.
fn app_store_page(f: &Fonts, p: &PreparedApp, icon: Option<&Pixmap>, shots: &[&Pixmap], w: f32, h: f32) -> Pixmap {
    let u = w / 393.0;
    let hp = h / u;
    let mut pm = Pixmap::new(w.round() as u32, h.round() as u32).unwrap();
    pm.fill(rgb(255, 255, 255));
    let (blue, ink, label, value, rule) = ([0x00, 0x7A, 0xFF], [0, 0, 0], [0x8E, 0x8E, 0x93], [0x6C, 0x6C, 0x70], [0xD1, 0xD1, 0xD6]);
    let rr = |pm: &mut Pixmap, x: f32, y: f32, bw: f32, bh: f32, r: f32, c: [u8; 3]| {
        pm.fill_path(&rounded_rect(x * u, y * u, bw * u, bh * u, r * u), &solid(c, 255), FillRule::Winding, Transform::identity(), None);
    };
    let text = |pm: &mut Pixmap, face: &Face, s: &str, size: f32, x: f32, baseline: f32, c: [u8; 3]| {
        draw_text(pm, face, s, size * u, 0.0, x * u, baseline * u, c);
    };
    let centered = |pm: &mut Pixmap, face: &Face, s: &str, size: f32, cx: f32, baseline: f32, c: [u8; 3]| {
        draw_text_centered(pm, face, s, size * u, 0.0, cx * u, baseline * u, c);
    };
    let fit = |face: &Face, s: &str, size: f32, max: f32| ellipsize(face, s, size * u, max * u);

    // Status bar.
    centered(&mut pm, &f.semibold, "9:41", 17.0, 62.0, 37.0, ink);
    for (i, bh) in [4.0, 6.5, 9.0, 11.5].iter().enumerate() {
        rr(&mut pm, 300.0 + i as f32 * 4.6, 35.0 - bh, 3.0, *bh, 1.0, ink);
    }
    let thin = |wd: f32| Stroke { width: wd * u, ..Default::default() };
    pm.stroke_path(&rounded_rect(342.0 * u, 24.5 * u, 25.0 * u, 12.0 * u, 3.8 * u), &solid(ink, 90), &thin(1.0), Transform::identity(), None);
    rr(&mut pm, 344.0, 26.5, 19.0, 8.0, 2.2, ink);
    rr(&mut pm, 368.5, 28.5, 1.6, 4.0, 0.8, label);

    // Back to search.
    let mut pb = PathBuilder::new();
    pb.move_to(27.0 * u, 65.0 * u);
    pb.line_to(18.0 * u, 75.0 * u);
    pb.line_to(27.0 * u, 85.0 * u);
    let chevron = pb.finish().unwrap();
    let stroke = Stroke { width: 3.0 * u, line_cap: tiny_skia::LineCap::Round, line_join: tiny_skia::LineJoin::Round, ..Default::default() };
    pm.stroke_path(&chevron, &solid(blue, 255), &stroke, Transform::identity(), None);
    text(&mut pm, &f.regular, "Search", 17.0, 33.0, 81.0, blue);

    // Icon, name, developer, Get.
    let (iy, is) = (102.0, 118.0);
    if let Some(icon) = icon {
        draw_image_cover(&mut pm, icon, 20.0 * u, iy * u, is * u, is * u, is * 0.225 * u);
    }
    pm.stroke_path(&rounded_rect(20.0 * u, iy * u, is * u, is * u, is * 0.225 * u), &solid(ink, 26), &thin(0.6), Transform::identity(), None);
    let tx = 154.0;
    let tw = 393.0 - tx - 20.0;
    let mut name = greedy_wrap(&f.bold, p.app.track_name.trim(), 22.0 * u, tw * u);
    if name.len() > 2 {
        let rest = name[1..].join(" ");
        name = vec![name[0].clone(), fit(&f.bold, &rest, 22.0, tw)];
    }
    let mut y = iy + 24.0;
    for l in &name {
        text(&mut pm, &f.bold, l, 22.0, tx, y, ink);
        y += 26.0;
    }
    let dev = p.app.artist_name.trim();
    if !dev.is_empty() {
        text(&mut pm, &f.regular, &fit(&f.regular, dev, 15.0, tw), 15.0, tx, y - 4.0, label);
    }
    let price = match p.app.formatted_price.as_deref().map(str::trim) {
        Some(pr) if !pr.is_empty() && !pr.eq_ignore_ascii_case("free") && !pr.starts_with('0') && !pr.ends_with("0.00") => pr.to_string(),
        _ => "Get".to_string(),
    };
    let bw = (text_width(&f.bold, &price, 16.0 * u, 0.0) / u + 34.0).max(74.0);
    let by = iy + is - 30.0;
    rr(&mut pm, tx, by, bw, 30.0, 15.0, blue);
    centered(&mut pm, &f.bold, &price, 16.0, tx + bw / 2.0, by + 20.5, [255, 255, 255]);

    // Ratings, category, developer.
    let hair = |pm: &mut Pixmap, x: f32, y: f32, hw: f32, hh: f32| {
        let r = tiny_skia::Rect::from_xywh(x * u, y * u, (hw * u).max(1.5), (hh * u).max(1.5)).unwrap();
        pm.fill_rect(r, &solid(rule, 255), Transform::identity(), None);
    };
    hair(&mut pm, 20.0, 238.0, 353.0, 0.0);
    let col = 353.0 / 3.0;
    for i in 1..3 {
        hair(&mut pm, 20.0 + col * i as f32, 252.0, 0.0, 52.0);
    }
    let cx = |i: usize| 20.0 + col * (i as f32 + 0.5);
    let small = |pm: &mut Pixmap, s: &str, i: usize| {
        draw_text_centered(pm, &f.semibold, &s.to_uppercase(), 11.0 * u, 0.04, cx(i) * u, 262.0 * u, label);
    };
    let rated = p.app.user_rating_count >= 5 && p.app.average_user_rating > 0.0;
    small(&mut pm, &if rated { format!("{} ratings", short_count(p.app.user_rating_count)) } else { "Ratings".into() }, 0);
    if rated {
        centered(&mut pm, &f.bold, &format!("{:.1}", p.app.average_user_rating), 20.0, cx(0), 288.0, value);
        let full = p.app.average_user_rating.round() as usize;
        for k in 0..5 {
            let star = star_path((cx(0) - 26.0 + k as f32 * 13.0) * u, 299.0 * u, 5.4 * u);
            if k < full {
                pm.fill_path(&star, &solid(value, 255), FillRule::Winding, Transform::identity(), None);
            } else {
                pm.stroke_path(&star, &solid(value, 255), &thin(0.8), Transform::identity(), None);
            }
        }
    } else {
        centered(&mut pm, &f.bold, "New", 20.0, cx(0), 288.0, value);
    }
    small(&mut pm, "Category", 1);
    let genre = p.app.primary_genre_name.trim();
    centered(&mut pm, &f.bold, &fit(&f.bold, if genre.is_empty() { "Apps" } else { genre }, 16.0, col - 14.0), 16.0, cx(1), 287.0, value);
    small(&mut pm, "Developer", 2);
    centered(&mut pm, &f.semibold, &fit(&f.semibold, if dev.is_empty() { "Indie" } else { dev }, 14.0, col - 14.0), 14.0, cx(2), 287.0, value);

    // Screenshots, scrolled to this slide's.
    let top = 326.0;
    let ch = (hp - top - 100.0).clamp(240.0, 520.0);
    let mut x = 20.0;
    for shot in shots {
        if x >= 393.0 {
            break;
        }
        let aspect = shot.width() as f32 / shot.height().max(1) as f32;
        let cw = (ch * aspect).min(353.0);
        let r = (cw.min(ch) * 0.09).min(20.0);
        draw_image_cover(&mut pm, shot, x * u, top * u, cw * u, ch * u, r * u);
        pm.stroke_path(&rounded_rect(x * u, top * u, cw * u, ch * u, r * u), &solid(ink, 22), &thin(0.6), Transform::identity(), None);
        x += cw + 10.0;
    }

    // The start of the description.
    let about: String = p.app.description.split_whitespace().collect::<Vec<_>>().join(" ");
    let about = if about.is_empty() { p.overview.trim().to_string() } else { about };
    let lines = greedy_wrap(&f.regular, &about, 15.0 * u, 353.0 * u);
    let mut y = top + ch + 32.0;
    for (i, l) in lines.iter().take(2).enumerate() {
        if y > hp - 26.0 {
            break;
        }
        if i == 1 && lines.len() > 2 {
            let more = text_width(&f.regular, "more", 15.0 * u, 0.0) / u;
            text(&mut pm, &f.regular, &fit(&f.regular, &format!("{l} {}", lines[2]), 15.0, 353.0 - more - 10.0), 15.0, 20.0, y, ink);
            text(&mut pm, &f.regular, "more", 15.0, 373.0 - more, y, blue);
        } else {
            text(&mut pm, &f.regular, l, 15.0, 20.0, y, ink);
        }
        y += 20.0;
    }

    // Home indicator.
    rr(&mut pm, (393.0 - 134.0) / 2.0, hp - 13.0, 134.0, 5.0, 2.5, ink);
    pm
}

/// A light macOS window with traffic lights and a title. Returns the top of its content area.
fn mac_window(pm: &mut Pixmap, f: &Fonts, title: &str, x: f32, y: f32, w: f32, h: f32) -> f32 {
    let (r, th) = (40.0, 112.0);
    soft_shadows(pm, &[(x, y, w, h)], r, 50.0, 0.42);
    let body = rounded_rect(x, y, w, h, r);
    pm.fill_path(&body, &solid([255, 255, 255], 255), FillRule::Winding, Transform::identity(), None);
    let mut mask = Mask::new(W, H).unwrap();
    mask.fill_path(&body, FillRule::Winding, true, Transform::identity());
    let bar = tiny_skia::Rect::from_xywh(x, y, w, th).unwrap();
    pm.fill_rect(bar, &solid([0xF2, 0xF0, 0xEF], 255), Transform::identity(), Some(&mask));
    let line = tiny_skia::Rect::from_xywh(x, y + th - 2.0, w, 2.0).unwrap();
    pm.fill_rect(line, &solid([0xDD, 0xDB, 0xD9], 255), Transform::identity(), None);
    pm.stroke_path(&body, &solid([0, 0, 0], 34), &Stroke { width: 2.0, ..Default::default() }, Transform::identity(), None);
    for (i, c) in [[0xFF, 0x5F, 0x57], [0xFE, 0xBC, 0x2E], [0x28, 0xC8, 0x40]].iter().enumerate() {
        let dot = PathBuilder::from_circle(x + 58.0 + i as f32 * 68.0, y + th / 2.0, 20.0).unwrap();
        pm.fill_path(&dot, &solid(*c, 255), FillRule::Winding, Transform::identity(), None);
        pm.stroke_path(&dot, &solid([0, 0, 0], 26), &Stroke { width: 2.0, ..Default::default() }, Transform::identity(), None);
    }
    let title = title.trim();
    if !title.is_empty() {
        draw_text_centered(pm, &f.semibold, title, 44.0, -0.005, x + w / 2.0, y + th / 2.0 + 15.0, WIN_MUTED);
    }
    y + th
}

/// The hook typed into a window over the blurred desk, with a text cursor after it.
fn hook_window_slide(f: &Fonts, d: &DeskScene, s: &Spotlight, color: [u8; 3]) -> Pixmap {
    let mut pm = d.blurred.clone();
    let text = s.hook.trim();
    let (w, pad) = (1780.0, 116.0);
    let max_w = w - 2.0 * pad;
    let mut size: f32 = 150.0;
    let mut lines = greedy_wrap(&f.bold, text, size, max_w);
    while lines.len() > 5 && size > 96.0 {
        size -= 4.0;
        lines = greedy_wrap(&f.bold, text, size, max_w);
    }
    let line_h = size * 1.16;
    let h = 112.0 + pad + (lines.len() as f32 - 1.0) * line_h + size * 0.8 + pad * 1.1;
    let x = (W as f32 - w) / 2.0;
    let y = ((H as f32 - h) / 2.0 - 60.0).max(160.0);
    let top = mac_window(&mut pm, f, &s.window_title, x, y, w, h);

    let hot = hot_words(text, &s.accent);
    let space = text_width(&f.bold, " ", size, -0.02);
    let mut k = 0;
    let (mut end_x, mut end_y) = (x + pad, top + pad + size * 0.74);
    for (li, l) in lines.iter().enumerate() {
        let baseline = top + pad + size * 0.74 + li as f32 * line_h;
        let mut cx = x + pad;
        for word in l.split_whitespace() {
            let c = if hot.get(k).copied().unwrap_or(false) { color } else { WIN_INK };
            draw_text(&mut pm, &f.bold, word, size, -0.02, cx, baseline, c);
            cx += text_width(&f.bold, word, size, -0.02) + space;
            k += 1;
        }
        (end_x, end_y) = (cx - space, baseline);
    }
    let caret = tiny_skia::Rect::from_xywh(end_x + size * 0.1, end_y - size * 0.8, (size * 0.07).max(6.0), size * 0.98).unwrap();
    pm.fill_rect(caret, &solid(color, 255), Transform::identity(), None);
    pm
}

/// Every app's icon in a row in a window, with the last line under them.
fn recap_window_slide(f: &Fonts, d: &DeskScene, icons: &[Option<Pixmap>], s: &Spotlight) -> Pixmap {
    let mut pm = d.blurred.clone();
    let (w, pad) = (1780.0, 116.0);
    let present: Vec<&Pixmap> = icons.iter().flatten().collect();
    let n = present.len().max(1) as f32;
    let gap = 44.0;
    let is = ((w - 2.0 * pad - gap * (n - 1.0)) / n).min(260.0);

    let text = s.cta.trim();
    let mut size: f32 = 88.0;
    let mut lines = greedy_wrap(&f.regular, text, size, w - 2.0 * pad);
    while lines.len() > 4 && size > 64.0 {
        size -= 4.0;
        lines = greedy_wrap(&f.regular, text, size, w - 2.0 * pad);
    }
    let line_h = size * 1.22;
    let text_h = (lines.len() as f32 - 1.0) * line_h + size * 0.8;
    let icons_h = if present.is_empty() { 0.0 } else { is + 96.0 };
    let h = 112.0 + pad + icons_h + text_h + pad * 1.1;
    let x = (W as f32 - w) / 2.0;
    let y = ((H as f32 - h) / 2.0 - 60.0).max(160.0);
    let top = mac_window(&mut pm, f, &s.window_title, x, y, w, h);

    let iy = top + pad;
    let rects: Vec<(f32, f32, f32, f32)> = (0..present.len()).map(|i| (x + pad + i as f32 * (is + gap), iy, is, is)).collect();
    soft_shadows(&mut pm, &rects, is * 0.225, 14.0, 0.2);
    for (icon, r) in present.iter().zip(&rects) {
        draw_image_cover(&mut pm, icon, r.0, r.1, is, is, is * 0.225);
        pm.stroke_path(&rounded_rect(r.0, r.1, is, is, is * 0.225), &solid([0, 0, 0], 24), &Stroke { width: 2.0, ..Default::default() }, Transform::identity(), None);
    }
    let first = iy + icons_h + size * 0.76;
    for (i, l) in lines.iter().enumerate() {
        draw_text(&mut pm, &f.regular, l, size, -0.015, x + pad, first + i as f32 * line_h, WIN_INK);
    }
    pm
}

/// The app's icon, name and a Get button in a window, with the last line under them.
fn cta_window_slide(f: &Fonts, d: &DeskScene, p: &PreparedApp, icon: Option<&Pixmap>, s: &Spotlight, color: [u8; 3]) -> Pixmap {
    let mut pm = d.blurred.clone();
    let (w, pad, is) = (1780.0, 116.0, 300.0);
    let side = pad + is + 64.0;
    let name = display_name(&p.app.track_name);
    let mut ns: f32 = 104.0;
    while text_width(&f.bold, &name, ns, -0.02) > w - side - pad && ns > 60.0 {
        ns -= 4.0;
    }
    let genre = p.app.primary_genre_name.trim();
    let sub = if p.app.user_rating_count >= 20 && p.app.average_user_rating > 0.0 {
        format!("{:.1} rating · {genre}", p.app.average_user_rating)
    } else {
        genre.to_string()
    };

    let text = s.cta.trim();
    let mut size: f32 = 88.0;
    let mut lines = greedy_wrap(&f.regular, text, size, w - 2.0 * pad);
    while lines.len() > 4 && size > 64.0 {
        size -= 4.0;
        lines = greedy_wrap(&f.regular, text, size, w - 2.0 * pad);
    }
    let line_h = size * 1.22;
    let text_h = (lines.len() as f32 - 1.0) * line_h + size * 0.8;
    let h = 112.0 + pad + is + 96.0 + text_h + pad * 1.1;
    let x = (W as f32 - w) / 2.0;
    let y = ((H as f32 - h) / 2.0 - 60.0).max(160.0);
    let top = mac_window(&mut pm, f, &s.window_title, x, y, w, h);

    let (ix, iy) = (x + pad, top + pad);
    if let Some(icon) = icon {
        soft_shadows(&mut pm, &[(ix, iy, is, is)], is * 0.225, 16.0, 0.22);
        draw_image_cover(&mut pm, icon, ix, iy, is, is, is * 0.225);
    }
    pm.stroke_path(&rounded_rect(ix, iy, is, is, is * 0.225), &solid([0, 0, 0], 24), &Stroke { width: 2.0, ..Default::default() }, Transform::identity(), None);
    draw_text(&mut pm, &f.bold, &name, ns, -0.02, x + side, iy + 104.0, WIN_INK);
    if !sub.is_empty() {
        draw_text(&mut pm, &f.regular, &sub, 54.0, -0.005, x + side, iy + 184.0, WIN_MUTED);
    }
    let (bw, bh) = (236.0, 92.0);
    let (bx, by) = (x + side, iy + is - bh);
    pm.fill_path(&rounded_rect(bx, by, bw, bh, bh / 2.0), &solid(color, 255), FillRule::Winding, Transform::identity(), None);
    draw_text_centered(&mut pm, &f.bold, "Get", 52.0, -0.01, bx + bw / 2.0, by + bh / 2.0 + 19.0, [255, 255, 255]);

    let first = iy + is + 96.0 + size * 0.76;
    for (i, l) in lines.iter().enumerate() {
        draw_text(&mut pm, &f.regular, l, size, -0.015, x + pad, first + i as f32 * line_h, WIN_INK);
    }
    pm
}

// ---------------------------------------------------------------------------
// Phone mockup (drawn flat, warped later)
// ---------------------------------------------------------------------------

const PW: u32 = 1300;
const PH: u32 = 2700;

fn phone_mockup(pal: &Palette, icons: &[Option<Pixmap>]) -> Pixmap {
    let mut pm = Pixmap::new(PW, PH).unwrap();
    let (w, h) = (PW as f32, PH as f32);

    // Titanium rim with a soft vertical sheen.
    let rim = rounded_rect(0.0, 0.0, w, h, 215.0);
    let mut paint = Paint::default();
    paint.anti_alias = true;
    paint.shader = LinearGradient::new(
        Point::from_xy(0.0, 0.0),
        Point::from_xy(w, 0.0),
        vec![
            GradientStop::new(0.0, rgb(0x8C, 0x8D, 0x92)),
            GradientStop::new(0.08, rgb(0xD6, 0xD7, 0xDB)),
            GradientStop::new(0.5, rgb(0xA9, 0xAA, 0xAF)),
            GradientStop::new(0.92, rgb(0xD0, 0xD1, 0xD5)),
            GradientStop::new(1.0, rgb(0x7E, 0x7F, 0x84)),
        ],
        SpreadMode::Pad,
        Transform::identity(),
    )
    .unwrap();
    pm.fill_path(&rim, &paint, FillRule::Winding, Transform::identity(), None);

    // Black bezel.
    let bezel = rounded_rect(9.0, 9.0, w - 18.0, h - 18.0, 206.0);
    pm.fill_path(&bezel, &solid([0x0B, 0x0B, 0x0D], 255), FillRule::Winding, Transform::identity(), None);

    // Screen: light wallpaper so coloured icons pop.
    let (sx, sy) = (44.0, 44.0);
    let (sw, sh) = (w - 2.0 * sx, h - 2.0 * sy);
    let screen = rounded_rect(sx, sy, sw, sh, 172.0);
    let mut paint = Paint::default();
    paint.anti_alias = true;
    paint.shader = LinearGradient::new(
        Point::from_xy(0.0, sy),
        Point::from_xy(0.0, sy + sh),
        vec![
            GradientStop::new(0.0, rgb(pal.wall_top[0], pal.wall_top[1], pal.wall_top[2])),
            GradientStop::new(0.45, rgb(pal.wall_mid[0], pal.wall_mid[1], pal.wall_mid[2])),
            GradientStop::new(1.0, rgb(pal.wall_bottom[0], pal.wall_bottom[1], pal.wall_bottom[2])),
        ],
        SpreadMode::Pad,
        Transform::identity(),
    )
    .unwrap();
    pm.fill_path(&screen, &paint, FillRule::Winding, Transform::identity(), None);

    // Dynamic Island with a camera lens.
    let (iw, ih) = (372.0, 108.0);
    let island = rounded_rect((w - iw) / 2.0, sy + 54.0, iw, ih, ih / 2.0);
    pm.fill_path(&island, &solid([0, 0, 0], 255), FillRule::Winding, Transform::identity(), None);
    let lens = PathBuilder::from_circle(w / 2.0 + iw / 2.0 - 58.0, sy + 54.0 + ih / 2.0, 20.0).unwrap();
    pm.fill_path(&lens, &solid([0x1C, 0x22, 0x33], 255), FillRule::Winding, Transform::identity(), None);

    // 3x2 icon grid.
    let s = 322.0;
    let gx = (sw - 3.0 * s) / 4.0;
    let top = sy + 330.0;
    let gy = 78.0;
    let mut rects = Vec::new();
    for (i, icon) in icons.iter().take(6).enumerate() {
        if icon.is_none() {
            continue;
        }
        let (col, row) = ((i % 3) as f32, (i / 3) as f32);
        rects.push((sx + gx + col * (s + gx), top + row * (s + gy), s, s));
    }
    soft_shadows(&mut pm, &rects, s * 0.225, 26.0, 0.28);
    let mut r = rects.iter();
    for icon in icons.iter().take(6).flatten() {
        if let Some(&(x, y, w, h)) = r.next() {
            draw_image_cover(&mut pm, icon, x, y, w, h, s * 0.225);
        }
    }

    // Faint glass highlight across the top-left of the screen.
    let mut paint = Paint::default();
    paint.anti_alias = true;
    paint.shader = LinearGradient::new(
        Point::from_xy(sx, sy),
        Point::from_xy(sx + sw * 0.7, sy + sh * 0.35),
        vec![
            GradientStop::new(0.0, Color::from_rgba8(255, 255, 255, 60)),
            GradientStop::new(1.0, Color::from_rgba8(255, 255, 255, 0)),
        ],
        SpreadMode::Pad,
        Transform::identity(),
    )
    .unwrap();
    pm.fill_path(&screen, &paint, FillRule::Winding, Transform::identity(), None);
    pm
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

struct GlyphPath<'a> {
    pb: &'a mut PathBuilder,
    scale: f32,
    x: f32,
    y: f32,
}

impl OutlineBuilder for GlyphPath<'_> {
    fn move_to(&mut self, x: f32, y: f32) {
        self.pb.move_to(self.x + x * self.scale, self.y - y * self.scale);
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.pb.line_to(self.x + x * self.scale, self.y - y * self.scale);
    }
    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        self.pb.quad_to(self.x + x1 * self.scale, self.y - y1 * self.scale, self.x + x * self.scale, self.y - y * self.scale);
    }
    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        self.pb.cubic_to(
            self.x + x1 * self.scale,
            self.y - y1 * self.scale,
            self.x + x2 * self.scale,
            self.y - y2 * self.scale,
            self.x + x * self.scale,
            self.y - y * self.scale,
        );
    }
    fn close(&mut self) {
        self.pb.close();
    }
}

/// Shapes `text` and returns (glyph id, x offset px, y offset px) plus total advance.
fn shape(face: &Face, text: &str, size: f32, tracking_em: f32) -> (Vec<(u16, f32, f32)>, f32) {
    let mut buf = UnicodeBuffer::new();
    buf.push_str(text);
    let out = rustybuzz::shape(face, &[], buf);
    let scale = size / face.units_per_em() as f32;
    let track = tracking_em * size;
    let mut x = 0.0;
    let mut glyphs = Vec::with_capacity(out.len());
    for (info, pos) in out.glyph_infos().iter().zip(out.glyph_positions()) {
        glyphs.push((info.glyph_id as u16, x + pos.x_offset as f32 * scale, pos.y_offset as f32 * scale));
        x += pos.x_advance as f32 * scale + track;
    }
    let width = if glyphs.is_empty() { 0.0 } else { x - track };
    (glyphs, width)
}

fn text_width(face: &Face, text: &str, size: f32, tracking_em: f32) -> f32 {
    shape(face, text, size, tracking_em).1
}

fn draw_text(pm: &mut Pixmap, face: &Face, text: &str, size: f32, tracking_em: f32, x: f32, baseline: f32, color: [u8; 3]) {
    let (glyphs, _) = shape(face, text, size, tracking_em);
    let scale = size / face.units_per_em() as f32;
    let mut pb = PathBuilder::new();
    for (gid, gx, gy) in glyphs {
        let mut gp = GlyphPath { pb: &mut pb, scale, x: x + gx, y: baseline - gy };
        let _ = face.outline_glyph(GlyphId(gid), &mut gp);
    }
    if let Some(path) = pb.finish() {
        pm.fill_path(&path, &solid(color, 255), FillRule::Winding, Transform::identity(), None);
    }
}

fn draw_text_centered(pm: &mut Pixmap, face: &Face, text: &str, size: f32, tracking_em: f32, cx: f32, baseline: f32, color: [u8; 3]) {
    let w = text_width(face, text, size, tracking_em);
    draw_text(pm, face, text, size, tracking_em, cx - w / 2.0, baseline, color);
}

fn greedy_wrap(face: &Face, text: &str, size: f32, max_w: f32) -> Vec<String> {
    let mut lines = Vec::new();
    let mut cur = String::new();
    for word in text.split_whitespace() {
        let candidate = if cur.is_empty() { word.to_string() } else { format!("{cur} {word}") };
        if !cur.is_empty() && text_width(face, &candidate, size, 0.0) > max_w {
            lines.push(std::mem::take(&mut cur));
            cur = word.to_string();
        } else {
            cur = candidate;
        }
    }
    if !cur.is_empty() {
        lines.push(cur);
    }
    lines
}

/// Greedy wrap, then narrow the measure as far as possible without adding a line,
/// so lines come out evenly balanced like the reference slides.
fn balanced_wrap(face: &Face, text: &str, size: f32, max_w: f32) -> Vec<String> {
    let target = greedy_wrap(face, text, size, max_w);
    let (mut lo, mut hi) = (max_w * 0.5, max_w);
    for _ in 0..14 {
        let mid = (lo + hi) / 2.0;
        if greedy_wrap(face, text, size, mid).len() <= target.len() {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    greedy_wrap(face, text, size, hi)
}

/// App Store names are often "Name: long subtitle" or "Name - tagline"; slides use the short name.
fn display_name(name: &str) -> String {
    let short = name.split([':', '|', '–', '—']).next().unwrap_or(name);
    let short = short.split(" - ").next().unwrap_or(short).trim();
    if short.is_empty() { name.trim().to_string() } else { short.to_string() }
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

fn rgb(r: u8, g: u8, b: u8) -> Color {
    Color::from_rgba8(r, g, b, 255)
}

fn solid(c: [u8; 3], a: u8) -> Paint<'static> {
    let mut p = Paint::default();
    p.set_color_rgba8(c[0], c[1], c[2], a);
    p.anti_alias = true;
    p
}

fn rounded_rect(x: f32, y: f32, w: f32, h: f32, r: f32) -> SkPath {
    let r = r.min(w / 2.0).min(h / 2.0);
    let k = 0.552_284_8 * r;
    let mut pb = PathBuilder::new();
    pb.move_to(x + r, y);
    pb.line_to(x + w - r, y);
    pb.cubic_to(x + w - r + k, y, x + w, y + r - k, x + w, y + r);
    pb.line_to(x + w, y + h - r);
    pb.cubic_to(x + w, y + h - r + k, x + w - r + k, y + h, x + w - r, y + h);
    pb.line_to(x + r, y + h);
    pb.cubic_to(x + r - k, y + h, x, y + h - r + k, x, y + h - r);
    pb.line_to(x, y + r);
    pb.cubic_to(x, y + r - k, x + r - k, y, x + r, y);
    pb.close();
    pb.finish().unwrap()
}

/// Draws `img` scaled to cover the rect, clipped to a rounded rect.
fn draw_image_cover(pm: &mut Pixmap, img: &Pixmap, x: f32, y: f32, w: f32, h: f32, radius: f32) {
    let (iw, ih) = (img.width() as f32, img.height() as f32);
    let s = (w / iw).max(h / ih);
    let (dw, dh) = (iw * s, ih * s);
    let tx = x + (w - dw) / 2.0;
    let ty = y + (h - dh) / 2.0;
    let mut mask = Mask::new(pm.width(), pm.height()).unwrap();
    mask.fill_path(&rounded_rect(x, y, w, h, radius), FillRule::Winding, true, Transform::identity());
    let paint = PixmapPaint { quality: tiny_skia::FilterQuality::Bicubic, ..Default::default() };
    pm.draw_pixmap(0, 0, img.as_ref(), &paint, Transform::from_row(s, 0.0, 0.0, s, tx, ty), Some(&mask));
}

/// Blurred rounded-rect shadows below each rect (rendered at quarter resolution).
fn soft_shadows(pm: &mut Pixmap, rects: &[(f32, f32, f32, f32)], radius: f32, offset_y: f32, opacity: f32) {
    if rects.is_empty() {
        return;
    }
    let q = 4.0;
    let mut sh = Pixmap::new((pm.width() as f32 / q).ceil() as u32, (pm.height() as f32 / q).ceil() as u32).unwrap();
    for &(x, y, w, h) in rects {
        let p = rounded_rect((x + w * 0.06) / q, (y + offset_y) / q, (w * 0.88) / q, h / q, radius / q);
        sh.fill_path(&p, &solid([0, 0, 0], 255), FillRule::Winding, Transform::identity(), None);
    }
    box_blur(&mut sh, 7, 3);
    let paint = PixmapPaint { opacity, quality: tiny_skia::FilterQuality::Bilinear, ..Default::default() };
    pm.draw_pixmap(0, 0, sh.as_ref(), &paint, Transform::from_scale(q, q), None);
}

/// Shadow under the warped phone.
fn drop_shadow(pm: &mut Pixmap, quad: &[(f32, f32); 4], offset: (f32, f32), opacity: f32) {
    let q = 4.0;
    let mut sh = Pixmap::new(W / 4, H / 4).unwrap();
    let mut pb = PathBuilder::new();
    pb.move_to((quad[0].0 + offset.0) / q, (quad[0].1 + offset.1 + 40.0) / q);
    for p in &quad[1..] {
        pb.line_to((p.0 + offset.0) / q, (p.1 + offset.1) / q);
    }
    pb.close();
    sh.fill_path(&pb.finish().unwrap(), &solid([0x10, 0x14, 0x1A], 255), FillRule::Winding, Transform::identity(), None);
    box_blur(&mut sh, 16, 3);
    let paint = PixmapPaint { opacity, quality: tiny_skia::FilterQuality::Bilinear, ..Default::default() };
    pm.draw_pixmap(0, 0, sh.as_ref(), &paint, Transform::from_scale(q, q), None);
}

/// Repeated separable box blur on premultiplied RGBA (approximates a Gaussian). Outside the
/// image counts as transparent, which suits shadows.
fn box_blur(pm: &mut Pixmap, radius: usize, passes: usize) {
    blur_passes(pm, radius, passes, false);
}

/// Like `box_blur`, but repeats the edge pixels, so a photo doesn't darken at its borders.
fn box_blur_clamped(pm: &mut Pixmap, radius: usize, passes: usize) {
    blur_passes(pm, radius, passes, true);
}

fn blur_passes(pm: &mut Pixmap, radius: usize, passes: usize, clamp: bool) {
    let (w, h) = (pm.width() as usize, pm.height() as usize);
    let data = pm.data_mut();
    let mut tmp = vec![0u8; data.len()];
    for _ in 0..passes {
        blur_1d(data, &mut tmp, w, h, radius, true, clamp);
        blur_1d(&tmp, data, w, h, radius, false, clamp);
    }
}

fn blur_1d(src: &[u8], dst: &mut [u8], w: usize, h: usize, r: usize, horizontal: bool, clamp: bool) {
    let (outer, inner) = if horizontal { (h, w) } else { (w, h) };
    let idx = |o: usize, i: usize| if horizontal { (o * w + i) * 4 } else { (i * w + o) * 4 };
    let win = (2 * r + 1) as u32;
    // A sample at position i (which may be off either end) of this row or column.
    let px = |o: usize, i: isize, c: usize| -> u32 {
        if i < 0 || i >= inner as isize {
            if !clamp {
                return 0;
            }
            return src[idx(o, i.clamp(0, inner as isize - 1) as usize) + c] as u32;
        }
        src[idx(o, i as usize) + c] as u32
    };
    for o in 0..outer {
        let mut acc = [0u32; 4];
        for k in -(r as isize)..=(r as isize) {
            for c in 0..4 {
                acc[c] += px(o, k, c);
            }
        }
        for i in 0..inner {
            let p = idx(o, i);
            for c in 0..4 {
                dst[p + c] = (acc[c] / win) as u8;
                acc[c] += px(o, i as isize + r as isize + 1, c);
                acc[c] -= px(o, i as isize - r as isize, c);
            }
        }
    }
}

/// Composites `src` onto `dst` mapped to the destination quad (TL, TR, BR, BL)
/// with a projective transform and bilinear sampling.
fn warp_onto(dst: &mut Pixmap, src: &Pixmap, quad: &[(f32, f32); 4]) {
    let (sw, sh) = (src.width() as f32, src.height() as f32);
    let src_pts = [(0.0, 0.0), (sw, 0.0), (sw, sh), (0.0, sh)];
    // Inverse mapping: destination pixel -> source coordinate.
    let hm = homography(quad, &src_pts);

    let (dw, dh) = (dst.width() as i32, dst.height() as i32);
    let min_x = quad.iter().map(|p| p.0).fold(f32::MAX, f32::min).floor().max(0.0) as i32;
    let max_x = quad.iter().map(|p| p.0).fold(f32::MIN, f32::max).ceil().min(dw as f32) as i32;
    let min_y = quad.iter().map(|p| p.1).fold(f32::MAX, f32::min).floor().max(0.0) as i32;
    let max_y = quad.iter().map(|p| p.1).fold(f32::MIN, f32::max).ceil().min(dh as f32) as i32;

    let s = src.data();
    let (siw, sih) = (src.width() as i32, src.height() as i32);
    let texel = |x: i32, y: i32| -> [f32; 4] {
        if x < 0 || y < 0 || x >= siw || y >= sih {
            return [0.0; 4];
        }
        let p = ((y * siw + x) * 4) as usize;
        [s[p] as f32, s[p + 1] as f32, s[p + 2] as f32, s[p + 3] as f32]
    };

    let d = dst.data_mut();
    for y in min_y..max_y {
        for x in min_x..max_x {
            let (fx, fy) = (x as f64 + 0.5, y as f64 + 0.5);
            let wz = hm[6] * fx + hm[7] * fy + 1.0;
            let u = ((hm[0] * fx + hm[1] * fy + hm[2]) / wz) as f32 - 0.5;
            let v = ((hm[3] * fx + hm[4] * fy + hm[5]) / wz) as f32 - 0.5;
            if u < -1.0 || v < -1.0 || u > sw || v > sh {
                continue;
            }
            let (x0, y0) = (u.floor() as i32, v.floor() as i32);
            let (ax, ay) = (u - x0 as f32, v - y0 as f32);
            let (c00, c10, c01, c11) = (texel(x0, y0), texel(x0 + 1, y0), texel(x0, y0 + 1), texel(x0 + 1, y0 + 1));
            let mut c = [0.0f32; 4];
            for k in 0..4 {
                c[k] = (c00[k] * (1.0 - ax) + c10[k] * ax) * (1.0 - ay) + (c01[k] * (1.0 - ax) + c11[k] * ax) * ay;
            }
            if c[3] <= 0.5 {
                continue;
            }
            let p = ((y * dw + x) * 4) as usize;
            let inv = 1.0 - c[3] / 255.0;
            for k in 0..4 {
                d[p + k] = (c[k] + d[p + k] as f32 * inv).round().clamp(0.0, 255.0) as u8;
            }
        }
    }
}

/// Solves the 3x3 homography (h33 = 1) mapping `from[i]` -> `to[i]`.
fn homography(from: &[(f32, f32); 4], to: &[(f32, f32); 4]) -> [f64; 8] {
    let mut a = [[0f64; 9]; 8];
    for i in 0..4 {
        let (x, y) = (from[i].0 as f64, from[i].1 as f64);
        let (u, v) = (to[i].0 as f64, to[i].1 as f64);
        a[2 * i] = [x, y, 1.0, 0.0, 0.0, 0.0, -x * u, -y * u, u];
        a[2 * i + 1] = [0.0, 0.0, 0.0, x, y, 1.0, -x * v, -y * v, v];
    }
    // Gaussian elimination with partial pivoting.
    for col in 0..8 {
        let piv = (col..8).max_by(|&i, &j| a[i][col].abs().total_cmp(&a[j][col].abs())).unwrap();
        a.swap(col, piv);
        for row in 0..8 {
            if row != col {
                let f = a[row][col] / a[col][col];
                for k in col..9 {
                    a[row][k] -= f * a[col][k];
                }
            }
        }
    }
    let mut h = [0f64; 8];
    for i in 0..8 {
        h[i] = a[i][8] / a[i][i];
    }
    h
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

fn load_pixmap(path: &Path) -> Result<Pixmap> {
    let img = image::open(path).with_context(|| format!("couldn't open {}", path.display()))?.to_rgba8();
    let (w, h) = img.dimensions();
    let mut data = img.into_raw();
    for px in data.chunks_exact_mut(4) {
        let a = px[3] as u16;
        for c in &mut px[..3] {
            *c = ((*c as u16 * a + 127) / 255) as u8;
        }
    }
    Pixmap::from_vec(data, tiny_skia::IntSize::from_wh(w, h).context("empty image")?).context("bad image data")
}

fn save_jpeg(pm: &Pixmap, path: &Path) -> Result<()> {
    // Canvas is always opaque, so dropping alpha is exact.
    let rgb: Vec<u8> = pm.data().chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect();
    let file = std::io::BufWriter::new(std::fs::File::create(path)?);
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(file, 92);
    enc.encode(&rgb, pm.width(), pm.height(), image::ExtendedColorType::Rgb8)?;
    Ok(())
}

/// TikTok rejects photos over 2,073,600 pixels (1920 × 1080).
const TIKTOK_MAX_PIXELS: u64 = 2_073_600;
/// TikTok's standard photo width; a 4:5 slide becomes 1080 × 1350.
const TIKTOK_WIDTH: u32 = 1080;

/// A slide as JPEG bytes small enough for TikTok. Slides stay full size on disk; only the
/// uploaded copy is scaled down.
pub fn tiktok_jpeg(path: &Path) -> Result<Vec<u8>> {
    let img = image::open(path).with_context(|| format!("Couldn't open {}", path.display()))?.to_rgb8();
    let (w, h) = img.dimensions();
    let img = if u64::from(w) * u64::from(h) > TIKTOK_MAX_PIXELS {
        let mut nw = TIKTOK_WIDTH;
        let mut nh = (f64::from(h) * f64::from(nw) / f64::from(w)).round() as u32;
        // Very tall images: fit by area instead.
        if u64::from(nw) * u64::from(nh) > TIKTOK_MAX_PIXELS {
            let s = (TIKTOK_MAX_PIXELS as f64 / (f64::from(w) * f64::from(h))).sqrt();
            nw = (f64::from(w) * s).floor() as u32;
            nh = (f64::from(h) * s).floor() as u32;
        }
        image::imageops::resize(&img, nw, nh, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 92).encode(
        img.as_raw(),
        img.width(),
        img.height(),
        image::ExtendedColorType::Rgb8,
    )?;
    Ok(out)
}

pub fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
        if out.len() >= 32 {
            break;
        }
    }
    out.trim_matches('-').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiktok_copy_fits_the_pixel_limit() {
        let path = std::env::temp_dir().join("openugc-tiktok-test.jpg");
        image::RgbImage::from_pixel(W, H, image::Rgb([200, 100, 50])).save(&path).unwrap();
        let out = image::load_from_memory(&tiktok_jpeg(&path).unwrap()).unwrap();
        assert_eq!((out.width(), out.height()), (1080, 1350));
        assert!(u64::from(out.width()) * u64::from(out.height()) <= TIKTOK_MAX_PIXELS);
        let _ = std::fs::remove_file(path);
    }

    /// A stand-in desk photo: warm wall and desk, a dark phone with a slightly skewed green
    /// screen and soft green-tinted edges, plus a green-ish (but not chroma) object to ignore.
    fn fake_desk() -> image::RgbImage {
        let (w, h) = (1024u32, 1536u32);
        let quad = [(392.0f32, 690.0f32), (636.0, 684.0), (642.0, 1198.0), (388.0, 1204.0)];
        let inside = |x: f32, y: f32, q: &[(f32, f32); 4]| {
            (0..4).all(|i| {
                let (a, b) = (q[i], q[(i + 1) % 4]);
                (b.0 - a.0) * (y - a.1) - (b.1 - a.1) * (x - a.0) >= 0.0
            })
        };
        let grow = |q: &[(f32, f32); 4], d: f32| [(q[0].0 - d, q[0].1 - d), (q[1].0 + d, q[1].1 - d), (q[2].0 + d, q[2].1 + d), (q[3].0 - d, q[3].1 + d)];
        let bezel = grow(&quad, 14.0);
        image::RgbImage::from_fn(w, h, |x, y| {
            let (fx, fy) = (x as f32 + 0.5, y as f32 + 0.5);
            if inside(fx, fy, &quad) {
                image::Rgb([20, 235, 40])
            } else if inside(fx, fy, &grow(&quad, 1.5)) {
                image::Rgb([60, 150, 60])
            } else if inside(fx, fy, &bezel) {
                image::Rgb([18, 18, 20])
            } else if (120..260).contains(&x) && (1000..1180).contains(&y) {
                image::Rgb([70, 120, 60])
            } else if y > 1150 {
                image::Rgb([196, 160, 120])
            } else {
                let t = y as f32 / 1150.0;
                image::Rgb([(238.0 - 20.0 * t) as u8, (230.0 - 22.0 * t) as u8, (218.0 - 26.0 * t) as u8])
            }
        })
    }

    #[test]
    fn finds_the_green_screen() {
        let s = find_screen(&fake_desk()).expect("screen");
        let want = [(392.0, 690.0), (636.0, 684.0), (642.0, 1198.0), (388.0, 1204.0)];
        for (got, want) in s.quad.iter().zip(want) {
            assert!((got.0 - want.0).abs() < 4.0 && (got.1 - want.1).abs() < 4.0, "{got:?} vs {want:?}");
        }
        assert_eq!(s.alpha.get_pixel(515, 940).0[0], 255);
        assert_eq!(s.alpha.get_pixel(150, 1100).0[0], 0, "the muted green object isn't screen");
        assert!(find_screen(&image::RgbImage::from_pixel(400, 600, image::Rgb([200, 190, 180]))).is_none());
    }

    /// Renders a spotlight slideshow for the first prepared app, on the desk photo at
    /// $OPENUGC_DESK or a stand-in: `cargo test render_spotlight_sample -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn render_spotlight_sample() {
        let appdata = std::env::var("APPDATA").expect("APPDATA");
        let state: serde_json::Value =
            serde_json::from_slice(&std::fs::read(Path::new(&appdata).join("com.openugc.OpenUGC/state.json")).unwrap()).unwrap();
        let apps: Vec<PreparedApp> = serde_json::from_value(state["prepared"].clone()).unwrap();
        // Up to three apps with screenshots: the spotlight shows each on its own slide.
        let picked: Vec<PreparedApp> = apps.iter().filter(|a| !a.screenshots.is_empty()).take(3).cloned().collect();
        assert!(!picked.is_empty(), "a prepared app with screenshots");
        let out = std::env::temp_dir().join("openugc-spotlight-test");
        std::fs::create_dir_all(&out).unwrap();
        let desk = match std::env::var("OPENUGC_DESK") {
            Ok(p) => PathBuf::from(p),
            Err(_) => {
                let p = out.join("fake-desk.png");
                fake_desk().save(&p).unwrap();
                p
            }
        };
        let texts = ["write a letter like it's 1999", "it arrives days later, like real mail", "collect stamps from everywhere your friends live"];
        let s = Spotlight {
            hook: "apps that finally got me writing to friends again".into(),
            accent: "writing to friends".into(),
            lines: picked.iter().enumerate().map(|(i, _)| SpotLine { text: texts[i].into(), shot: 0, image: None }).collect(),
            cta: "they're all on the app store, save this for your next slow sunday".into(),
            ..Default::default()
        };
        let t = std::time::Instant::now();
        let r = render_spotlight(&picked, &s, &desk, None, &out).unwrap();
        println!("rendered {} slides to {} in {:?}", r.slides.len(), r.dir.display(), t.elapsed());
        // The same desk with its screen marked by hand instead (slightly off, like real clicks).
        let marked = [(394.0, 692.0), (634.0, 686.0), (640.0, 1196.0), (390.0, 1202.0)];
        let r = render_spotlight(&picked[..1], &s, &desk, Some(marked), &out.join("marked")).unwrap();
        println!("rendered {} marked slides to {}", r.slides.len(), r.dir.display());
    }

    /// Renders a relatable-drawings slideshow from a drawing at $OPENUGC_DRAWING:
    /// `cargo test render_drawn_sample -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn render_drawn_sample() {
        let src = std::env::var("OPENUGC_DRAWING").expect("OPENUGC_DRAWING");
        let out = std::env::temp_dir().join("openugc-drawn-test");
        let img = crate::drawn::clean_drawing(&image::open(&src).unwrap()).unwrap();
        let clean = out.join("drawing.png");
        std::fs::create_dir_all(&out).unwrap();
        img.save(&clean).unwrap();
        let s = |text: &str| DrawnSlide { text: text.into(), scene: String::new(), image: Some(clean.clone()) };
        let slides = vec![
            s("Hidden signs of loneliness"),
            s("Struggling to believe that people genuinely enjoy your presence"),
            s("You're very good at hiding your emotions, so no one knows you're not okay because you don't seem like someone who's mentally struggling"),
            DrawnSlide { text: "You feel like no one really knows you".into(), ..Default::default() },
        ];
        let plug = s("Penpal helped me feel less alone: you write letters to people who actually write back.");
        let r = render_drawn(&slides, "loneliness", Some((&plug, PlugApp { name: "Penpal: Slow Letters", icon: None })), &DrawnStyle::default(), &out).unwrap();
        println!("rendered {} slides to {}", r.slides.len(), r.dir.display());
    }

    /// Renders a slideshow from the sample apps prepared in the app's data folder:
    /// `cargo test render_sample -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn render_sample() {
        let appdata = std::env::var("APPDATA").expect("APPDATA");
        let state: serde_json::Value =
            serde_json::from_slice(&std::fs::read(Path::new(&appdata).join("com.openugc.OpenUGC/state.json")).unwrap()).unwrap();
        let apps: Vec<PreparedApp> = serde_json::from_value(state["prepared"].clone()).unwrap();
        let out = std::env::temp_dir().join("openugc-slides-test");
        let t = std::time::Instant::now();
        let r = render_slideshow(&apps, &SlideOptions::default(), &out).unwrap();
        println!("rendered {} slides to {} in {:?}", r.slides.len(), r.dir.display(), t.elapsed());
    }
}
