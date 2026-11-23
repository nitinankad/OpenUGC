//! "Send to phone": uploads a post's slides and a small page to R2. Opened on a phone, the page
//! saves every slide to Photos in one go (iOS share sheet) or downloads them in order (Android),
//! and has the caption ready to copy.

use crate::r2::R2;
use anyhow::{bail, Result};
use serde::Serialize;
use std::path::PathBuf;

const PAGE: &str = include_str!("phone.html");
const ROOT: &str = "phone";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhonePage {
    /// The folder in the bucket, e.g. "phone/20261122-153045-k3j9x0q2m7a1c4re".
    pub folder: String,
    pub url: String,
    /// QR code for `url`, as an inline SVG.
    pub qr: String,
}

pub struct Upload<'a> {
    pub slides: &'a [PathBuf],
    pub name: &'a str,
    pub account: &'a str,
    pub title: &'a str,
    /// Caption and hashtags, exactly as they're pasted into TikTok.
    pub caption: &'a str,
    /// The folder from an earlier send of these same slides.
    pub folder: Option<&'a str>,
    /// True for new slides (new folder, everything uploaded). False when only the caption or
    /// title changed: the page in `folder` is replaced and the slides stay.
    pub images: bool,
}

pub fn send(store: &R2, u: &Upload) -> Result<PhonePage> {
    if u.slides.is_empty() {
        bail!("Make the slides first.");
    }
    // New slides always get a new folder, because uploaded slides are cached as never changing.
    let reuse = if u.images { None } else { u.folder.filter(|f| is_our_folder(f)) };
    let folder = reuse.map_or_else(new_folder, str::to_string);
    let names: Vec<String> = (1..=u.slides.len()).map(|i| format!("{i:02}.jpg")).collect();
    if reuse.is_none() {
        for (path, name) in u.slides.iter().zip(&names) {
            // TikTok caps photos at ~2 MP, so send the 1080-wide copy (also quicker on mobile data).
            let bytes = crate::slides::tiktok_jpeg(path)?;
            // Each send of new slides gets a new folder, so these never change once uploaded.
            store.upload_bytes(&format!("{folder}/{name}"), bytes, "image/jpeg", "public, max-age=31536000, immutable")?;
        }
    }
    let html = page(u, &names);
    let url = store.upload_bytes(&format!("{folder}/index.html"), html.into_bytes(), "text/html; charset=utf-8", "no-cache")?;
    Ok(PhonePage { qr: qr_svg(&url)?, folder, url })
}

fn page(u: &Upload, names: &[String]) -> String {
    let data = serde_json::json!({
        "name": u.name,
        "account": u.account,
        "title": u.title,
        "caption": u.caption,
        "slides": names,
    });
    // Inside a <script> tag, so "</script>" in a caption must not end it early.
    let json = data.to_string().replace('<', "\\u003c");
    PAGE.replace("__DATA__", &json)
}

/// "phone/<UTC timestamp>-<16 random characters>": sorts by date in the bucket, but can't be guessed.
fn new_folder() -> String {
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    format!("{ROOT}/{stamp}-{}", random_token())
}

fn is_our_folder(f: &str) -> bool {
    f.strip_prefix(&format!("{ROOT}/"))
        .is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
}

/// 16 base-36 characters (about 82 bits). RandomState is seeded from the OS's random source.
fn random_token() -> String {
    use std::hash::{BuildHasher, Hasher};
    const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let mut out = String::with_capacity(16);
    for i in 0..2u64 {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u64(i);
        h.write_u128(nanos);
        let mut v = h.finish();
        for _ in 0..8 {
            out.push(ALPHABET[(v % 36) as usize] as char);
            v /= 36;
        }
    }
    out
}

pub fn qr_svg(url: &str) -> Result<String> {
    use qrcode::render::svg;
    let code = qrcode::QrCode::new(url.as_bytes())?;
    let svg = code
        .render::<svg::Color>()
        .min_dimensions(200, 200)
        .dark_color(svg::Color("#000000"))
        .light_color(svg::Color("#ffffff"))
        .quiet_zone(true)
        .build();
    // Drop the XML declaration so it can go straight into the page.
    Ok(match svg.find("<svg") {
        Some(i) => svg[i..].to_string(),
        None => svg,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folders_have_timestamp_then_token() {
        let f = new_folder();
        let rest = f.strip_prefix("phone/").unwrap();
        let (date, rest) = rest.split_once('-').unwrap();
        let (time, token) = rest.split_once('-').unwrap();
        assert_eq!((date.len(), time.len(), token.len()), (8, 6, 16));
        assert!(is_our_folder(&f));
        assert_ne!(f, new_folder());
        assert!(!is_our_folder("phone/../secrets"));
        assert!(!is_our_folder("other/abc"));
    }

    #[test]
    fn page_data_cannot_close_the_script_tag() {
        let slides = [PathBuf::from("a.jpg")];
        let u = Upload { slides: &slides, name: "Post 1", account: "@me", title: "", caption: "hi </script><b>", folder: None, images: true };
        let html = page(&u, &["01.jpg".into()]);
        assert!(!html.contains("hi </script>"));
        assert!(html.contains("\"slides\":[\"01.jpg\"]"));
    }

    #[test]
    fn qr_is_inline_svg() {
        let s = qr_svg("https://pub-x.r2.dev/phone/20261122-153045-abc/index.html").unwrap();
        assert!(s.starts_with("<svg"));
    }
}
