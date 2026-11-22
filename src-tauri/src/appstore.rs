//! App Store discovery via Apple's public iTunes Search / Lookup API.

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub track_id: u64,
    pub track_name: String,
    #[serde(default)]
    pub artist_name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub primary_genre_name: String,
    #[serde(default)]
    pub average_user_rating: f64,
    #[serde(default)]
    pub user_rating_count: u64,
    #[serde(default)]
    pub formatted_price: Option<String>,
    #[serde(default)]
    pub artwork_url512: Option<String>,
    #[serde(default)]
    pub artwork_url100: Option<String>,
    #[serde(default)]
    pub screenshot_urls: Vec<String>,
    #[serde(default)]
    pub track_view_url: String,
    #[serde(default)]
    pub current_version_release_date: Option<DateTime<Utc>>,
    /// Computed locally; not part of Apple's response.
    #[serde(default)]
    pub gem_score: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GemFilter {
    pub country: String,
    pub min_rating: f64,
    pub min_ratings: u64,
    pub max_ratings: u64,
    /// Exclude apps not updated within this many days (0 = no limit).
    pub max_days_since_update: i64,
}

impl Default for GemFilter {
    fn default() -> Self {
        Self {
            country: "us".into(),
            min_rating: 4.5,
            min_ratings: 30,
            max_ratings: 5_000,
            max_days_since_update: 365,
        }
    }
}

#[derive(Deserialize)]
struct SearchResponse {
    results: Vec<AppInfo>,
}

pub(crate) fn client() -> Result<reqwest::blocking::Client> {
    Ok(reqwest::blocking::Client::builder()
        .user_agent("OpenUGC/0.1")
        .timeout(std::time::Duration::from_secs(30))
        .build()?)
}

pub(crate) fn search_term(client: &reqwest::blocking::Client, term: &str, country: &str) -> Result<Vec<AppInfo>> {
    let resp: SearchResponse = client
        .get("https://itunes.apple.com/search")
        .query(&[
            ("term", term),
            ("entity", "software"),
            ("country", country),
            ("limit", "200"),
        ])
        .send()
        .context("App Store search request failed")?
        .error_for_status()?
        .json()
        .context("Could not parse App Store response")?;
    Ok(resp.results)
}

/// Finds a specific app, unfiltered: accepts an App Store link, a numeric id, or a name.
pub fn find_app(query: &str, country: &str) -> Result<Vec<AppInfo>> {
    let client = client()?;
    let q = query.trim();
    if let Some(id) = app_id(q) {
        let resp: SearchResponse = client
            .get("https://itunes.apple.com/lookup")
            .query(&[("id", id), ("country", country), ("entity", "software")])
            .send()
            .context("App Store lookup request failed")?
            .error_for_status()?
            .json()
            .context("Could not parse App Store response")?;
        return Ok(resp.results);
    }
    let mut apps = search_term(&client, q, country)?;
    apps.truncate(6);
    Ok(apps)
}

/// The numeric id from an App Store link (".../app/paper-pond/id1234567890?..."),
/// "id1234567890", or a bare number. None for anything else, which is treated as a name.
fn app_id(q: &str) -> Option<&str> {
    let tail = match q.rfind("/id") {
        Some(i) => &q[i + 3..],
        None => q.strip_prefix("id").unwrap_or(q),
    };
    let end = tail.find(|c: char| !c.is_ascii_digit()).unwrap_or(tail.len());
    let digits = &tail[..end];
    let whole = q.contains("/id") || end == tail.len();
    (digits.len() >= 6 && whole).then_some(digits)
}

#[cfg(test)]
mod tests {
    use super::app_id;

    #[test]
    fn parses_app_ids() {
        assert_eq!(app_id("https://apps.apple.com/us/app/paper-pond/id6478901234?pt=1"), Some("6478901234"));
        assert_eq!(app_id("id6478901234"), Some("6478901234"));
        assert_eq!(app_id("6478901234"), Some("6478901234"));
        assert_eq!(app_id("Paper Pond: Origami Letters"), None);
        assert_eq!(app_id("idle game"), None);
        assert_eq!(app_id("2048"), None);
    }
}

/// Search every comma-separated term in `niche`, merge, filter and rank by gem score.
pub fn find_hidden_gems(niche: &str, filter: &GemFilter) -> Result<Vec<AppInfo>> {
    let client = client()?;
    let mut by_id: HashMap<u64, AppInfo> = HashMap::new();
    for term in niche.split(',').map(str::trim).filter(|t| !t.is_empty()) {
        for app in search_term(&client, term, &filter.country)? {
            by_id.entry(app.track_id).or_insert(app);
        }
    }

    let now = Utc::now();
    let mut gems: Vec<AppInfo> = by_id
        .into_values()
        .filter(|a| a.average_user_rating >= filter.min_rating)
        .filter(|a| (filter.min_ratings..=filter.max_ratings).contains(&a.user_rating_count))
        .filter(|a| {
            filter.max_days_since_update <= 0
                || a.current_version_release_date
                    .is_some_and(|d| (now - d).num_days() <= filter.max_days_since_update)
        })
        .map(|mut a| {
            a.gem_score = gem_score(&a, filter, now);
            a
        })
        .collect();
    gems.sort_by(|a, b| b.gem_score.total_cmp(&a.gem_score));
    Ok(gems)
}

/// 0..100. Rewards high ratings, obscurity (few ratings), and recent updates.
pub(crate) fn gem_score(a: &AppInfo, f: &GemFilter, now: DateTime<Utc>) -> f64 {
    let quality =
        ((a.average_user_rating - f.min_rating) / (5.0 - f.min_rating).max(0.01)).clamp(0.0, 1.0);
    // Need *some* ratings to trust the average: confidence ramps up to ~200 ratings.
    let confidence = ((a.user_rating_count as f64).ln_1p() / 200f64.ln_1p()).min(1.0);
    let obscurity = 1.0
        - ((a.user_rating_count as f64).ln_1p() / (f.max_ratings as f64).ln_1p().max(1.0))
            .clamp(0.0, 1.0);
    let freshness = a
        .current_version_release_date
        .map(|d| (1.0 - (now - d).num_days() as f64 / 365.0).clamp(0.0, 1.0))
        .unwrap_or(0.0);
    100.0 * (0.45 * quality * confidence + 0.35 * obscurity + 0.20 * freshness)
}

/// High-resolution screenshot URL (Apple's CDN resizes on the fly).
pub fn hires_screenshot(url: &str) -> String {
    match url.rsplit_once('/') {
        Some((base, _)) => format!("{base}/1290x0w.jpg"),
        None => url.to_string(),
    }
}

/// 1024x1024 PNG app icon URL.
pub fn hires_icon(app: &AppInfo) -> Option<String> {
    let url = app.artwork_url512.as_ref().or(app.artwork_url100.as_ref())?;
    Some(match url.rsplit_once('/') {
        Some((base, _)) => format!("{base}/1024x1024bb.png"),
        None => url.clone(),
    })
}
