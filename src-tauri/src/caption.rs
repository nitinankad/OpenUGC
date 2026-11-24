//! TikTok caption + hashtags for a slideshow, written by the local Claude or Codex CLI.

use crate::prepare::{self, PreparedApp, Writer};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

/// TikTok allows at most 5 hashtags per post.
pub const MAX_HASHTAGS: usize = 5;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Caption {
    pub caption: String,
    /// Without the leading '#'.
    pub hashtags: Vec<String>,
}

const CAPTION_INSTRUCTIONS: &str = "\
You write the caption for a TikTok photo slideshow that shows hidden-gem iPhone apps, one app per slide.

What it's about:
- Base the caption and hashtags on the hook (the first slide's headline) and on what the apps in this slideshow have in common. That is the theme.
- One app may be marked as the creator's own. It's just one of the picks: never theme the caption or hashtags around it.
- A search term may be given as a hint. Ignore it if the apps don't match it.

Rules for the caption:
- One or two short lines, under 150 characters in total.
- Casual and natural, like a real person posting. Lowercase is fine. At most one emoji.
- Hook the viewer or invite them to save the post or comment. Don't list the app names.
- No hashtags in the caption itself, no quotes, no links, no prices.

Rules for the hashtags:
- Exactly 5, relevant to the theme of these apps.
- Mix one or two broad ones people search (like appstore or iphoneapps) with specific ones for the theme.
- Lowercase letters and digits only, no spaces, no '#'.

Reply with only this JSON and nothing else:
{\"caption\": \"...\", \"hashtags\": [\"...\", \"...\", \"...\", \"...\", \"...\"]}";

pub struct CaptionBrief<'a> {
    /// The hook slide's headline.
    pub hook: &'a str,
    /// The last search term, if any. Only a hint: it may be left over from another post.
    pub niche: &'a str,
    pub apps: &'a [PreparedApp],
    /// The creator's own app among `apps`, if it's in this slideshow.
    pub own_app_id: Option<u64>,
}

fn brief(b: &CaptionBrief) -> String {
    let mut s = String::new();
    if !b.hook.trim().is_empty() {
        s.push_str(&format!("Hook: {}\n", b.hook.trim()));
    }
    s.push_str("Apps in the slideshow, in order:\n");
    for (i, p) in b.apps.iter().enumerate() {
        let mine = if Some(p.app.track_id) == b.own_app_id { " [the creator's own app]" } else { "" };
        s.push_str(&format!("{}. {} ({}){mine}: {}\n", i + 1, p.app.track_name, p.app.primary_genre_name, p.overview));
    }
    if !b.niche.trim().is_empty() {
        s.push_str(&format!("Search term (hint only): {}\n", b.niche.trim()));
    }
    s
}

pub fn generate_caption(b: &CaptionBrief, writer: Writer) -> Result<Caption> {
    if b.apps.is_empty() {
        bail!("Prepare some apps first");
    }
    let prompt = brief(b);
    let raw = match writer {
        Writer::Claude => prepare::run_claude(CAPTION_INSTRUCTIONS, &prompt)?,
        Writer::Codex => prepare::run_codex(CAPTION_INSTRUCTIONS, &prompt)?,
    };
    parse(&raw)
}

const DRAWN_CAPTION_INSTRUCTIONS: &str = "\
You write the caption for a relatable TikTok photo slideshow: short lines about everyday struggles, each over a simple stick-figure drawing.

Rules for the caption:
- One or two short lines, under 150 characters in total.
- Casual and warm, like a real person posting. Lowercase is fine. At most one emoji.
- Invite people to save it, send it to a friend, or say in the comments which slide is them. Don't repeat the slides.
- Don't name or advertise any app. No hashtags in the caption itself, no quotes, no links.
- Never mention self-harm, suicide, eating disorders, medication or diagnosis.

Rules for the hashtags:
- Exactly 5, relevant to the topic.
- Mix one or two broad ones people search (like mentalhealth or relatable) with specific ones for the topic.
- Lowercase letters and digits only, no spaces, no '#'.

Reply with only this JSON and nothing else:
{\"caption\": \"...\", \"hashtags\": [\"...\", \"...\", \"...\", \"...\", \"...\"]}";

/// Caption for the relatable-drawings format, from its topic and slide text.
pub fn generate_drawn_caption(topic: &str, slides: &[String], writer: Writer) -> Result<Caption> {
    let lines: Vec<&str> = slides.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    if lines.is_empty() {
        bail!("Write the slides first");
    }
    let mut prompt = String::new();
    if !topic.trim().is_empty() {
        prompt.push_str(&format!("Topic: {}\n\n", topic.trim()));
    }
    prompt.push_str("Slides, in order (the first is the title):\n");
    for (i, l) in lines.iter().enumerate() {
        prompt.push_str(&format!("{}. {l}\n", i + 1));
    }
    let raw = match writer {
        Writer::Claude => prepare::run_claude(DRAWN_CAPTION_INSTRUCTIONS, &prompt)?,
        Writer::Codex => prepare::run_codex(DRAWN_CAPTION_INSTRUCTIONS, &prompt)?,
    };
    parse(&raw)
}

const SPOTLIGHT_CAPTION_INSTRUCTIONS: &str = "\
You write the caption for a TikTok photo slideshow that spotlights a few iPhone apps (sometimes one): a hook, each app's App Store page on a phone, and where to get them.

Rules for the caption:
- One or two short lines, under 150 characters in total.
- Casual and natural, like a real person sharing an app they like, not an ad. Lowercase is fine. At most one emoji.
- Invite people to save the post, try them, or say in the comments which one they'd use. You may name one app once.
- No hashtags in the caption itself, no quotes, no links, no prices.

Rules for the hashtags:
- Exactly 5, relevant to what the apps do and who they're for.
- Mix one or two broad ones people search (like appstore or iphoneapps) with specific ones.
- Lowercase letters and digits only, no spaces, no '#'.

Reply with only this JSON and nothing else:
{\"caption\": \"...\", \"hashtags\": [\"...\", \"...\", \"...\", \"...\", \"...\"]}";

/// Caption for the app-spotlight format, from the apps and the slide text.
pub fn generate_spotlight_caption(apps: &[PreparedApp], slides: &[String], writer: Writer) -> Result<Caption> {
    let mut prompt = String::from("Apps:\n");
    for a in apps {
        prompt.push_str(&format!("- {} ({}): {}\n", a.app.track_name, a.app.primary_genre_name, a.overview.trim()));
    }
    prompt.push_str("\nSlides, in order (the first is the hook):\n");
    for (i, l) in slides.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).enumerate() {
        prompt.push_str(&format!("{}. {l}\n", i + 1));
    }
    let raw = match writer {
        Writer::Claude => prepare::run_claude(SPOTLIGHT_CAPTION_INSTRUCTIONS, &prompt)?,
        Writer::Codex => prepare::run_codex(SPOTLIGHT_CAPTION_INSTRUCTIONS, &prompt)?,
    };
    parse(&raw)
}

/// Pulls the JSON object out of the reply (models sometimes wrap it in a code fence)
/// and cleans the hashtags.
fn parse(raw: &str) -> Result<Caption> {
    let (start, end) = (raw.find('{'), raw.rfind('}'));
    let json = match (start, end) {
        (Some(a), Some(b)) if a < b => &raw[a..=b],
        _ => bail!("The writer didn't return a caption. Try again."),
    };
    let mut c: Caption = serde_json::from_str(json).context("Couldn't read the caption the writer returned")?;
    c.caption = c.caption.trim().to_string();
    c.hashtags = clean_hashtags(&c.hashtags);
    Ok(c)
}

pub fn clean_hashtags(tags: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in tags {
        let tag: String = t.chars().filter(|c| c.is_alphanumeric() || *c == '_').collect::<String>().to_lowercase();
        if !tag.is_empty() && !out.contains(&tag) {
            out.push(tag);
        }
    }
    out.truncate(MAX_HASHTAGS);
    out
}

/// The text posted to TikTok: caption, blank line, hashtags.
pub fn post_text(c: &Caption) -> String {
    let tags = clean_hashtags(&c.hashtags).iter().map(|t| format!("#{t}")).collect::<Vec<_>>().join(" ");
    match (c.caption.trim().is_empty(), tags.is_empty()) {
        (_, true) => c.caption.trim().to_string(),
        (true, false) => tags,
        (false, false) => format!("{}\n\n{tags}", c.caption.trim()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prepared(id: u64, name: &str) -> PreparedApp {
        let app = serde_json::from_value(serde_json::json!({ "trackId": id, "trackName": name, "primaryGenreName": "Games" })).unwrap();
        PreparedApp { app, dir: Default::default(), icon: None, screenshots: vec![], overview: format!("{name} overview") }
    }

    #[test]
    fn brief_leads_with_hook_and_marks_own_app() {
        let apps = [prepared(1, "Cozy Farm"), prepared(2, "Penpal"), prepared(3, "Tiny Town")];
        let s = brief(&CaptionBrief { hook: "cosy games for rainy days", niche: "pen pals", apps: &apps, own_app_id: Some(2) });
        assert!(s.starts_with("Hook: cosy games for rainy days\n"));
        assert!(s.contains("2. Penpal (Games) [the creator's own app]"));
        assert!(!s.contains("Cozy Farm (Games) [the creator's"));
        assert!(s.contains("Search term (hint only): pen pals"));
        assert!(!s.contains("Niche:"));
    }

    #[test]
    fn parses_fenced_reply_and_cleans_tags() {
        let raw = "```json\n{\"caption\": \" save this for later \", \"hashtags\": [\"#AppStore\", \"iphone apps\", \"appstore\", \"letters\", \"origami\", \"penpals\", \"extra\"]}\n```";
        let c = parse(raw).unwrap();
        assert_eq!(c.caption, "save this for later");
        assert_eq!(c.hashtags, vec!["appstore", "iphoneapps", "letters", "origami", "penpals"]);
        assert_eq!(post_text(&c), "save this for later\n\n#appstore #iphoneapps #letters #origami #penpals");
    }
}
