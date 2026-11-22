//! Renders TikTok slideshow images (2160x2700, 4:5) entirely in Rust:
//! text is shaped with rustybuzz and filled as vector paths with tiny-skia,
//! and the iPhone mockup is drawn flat, then perspective-warped onto the hook slide.

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
    let quad = [(720.0, 905.0), (2050.0, 785.0), (2110.0, 3730.0), (705.0, 3610.0)];
    drop_shadow(&mut pm, &quad, (46.0, 34.0), 0.42);
    warp_onto(&mut pm, &phone, &quad);

    let x = 216.0;
    let size = 190.0;
    draw_text(&mut pm, &f.bold, &o.hook_accent, size, -0.035, x, 405.0, pal.accent);
    draw_text(&mut pm, &f.regular, &o.hook_line2, size, -0.035, x, 614.0, pal.ink);
    draw_text(&mut pm, &f.regular, &o.hook_line3, size, -0.035, x, 823.0, pal.ink);
    if o.part > 0 {
        draw_text(&mut pm, &f.regular, &format!("(part {})", o.part), 128.0, -0.03, x, 1188.0, pal.ink);
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

/// Repeated separable box blur on premultiplied RGBA (approximates a Gaussian).
fn box_blur(pm: &mut Pixmap, radius: usize, passes: usize) {
    let (w, h) = (pm.width() as usize, pm.height() as usize);
    let data = pm.data_mut();
    let mut tmp = vec![0u8; data.len()];
    for _ in 0..passes {
        blur_1d(data, &mut tmp, w, h, radius, true);
        blur_1d(&tmp, data, w, h, radius, false);
    }
}

fn blur_1d(src: &[u8], dst: &mut [u8], w: usize, h: usize, r: usize, horizontal: bool) {
    let (outer, inner) = if horizontal { (h, w) } else { (w, h) };
    let idx = |o: usize, i: usize| if horizontal { (o * w + i) * 4 } else { (i * w + o) * 4 };
    let win = (2 * r + 1) as u32;
    for o in 0..outer {
        let mut acc = [0u32; 4];
        for k in 0..=r.min(inner - 1) {
            let p = idx(o, k);
            for c in 0..4 {
                acc[c] += src[p + c] as u32;
            }
        }
        for i in 0..inner {
            let p = idx(o, i);
            for c in 0..4 {
                dst[p + c] = (acc[c] / win) as u8;
            }
            if i + r + 1 < inner {
                let a = idx(o, i + r + 1);
                for c in 0..4 {
                    acc[c] += src[a + c] as u32;
                }
            }
            if i >= r {
                let s = idx(o, i - r);
                for c in 0..4 {
                    acc[c] -= src[s + c] as u32;
                }
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
