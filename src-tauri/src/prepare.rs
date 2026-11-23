//! Downloads an app's icon + screenshots and generates an overview with the local Claude CLI.

use crate::appstore::{self, AppInfo};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedApp {
    pub app: AppInfo,
    pub dir: PathBuf,
    pub icon: Option<PathBuf>,
    pub screenshots: Vec<PathBuf>,
    pub overview: String,
}

pub fn prepare(app: &AppInfo, data_root: &Path, writer: Writer) -> Result<PreparedApp> {
    let dir = data_root.join("apps").join(app.track_id.to_string());
    std::fs::create_dir_all(&dir)?;
    let client = reqwest::blocking::Client::builder()
        .user_agent("OpenUGC/0.1")
        .timeout(std::time::Duration::from_secs(60))
        .build()?;

    let icon = match appstore::hires_icon(app) {
        Some(url) => Some(download(&client, &url, &dir.join("icon.png"))?),
        None => None,
    };
    let mut screenshots = Vec::new();
    for (i, url) in app.screenshot_urls.iter().enumerate() {
        let path = dir.join(format!("screenshot_{i:02}.jpg"));
        screenshots.push(download(&client, &appstore::hires_screenshot(url), &path)?);
    }

    let overview = generate_overview(app, writer)?;
    let prepared = PreparedApp { app: app.clone(), dir: dir.clone(), icon, screenshots, overview };
    std::fs::write(dir.join("app.json"), serde_json::to_vec_pretty(&prepared)?)?;
    Ok(prepared)
}

pub(crate) fn download(client: &reqwest::blocking::Client, url: &str, path: &Path) -> Result<PathBuf> {
    if !path.exists() {
        let bytes = client.get(url).send()?.error_for_status()?.bytes()?;
        std::fs::write(path, &bytes)?;
    }
    Ok(path.to_path_buf())
}

/// Which local AI CLI writes the overviews.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Writer {
    #[default]
    Claude,
    Codex,
}

/// Modelled on the reference slideshow: one plain sentence, ~100-140 characters,
/// "A [kind of app] that [does what] so/without [payoff]".
const OVERVIEW_INSTRUCTIONS: &str = "\
You write the one-line description that goes under an app's name on a TikTok slideshow about hidden-gem iPhone apps.

Rules:
- Exactly one sentence, 100 to 140 characters, ending with a period.
- Start with \"A\" or \"An\" and name what kind of app it is, then say what it does and the payoff for the person using it.
- Concrete and calm. Describe, don't sell: no hype words (amazing, ultimate, game-changer, must-have), no exclamation marks, no emojis, no hashtags, no quotes.
- Don't repeat the app's name. Don't mention price, ratings or AI unless AI is the core feature.
- Output only the sentence.

Examples of the style:
A bookmark manager that pairs every save with a next step and reminders so nothing you meant to do gets forgotten.
A Dynamic Island utility that keeps your most important codes, notes, and reminders visible at a glance, in any app.
A calm, all-in-one space for managing tasks, habits, finances, and routines without the clutter of switching between apps.
A gentle mental health companion that talks you through anxiety, panic, and low mood with calming exercises and supportive AI chat.
A personal canvas app where you photograph and arrange your cherished belongings to express who you are without words.";

fn listing(app: &AppInfo) -> String {
    format!(
        "App name: {}\nCategory: {}\n\nApp Store description:\n{}",
        app.track_name,
        app.primary_genre_name,
        app.description.chars().take(4000).collect::<String>(),
    )
}

/// Writes an overview with the chosen local CLI, using the user's own login (no API key).
pub fn generate_overview(app: &AppInfo, writer: Writer) -> Result<String> {
    let text = match writer {
        Writer::Claude => run_claude(OVERVIEW_INSTRUCTIONS, &listing(app))?,
        Writer::Codex => run_codex(OVERVIEW_INSTRUCTIONS, &listing(app))?,
    };
    // Models sometimes wrap the line in quotes despite instructions.
    Ok(text.trim().trim_matches(|c| c == '"' || c == '“' || c == '”').trim().to_string())
}

/// Runs headless Claude with `instructions` as the system prompt and `prompt` as the message.
pub(crate) fn run_claude(instructions: &str, prompt: &str) -> Result<String> {
    // Multi-line arguments can't be passed safely to a Windows .cmd shim, so the
    // instructions go in a file, one per call so parallel calls don't clash.
    static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let file = std::env::temp_dir().join(format!("openugc-instructions-{}-{n}.txt", std::process::id()));
    std::fs::write(&file, instructions)?;
    let result = run_claude_with_file(&file.to_string_lossy(), prompt);
    let _ = std::fs::remove_file(&file);
    result
}

fn run_claude_with_file(instructions: &str, prompt: &str) -> Result<String> {
    let args = [
        "-p",
        "--output-format", "json",
        "--model", "sonnet",
        "--system-prompt-file", &instructions,
        "--tools", "",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--setting-sources", "",
    ];
    let out = run_cli("claude", &args, prompt, None)?;

    #[derive(Deserialize)]
    struct ClaudeOut {
        result: String,
        #[serde(default)]
        is_error: bool,
    }
    let parsed: ClaudeOut = serde_json::from_slice(&out).context("Unexpected output from the claude CLI")?;
    if parsed.is_error {
        bail!("claude CLI error: {}", parsed.result);
    }
    Ok(parsed.result)
}

/// Runs Codex non-interactively. It has no separate system prompt, so the instructions lead the message.
pub(crate) fn run_codex(instructions: &str, prompt: &str) -> Result<String> {
    let prompt = format!("{instructions}\n\n---\n\n{prompt}");
    // Run from an empty temp dir so Codex has no project files to look at.
    let cwd = std::env::temp_dir().join("openugc-codex");
    std::fs::create_dir_all(&cwd)?;
    let args = [
        "exec",
        "--skip-git-repo-check",
        "--sandbox", "read-only",
        "--ephemeral",
        "--color", "never",
        "-c", "model_reasoning_effort=low",
        "-",
    ];
    let out = run_cli("codex", &args, &prompt, Some(&cwd))?;
    let text = String::from_utf8_lossy(&out).trim().to_string();
    if text.is_empty() {
        bail!("codex returned no text. Run `codex login` in a terminal if you haven't.");
    }
    Ok(text)
}

/// Runs a CLI with `prompt` on stdin and returns stdout.
pub(crate) fn run_cli(name: &str, args: &[&str], prompt: &str, cwd: Option<&Path>) -> Result<Vec<u8>> {
    let mut child = spawn_cli(name, args, cwd)?;
    child.stdin.take().unwrap().write_all(prompt.as_bytes())?;
    let out = child.wait_with_output()?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let tail: Vec<&str> = err.lines().rev().take(4).collect();
        bail!("{name} exited with an error: {}", tail.into_iter().rev().collect::<Vec<_>>().join(" "));
    }
    Ok(out.stdout)
}

/// Finds and spawns a CLI. On Windows it may be a native `.exe` or an npm `.cmd`
/// shim (std escapes .cmd arguments safely). GUI apps on macOS don't inherit the
/// shell PATH, so common install locations are checked too.
fn spawn_cli(name: &str, args: &[&str], cwd: Option<&Path>) -> Result<std::process::Child> {
    let mut candidates: Vec<PathBuf> = vec![name.into()];
    if cfg!(windows) {
        candidates.push(format!("{name}.cmd").into());
    } else {
        if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
            candidates.push(home.join(".local/bin").join(name));
            candidates.push(home.join(format!(".{name}/local/{name}")));
            candidates.push(home.join(".npm-global/bin").join(name));
        }
        candidates.push(Path::new("/opt/homebrew/bin").join(name));
        candidates.push(Path::new("/usr/local/bin").join(name));
    }
    for program in &candidates {
        let mut cmd = Command::new(program);
        cmd.args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        match cmd.spawn() {
            Ok(child) => return Ok(child),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
        }
    }
    bail!("Couldn't find the `{name}` CLI. Install it and make sure it's on your PATH.")
}

#[cfg(test)]
mod tests {
    /// Hits the network and the local Claude CLI: `cargo test -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn end_to_end_discover_and_prepare() {
        let gems = crate::appstore::find_hidden_gems("habit tracker, journaling", &Default::default()).unwrap();
        println!("{} gems found", gems.len());
        for g in gems.iter().take(5) {
            println!("  {:.0}  {} ({:.2}, {} ratings)", g.gem_score, g.track_name, g.average_user_rating, g.user_rating_count);
        }
        let root = std::env::temp_dir().join("openugc-test");
        let p = super::prepare(&gems[0], &root, super::Writer::Claude).unwrap();
        let codex = super::generate_overview(&gems[0], super::Writer::Codex).unwrap();
        println!("codex overview: {codex} ({} chars)", codex.len());
        println!("icon: {:?}\nscreenshots: {}\nclaude overview: {} ({} chars)", p.icon, p.screenshots.len(), p.overview, p.overview.len());
        assert!(p.icon.is_some() && !p.screenshots.is_empty() && !p.overview.is_empty());
    }
}
