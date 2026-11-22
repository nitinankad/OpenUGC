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

Rules for the caption:
- One or two short lines, under 150 characters in total.
- Casual and natural, like a real person posting. Lowercase is fine. At most one emoji.
- Hook the viewer or invite them to save the post or comment. Don't list the app names.
- No hashtags in the caption itself, no quotes, no links, no prices.

Rules for the hashtags:
- Exactly 5, relevant to the apps and the niche.
- Mix one or two broad ones people search (like appstore or iphoneapps) with specific ones for the niche.
- Lowercase letters and digits only, no spaces, no '#'.

Reply with only this JSON and nothing else:
{\"caption\": \"...\", \"hashtags\": [\"...\", \"...\", \"...\", \"...\", \"...\"]}";

fn brief(niche: &str, apps: &[PreparedApp]) -> String {
    let mut s = String::new();
    if !niche.trim().is_empty() {
        s.push_str(&format!("Niche: {}\n\n", niche.trim()));
    }
    s.push_str("Apps in the slideshow, in order:\n");
    for (i, p) in apps.iter().enumerate() {
        s.push_str(&format!("{}. {} ({}): {}\n", i + 1, p.app.track_name, p.app.primary_genre_name, p.overview));
    }
    s
}

pub fn generate_caption(niche: &str, apps: &[PreparedApp], writer: Writer) -> Result<Caption> {
    if apps.is_empty() {
        bail!("Prepare some apps first");
    }
    let prompt = brief(niche, apps);
    let raw = match writer {
        Writer::Claude => prepare::run_claude(CAPTION_INSTRUCTIONS, &prompt)?,
        Writer::Codex => prepare::run_codex(CAPTION_INSTRUCTIONS, &prompt)?,
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

    #[test]
    fn parses_fenced_reply_and_cleans_tags() {
        let raw = "```json\n{\"caption\": \" save this for later \", \"hashtags\": [\"#AppStore\", \"iphone apps\", \"appstore\", \"letters\", \"origami\", \"penpals\", \"extra\"]}\n```";
        let c = parse(raw).unwrap();
        assert_eq!(c.caption, "save this for later");
        assert_eq!(c.hashtags, vec!["appstore", "iphoneapps", "letters", "origami", "penpals"]);
        assert_eq!(post_text(&c), "save this for later\n\n#appstore #iphoneapps #letters #origami #penpals");
    }
}
