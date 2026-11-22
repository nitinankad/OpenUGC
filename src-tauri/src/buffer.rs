//! Buffer GraphQL API (https://developers.buffer.com), using a personal API key.
//!
//! Posts are always created with `schedulingType: notification`: at the scheduled time
//! Buffer sends a reminder to the Buffer mobile app and you publish it yourself in TikTok,
//! so there's time to add a sound first. Nothing is published automatically.

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const ENDPOINT: &str = "https://api.buffer.com";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub service: String,
    #[serde(default)]
    pub avatar: Option<String>,
    #[serde(default)]
    pub is_disconnected: bool,
    #[serde(default)]
    pub organization_name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BufferPost {
    pub id: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub due_at: Option<String>,
    #[serde(default)]
    pub sent_at: Option<String>,
    #[serde(default)]
    pub external_link: Option<String>,
}

pub struct NewPost<'a> {
    pub channel_id: &'a str,
    pub text: &'a str,
    /// TikTok photo post title.
    pub title: &'a str,
    pub image_urls: &'a [String],
    /// ISO 8601, UTC.
    pub due_at: &'a str,
}

fn graphql(key: &str, query: &str, variables: Value) -> Result<Value> {
    let resp = reqwest::blocking::Client::builder()
        .user_agent("OpenUGC/0.1")
        .timeout(std::time::Duration::from_secs(60))
        .build()?
        .post(ENDPOINT)
        .bearer_auth(key)
        .json(&json!({ "query": query, "variables": variables }))
        .send()
        .context("Couldn't reach Buffer")?;
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        bail!("Buffer didn't accept the API key. Check it in Settings.");
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let wait = resp.headers().get("retry-after").and_then(|v| v.to_str().ok()).unwrap_or("a few").to_string();
        bail!("Buffer's rate limit was reached. Try again in {wait} seconds.");
    }
    let body: Value = resp.json().with_context(|| format!("Buffer returned {status} with an unreadable body"))?;
    // GraphQL errors come back as HTTP 200 with an `errors` array.
    if let Some(errors) = body.get("errors").and_then(Value::as_array).filter(|e| !e.is_empty()) {
        let msgs: Vec<&str> = errors.iter().filter_map(|e| e.get("message").and_then(Value::as_str)).collect();
        bail!("Buffer: {}", msgs.join("; "));
    }
    if !status.is_success() {
        bail!("Buffer returned {status}");
    }
    body.get("data").cloned().ok_or_else(|| anyhow!("Buffer returned no data"))
}

/// Every channel in every organization on the account.
pub fn channels(key: &str) -> Result<Vec<Channel>> {
    let orgs = graphql(key, "query { account { organizations { id name } } }", json!({}))?;
    let orgs = orgs["account"]["organizations"].as_array().cloned().unwrap_or_default();
    let mut out = Vec::new();
    for org in orgs {
        let (Some(id), name) = (org["id"].as_str(), org["name"].as_str().unwrap_or("")) else { continue };
        let data = graphql(
            key,
            "query Channels($input: ChannelsInput!) { channels(input: $input) { id name displayName service avatar isDisconnected } }",
            json!({ "input": { "organizationId": id } }),
        )?;
        let list: Vec<Channel> = serde_json::from_value(data["channels"].clone()).context("Unexpected channel list from Buffer")?;
        out.extend(list.into_iter().map(|mut c| {
            c.organization_name = name.to_string();
            c
        }));
    }
    Ok(out)
}

const POST_FIELDS: &str = "id status dueAt sentAt externalLink";

pub fn create_post(key: &str, p: &NewPost) -> Result<BufferPost> {
    if p.image_urls.is_empty() {
        bail!("No slides to post");
    }
    let assets: Vec<Value> = p.image_urls.iter().map(|u| json!({ "image": { "url": u } })).collect();
    let mut input = json!({
        "channelId": p.channel_id,
        "text": p.text,
        "mode": "customScheduled",
        "schedulingType": "notification",
        "dueAt": p.due_at,
        "assets": assets,
    });
    if !p.title.trim().is_empty() {
        input["metadata"] = json!({ "tiktok": { "title": p.title.trim() } });
    }
    let query = format!(
        "mutation CreatePost($input: CreatePostInput!) {{ createPost(input: $input) {{
            __typename
            ... on PostActionSuccess {{ post {{ {POST_FIELDS} }} }}
            ... on InvalidInputError {{ message }}
            ... on LimitReachedError {{ message }}
            ... on NotFoundError {{ message }}
            ... on UnauthorizedError {{ message }}
            ... on UnexpectedError {{ message }}
            ... on RestProxyError {{ message }}
        }} }}"
    );
    let data = graphql(key, &query, json!({ "input": input }))?;
    let result = &data["createPost"];
    if let Some(post) = result.get("post") {
        return serde_json::from_value(post.clone()).context("Unexpected post from Buffer");
    }
    let msg = result["message"].as_str().unwrap_or("unknown error");
    bail!("Buffer didn't schedule the post: {msg}")
}

pub fn get_post(key: &str, id: &str) -> Result<BufferPost> {
    let query = format!("query Post($input: PostInput!) {{ post(input: $input) {{ {POST_FIELDS} }} }}");
    let data = graphql(key, &query, json!({ "input": { "id": id } }))?;
    serde_json::from_value(data["post"].clone()).context("Unexpected post from Buffer")
}
