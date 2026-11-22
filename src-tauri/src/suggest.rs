//! Asks Claude or Codex for apps that fit a niche, then finds each one on the App Store.
//! The model only supplies names; every app shown comes from Apple's own listing, so
//! suggestions that don't exist (or are misremembered) are dropped, not invented.

use crate::appstore::{self, AppInfo, GemFilter};
use crate::prepare::{self, Writer};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

const SUGGEST_INSTRUCTIONS: &str = "\
You suggest real iPhone apps for a TikTok slideshow about great apps in a niche.

Rules:
- Only apps you are confident are currently on the App Store. Use each app's exact App Store name.
- About two thirds should be true hidden gems: small indie apps with only hundreds or a few thousand ratings that are genuinely good. The rest should be well-loved popular apps people will recognise.
- No apps from the exclude list. No duplicates.
- Reply with only this JSON and nothing else:
{\"apps\": [{\"name\": \"exact App Store name\", \"developer\": \"developer name\"}]}";

#[derive(Deserialize)]
struct Suggestions {
    apps: Vec<Suggested>,
}

#[derive(Deserialize)]
struct Suggested {
    name: String,
    #[serde(default)]
    developer: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestResult {
    pub apps: Vec<AppInfo>,
    /// Names the model suggested that couldn't be found on the App Store.
    pub not_found: Vec<String>,
    /// How many apps the model suggested.
    pub suggested: usize,
    /// Found, but left out because nobody has rated them yet (often a look-alike listing).
    pub unrated: Vec<String>,
    /// How many of `apps` are hidden gems (at most the filter's max ratings) and how many are popular.
    pub gems: usize,
    pub popular: usize,
}

pub fn suggest_apps(niche: &str, count: usize, exclude: &[String], filter: &GemFilter, writer: Writer) -> Result<SuggestResult> {
    let niche = niche.trim();
    // Ask for extra: some suggestions won't be on the store, and the mix is balanced afterwards.
    let ask = count + count / 2;
    let mut prompt = if niche.is_empty() {
        format!("Niche: any. Pick standout apps from a mix of different categories.\nNumber of apps: {ask}\n")
    } else {
        format!("Niche: {niche}\nNumber of apps: {ask}\n")
    };
    if !exclude.is_empty() {
        prompt.push_str(&format!("Exclude: {}\n", exclude.join("; ")));
    }
    let raw = match writer {
        Writer::Claude => prepare::run_claude(SUGGEST_INSTRUCTIONS, &prompt)?,
        Writer::Codex => prepare::run_codex(SUGGEST_INSTRUCTIONS, &prompt)?,
    };
    let list = parse(&raw)?;

    // Look the suggestions up in parallel; each is one small App Store search.
    let client = appstore::client()?;
    let found: Vec<(String, Option<AppInfo>)> = std::thread::scope(|s| {
        let handles: Vec<_> = list
            .iter()
            .map(|sug| {
                let client = &client;
                s.spawn(move || (sug.name.clone(), find_on_store(client, sug, &filter.country).ok().flatten()))
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap_or_default()).collect()
    });

    let now = chrono::Utc::now();
    let mut apps: Vec<AppInfo> = Vec::new();
    let mut not_found = Vec::new();
    let mut unrated = Vec::new();
    for (name, app) in found {
        match app {
            Some(a) if a.user_rating_count == 0 => unrated.push(a.track_name),
            Some(mut a) if !apps.iter().any(|x| x.track_id == a.track_id) => {
                a.gem_score = appstore::gem_score(&a, filter, now);
                apps.push(a);
            }
            Some(_) => {}
            None => not_found.push(name),
        }
    }
    let (apps, gems, popular) = balance(apps, count, filter.max_ratings);
    Ok(SuggestResult { apps, not_found, suggested: list.len(), unrated, gems, popular })
}

/// Half hidden gems (at most `max_ratings` ratings), half popular apps, judged by the App
/// Store's real rating counts rather than the model's word. Either side fills in when the
/// other runs short. Gems come first; each side is ranked by gem score.
fn balance(apps: Vec<AppInfo>, count: usize, max_ratings: u64) -> (Vec<AppInfo>, usize, usize) {
    let (mut gems, mut popular): (Vec<AppInfo>, Vec<AppInfo>) =
        apps.into_iter().partition(|a| a.user_rating_count <= max_ratings);
    gems.sort_by(|a, b| b.gem_score.total_cmp(&a.gem_score));
    popular.sort_by(|a, b| b.gem_score.total_cmp(&a.gem_score));
    let take_gems = gems.len().min(count.div_ceil(2).max(count.saturating_sub(popular.len())));
    let take_popular = popular.len().min(count - take_gems);
    gems.truncate(take_gems);
    popular.truncate(take_popular);
    let (g, p) = (gems.len(), popular.len());
    gems.extend(popular);
    (gems, g, p)
}

fn parse(raw: &str) -> Result<Vec<Suggested>> {
    let json = match (raw.find('{'), raw.rfind('}')) {
        (Some(a), Some(b)) if a < b => &raw[a..=b],
        _ => bail!("The writer didn't return a list of apps. Try again."),
    };
    let s: Suggestions = serde_json::from_str(json).context("Couldn't read the app list the writer returned")?;
    Ok(s.apps.into_iter().filter(|a| !a.name.trim().is_empty()).collect())
}

/// Lowercase letters and digits only, for comparing names.
fn norm(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// The part of an App Store name before a subtitle ("Paper Pond: Origami Letters" → "Paper Pond").
fn main_title(s: &str) -> &str {
    s.split([':', '|', '–', '—']).next().unwrap_or(s).split(" - ").next().unwrap_or(s).trim()
}

/// True when an App Store listing is the app the model meant.
fn is_match(sug: &Suggested, a: &AppInfo) -> bool {
    let (want, want_main) = (norm(&sug.name), norm(main_title(&sug.name)));
    let (have, have_main) = (norm(&a.track_name), norm(main_title(&a.track_name)));
    if want.is_empty() || have_main.is_empty() {
        return false;
    }
    want == have || want_main == have_main || have.starts_with(&want) || (want.starts_with(&have_main) && have_main.len() >= 4)
}

fn search(client: &reqwest::blocking::Client, term: &str, country: &str) -> Result<Vec<AppInfo>> {
    #[derive(Deserialize)]
    struct Resp {
        results: Vec<AppInfo>,
    }
    let resp: Resp = client
        .get("https://itunes.apple.com/search")
        .query(&[("term", term), ("entity", "software"), ("country", country), ("limit", "10")])
        .send()?
        .error_for_status()?
        .json()?;
    Ok(resp.results)
}

fn find_on_store(client: &reqwest::blocking::Client, sug: &Suggested, country: &str) -> Result<Option<AppInfo>> {
    let mut matches: Vec<AppInfo> = search(client, &sug.name, country)?.into_iter().filter(|a| is_match(sug, a)).collect();
    // Models often get the subtitle wrong ("Slowly - Communication Reimagined"); retry with the main title.
    let short = main_title(&sug.name);
    if matches.is_empty() && short != sug.name.trim() && !short.is_empty() {
        matches = search(client, short, country)?.into_iter().filter(|a| is_match(sug, a)).collect();
    }
    let dev = norm(&sug.developer);
    // Prefer the listing from the named developer when there are look-alikes.
    let best = matches
        .iter()
        .position(|a| !dev.is_empty() && norm(&a.artist_name).contains(&dev))
        .map(|i| matches[i].clone())
        .or_else(|| matches.into_iter().next());
    Ok(best)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(name: &str) -> AppInfo {
        serde_json::from_value(serde_json::json!({ "trackId": 1, "trackName": name })).unwrap()
    }

    #[test]
    fn matches_names_with_and_without_subtitles() {
        let s = |n: &str| Suggested { name: n.into(), developer: String::new() };
        assert!(is_match(&s("Paper Pond"), &app("Paper Pond: Origami Letters")));
        assert!(is_match(&s("Paper Pond: Origami Letters"), &app("Paper Pond: Origami Letters")));
        assert!(is_match(&s("Streaks"), &app("Streaks")));
        assert!(!is_match(&s("Streaks"), &app("Habit Tracker - Streaks Loop")));
        assert!(!is_match(&s("Paper"), &app("Origami Paper Folding")));
    }

    #[test]
    fn balances_gems_and_popular() {
        let mk = |id: u64, ratings: u64| -> AppInfo {
            serde_json::from_value(serde_json::json!({ "trackId": id, "trackName": "x", "userRatingCount": ratings })).unwrap()
        };
        let mix = |gems: u64, popular: u64| -> Vec<AppInfo> {
            (0..gems).map(|i| mk(i, 100)).chain((100..100 + popular).map(|i| mk(i, 50_000))).collect()
        };
        let counts = |(out, g, p): (Vec<AppInfo>, usize, usize)| (out.len(), g, p);
        assert_eq!(counts(balance(mix(5, 6), 6, 5000)), (6, 3, 3), "even split");
        assert_eq!(counts(balance(mix(1, 8), 6, 5000)), (6, 1, 5), "popular fills in");
        assert_eq!(counts(balance(mix(8, 1), 6, 5000)), (6, 5, 1), "gems fill in");
        assert_eq!(counts(balance(mix(2, 1), 6, 5000)), (3, 2, 1), "fewer than asked");
    }

    #[test]
    fn parses_fenced_list() {
        let raw = "```json\n{\"apps\": [{\"name\": \"Streaks\", \"developer\": \"Crunchy Bagel\"}, {\"name\": \" \"}]}\n```";
        let list = parse(raw).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].developer, "Crunchy Bagel");
    }
}
