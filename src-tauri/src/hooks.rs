//! Hook slide headlines written by the local Claude or Codex CLI, split into the slide's
//! three lines (the first is drawn in the highlight colour).

use crate::appstore::AppInfo;
use crate::prepare::{self, PreparedApp, Writer};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hook {
    pub accent: String,
    #[serde(default)]
    pub line2: String,
    #[serde(default)]
    pub line3: String,
}

const HOOK_INSTRUCTIONS: &str = "\
You write the headline for the first slide of a TikTok photo slideshow. Each following slide shows one iPhone app.

Good headlines from a creator in a different niche:
- 5 apps for a more private iphone
- 5 apps for safer browsing
- 5 underrated iphone apps
- 5 apps to setup for your parents
- 5 apps to keep on your radar

Other openings that work just as well:
- hidden gems for pen pals
- underrated apps for letter lovers
- apps nobody talks about
- your phone needs these
- the slow internet starter pack

Rules:
- Short, specific and curiosity-driven, in the same plain lowercase style. Speak to who the apps are for or what they get out of them.
- Fit the niche and the apps given. Each headline takes a different angle (an audience, a feeling, a situation, a goal, a time of year).
- Vary how headlines open. At most 2 may start with a number of apps; the rest open another way (hidden gems, underrated, a feeling, a situation, a bold claim).
- If a headline has a number, use the number of apps given.
- Never name an app. No emojis, hashtags, quotes or exclamation marks.
- Split each headline into 3 lines for the slide. Line 1 is the eye-catching part and is drawn in a highlight colour. Each line at most 16 characters. Line 2 or 3 may be empty for short headlines.
- Don't repeat any headline from the already-used list.

Reply with only this JSON and nothing else:
{\"hooks\": [{\"accent\": \"hidden gems\", \"line2\": \"for people who\", \"line3\": \"miss real mail\"}]}";

/// What the hooks should be about.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HookStyle {
    /// Broad hooks for any iPhone user, with no niche or audience.
    Generic,
    /// Every hook speaks to the niche given.
    Niche,
    /// Fit the creator's app, the apps picked and the search niche.
    #[default]
    Fit,
}

pub struct HookBrief<'a> {
    pub style: HookStyle,
    pub niche: &'a str,
    pub own_app: Option<&'a AppInfo>,
    pub apps: &'a [PreparedApp],
    pub count: usize,
    pub used: &'a [String],
    pub how_many: usize,
}

fn brief(b: &HookBrief) -> String {
    let mut s = format!("Number of apps in the slideshow: {}\n", b.count);
    let niche = b.niche.trim();
    match b.style {
        HookStyle::Generic => {
            // Leave out the niche and the apps so they don't pull the hooks back into one.
            s.push_str(
                "Style: generic. Broad headlines any iPhone user would stop for, not tied to a niche, audience or hobby \
                 (like: underrated iphone apps, apps nobody talks about, your phone needs these, apps i can't live without). \
                 Ignore the niche examples above; use the openings, not the topics.\n",
            );
            push_used(&mut s, b);
            s.push_str(&format!("Write {} headlines.\n", b.how_many));
            return s;
        }
        HookStyle::Niche => {
            s.push_str(&format!(
                "Style: niche. Every headline speaks to people into this niche, in their own words: {niche}\n\
                 Use the apps below only as background; the niche comes first.\n"
            ));
        }
        HookStyle::Fit => {
            if !niche.is_empty() {
                s.push_str(&format!("Niche: {niche}\n"));
            }
            if let Some(a) = b.own_app {
                let about: String = a.description.chars().take(600).collect();
                s.push_str(&format!(
                    "The creator's own app (sets the niche; never name it): {} ({}). {}\n",
                    a.track_name, a.primary_genre_name, about
                ));
            }
        }
    }
    if !b.apps.is_empty() {
        s.push_str("Apps in this slideshow:\n");
        for p in b.apps {
            s.push_str(&format!("- {}: {}\n", p.app.track_name, p.overview));
        }
    }
    push_used(&mut s, b);
    s.push_str(&format!("Write {} headlines.\n", b.how_many));
    s
}

fn push_used(s: &mut String, b: &HookBrief) {
    if !b.used.is_empty() {
        s.push_str(&format!("Already used: {}\n", b.used.join("; ")));
    }
}

pub fn suggest_hooks(b: &HookBrief, writer: Writer) -> Result<Vec<Hook>> {
    let prompt = brief(b);
    let raw = match writer {
        Writer::Claude => prepare::run_claude(HOOK_INSTRUCTIONS, &prompt)?,
        Writer::Codex => prepare::run_codex(HOOK_INSTRUCTIONS, &prompt)?,
    };
    parse(&raw)
}

fn parse(raw: &str) -> Result<Vec<Hook>> {
    #[derive(Deserialize)]
    struct Out {
        hooks: Vec<Hook>,
    }
    let json = match (raw.find('{'), raw.rfind('}')) {
        (Some(a), Some(b)) if a < b => &raw[a..=b],
        _ => bail!("The writer didn't return any hooks. Try again."),
    };
    let out: Out = serde_json::from_str(json).context("Couldn't read the hooks the writer returned")?;
    let clean = |s: &str| s.trim().trim_matches(|c| c == '"' || c == '“' || c == '”').trim().to_string();
    Ok(out
        .hooks
        .into_iter()
        .map(|h| Hook { accent: clean(&h.accent), line2: clean(&h.line2), line3: clean(&h.line3) })
        .filter(|h| !h.accent.is_empty())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn brief_follows_style() {
        let used = ["old hook".to_string()];
        let b = |style, niche| HookBrief { style, niche, own_app: None, apps: &[], count: 6, used: &used, how_many: 8 };
        let generic = brief(&b(HookStyle::Generic, "letters"));
        assert!(generic.contains("Style: generic") && !generic.contains("letters") && generic.contains("Already used: old hook"));
        let niche = brief(&b(HookStyle::Niche, "cosy games"));
        assert!(niche.contains("Style: niche") && niche.contains("cosy games") && niche.contains("Write 8 headlines"));
        let fit = brief(&b(HookStyle::Fit, "letters"));
        assert!(fit.contains("Niche: letters") && !fit.contains("Style:"));
    }

    #[test]
    fn parses_hooks() {
        let raw = "```json\n{\"hooks\": [{\"accent\": \" 6 apps \", \"line2\": \"for pen pals\", \"line3\": \"\"}, {\"accent\": \"\"}]}\n```";
        let hooks = super::parse(raw).unwrap();
        assert_eq!(hooks.len(), 1);
        assert_eq!((hooks[0].accent.as_str(), hooks[0].line2.as_str()), ("6 apps", "for pen pals"));
    }
}
