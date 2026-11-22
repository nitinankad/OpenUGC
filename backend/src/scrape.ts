// Starting scrapes and saving their results into D1.

import { FINISHED_BAD, FINISHED_OK, getItems, getRun, startRun, type ApifyEnv } from "./apify.ts";
import { parseItem, type ProfileRow } from "./items.ts";
import { log } from "./log.ts";

export interface Env extends ApifyEnv {
  DB: D1Database;
  API_TOKEN: string;
}

interface RunRow {
  id: string;
  trigger: string;
  profiles: string;
  status: string;
  started_at: string;
  dataset_id: string | null;
  saved_items: number;
  total_items: number | null;
}

/** Results are read and saved in pages; progress is stored after each so a cut-off invocation resumes. */
const PAGE = 200;
/** Stop saving after this long in one invocation and carry on at the next check. */
const BUDGET_MS = 20_000;
/** A run still going after this long is given up on. */
const GIVE_UP_MS = 24 * 3_600_000;
const D1_BATCH = 90;

const now = () => new Date().toISOString();

export async function activeUsernames(env: Env): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT username FROM profiles WHERE active = 1 ORDER BY username").all<{ username: string }>();
  return results.map((r) => r.username);
}

/** Starts a scrape of every active profile, unless one is already going. */
export async function startScrape(env: Env, trigger: "schedule" | "manual"): Promise<{ started: boolean; runId?: string; reason?: string }> {
  const busy = await env.DB.prepare("SELECT id FROM scrape_runs WHERE status IN ('running', 'saving') LIMIT 1").first<{ id: string }>();
  if (busy) {
    log.info("scrape.skipped", { trigger, reason: "busy", runId: busy.id });
    return { started: false, runId: busy.id, reason: "A scrape is already in progress." };
  }
  const usernames = await activeUsernames(env);
  if (!usernames.length) {
    log.warn("scrape.skipped", { trigger, reason: "no profiles" });
    return { started: false, reason: "No profiles to scrape. Add accounts in OpenUGC first." };
  }

  log.info("scrape.starting", { trigger, usernames, actor: env.APIFY_ACTOR, maxPosts: env.MAX_POSTS_PER_PROFILE, maxChargeUsd: env.MAX_CHARGE_USD || null });
  const run = await startRun(env, usernames);
  log.info("scrape.started", { trigger, runId: run.id, datasetId: run.defaultDatasetId, apifyStatus: run.status });
  await env.DB.prepare(
    "INSERT INTO scrape_runs (id, trigger, profiles, status, started_at, dataset_id) VALUES (?, ?, ?, 'running', ?, ?)",
  )
    .bind(run.id, trigger, JSON.stringify(usernames), run.startedAt || now(), run.defaultDatasetId || null)
    .run();
  return { started: true, runId: run.id };
}

/** A scheduled scrape counts as missed when nothing has started for this long. */
const MISSED_AFTER_MS = 12.5 * 3_600_000;
/** At most this many tries per 12.5 hours, so an Apify outage can't run up the bill. */
const MAX_TRIES = 3;

/**
 * Starts a scrape if the last 12-hour one was missed (Cloudflare skipped a cron, or it failed).
 * Called from the 10-minute check, so the schedule heals itself.
 */
export async function catchUp(env: Env, windowMs = MISSED_AFTER_MS): Promise<{ started: boolean; reason?: string }> {
  const since = new Date(Date.now() - windowMs).toISOString();
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS tries, SUM(status <> 'failed') AS good FROM scrape_runs WHERE started_at > ?`,
  )
    .bind(since)
    .first<{ tries: number; good: number | null }>();
  if ((r?.good ?? 0) > 0) return { started: false, reason: "A recent scrape exists." };
  if ((r?.tries ?? 0) >= MAX_TRIES) {
    log.warn("catchup.waiting", { failedTries: r?.tries, windowHours: windowMs / 3_600_000 });
    return { started: false, reason: "Too many failed tries; waiting." };
  }
  log.info("catchup.starting", { failedTries: r?.tries ?? 0, windowHours: windowMs / 3_600_000 });
  return startScrape(env, "schedule");
}

/** Checks unfinished runs with Apify and saves the results of finished ones. */
export async function checkRuns(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM scrape_runs WHERE status IN ('running', 'saving') ORDER BY started_at",
  ).all<RunRow>();
  const deadline = Date.now() + BUDGET_MS;
  for (const row of results) {
    try {
      await checkRun(env, row, deadline);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const stale = Date.now() - Date.parse(row.started_at) > GIVE_UP_MS;
      log.error(stale ? "run.given_up" : "run.check_failed", e, { runId: row.id, status: row.status, savedItems: row.saved_items });
      await env.DB.prepare(`UPDATE scrape_runs SET error = ?${stale ? ", status = 'failed', finished_at = ?" : ""} WHERE id = ?`)
        .bind(...(stale ? [msg, now(), row.id] : [msg, row.id]))
        .run();
    }
    if (Date.now() > deadline) return;
  }
}

async function checkRun(env: Env, row: RunRow, deadline: number): Promise<void> {
  if (row.status === "running") {
    const run = await getRun(env, row.id);
    if (FINISHED_BAD.has(run.status)) {
      const error = `Apify run ${run.status.toLowerCase()}${run.statusMessage ? `: ${run.statusMessage}` : ""}`;
      log.error("run.failed", error, {
        runId: row.id,
        apifyStatus: run.status,
        statusMessage: run.statusMessage ?? null,
        apifyConsole: `https://console.apify.com/view/runs/${row.id}`,
      });
      await env.DB.prepare("UPDATE scrape_runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?")
        .bind(run.finishedAt || now(), error, row.id)
        .run();
      return;
    }
    if (run.status !== FINISHED_OK) {
      if (Date.now() - Date.parse(row.started_at) > GIVE_UP_MS) throw new Error(`Apify run still ${run.status} after 24 hours`);
      log.info("run.waiting", { runId: row.id, apifyStatus: run.status, statusMessage: run.statusMessage ?? null });
      return; // still going; look again at the next check
    }
    log.info("run.succeeded", { runId: row.id, datasetId: run.defaultDatasetId, statusMessage: run.statusMessage ?? null });
    row.dataset_id = run.defaultDatasetId || row.dataset_id;
    row.status = "saving";
    await env.DB.prepare("UPDATE scrape_runs SET status = 'saving', dataset_id = ?, error = NULL WHERE id = ?").bind(row.dataset_id, row.id).run();
  }
  if (!row.dataset_id) throw new Error("Apify didn't say where the results are");

  const wanted = new Set<string>(JSON.parse(row.profiles));
  let offset = row.saved_items;
  while (Date.now() < deadline) {
    const { items, total } = await getItems(env, row.dataset_id, offset, PAGE);
    if (total != null && total !== row.total_items) {
      row.total_items = total;
      await env.DB.prepare("UPDATE scrape_runs SET total_items = ? WHERE id = ?").bind(total, row.id).run();
    }
    if (!items.length) {
      await finishRun(env, row, offset);
      return;
    }
    const counts = await saveItems(env, row, items, wanted);
    offset += items.length;
    log.info("run.saved_page", { runId: row.id, offset, total, ...counts });
    await env.DB.prepare("UPDATE scrape_runs SET saved_items = ? WHERE id = ?").bind(offset, row.id).run();
    if (items.length < PAGE || (total != null && offset >= total)) {
      await finishRun(env, row, offset);
      return;
    }
  }
}

async function saveItems(
  env: Env,
  row: RunRow,
  items: Parameters<typeof parseItem>[0][],
  wanted: Set<string>,
): Promise<{ posts: number; skipped: number; errors: number }> {
  const at = row.started_at;
  const stmts: D1PreparedStatement[] = [];
  const profiles = new Map<string, ProfileRow>();
  const counts = { posts: 0, skipped: 0, errors: 0 };
  const skipReasons: Record<string, number> = {};
  for (const item of items) {
    const p = parseItem(item, wanted);
    if (p.kind === "error") {
      counts.errors++;
      log.warn("run.profile_error", { runId: row.id, username: p.username, code: p.code });
      if (p.username) stmts.push(env.DB.prepare("UPDATE profiles SET last_error = ? WHERE username = ?").bind(p.code, p.username));
      continue;
    }
    if (p.kind !== "post") {
      counts.skipped++;
      skipReasons[p.reason] = (skipReasons[p.reason] || 0) + 1;
      continue;
    }
    counts.posts++;
    const { video: v, metrics: m } = p;
    profiles.set(p.profile.username, p.profile);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO videos (id, username, url, caption, posted_at, is_slideshow, is_pinned, cover_url, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           url = excluded.url, caption = excluded.caption,
           posted_at = COALESCE(excluded.posted_at, videos.posted_at),
           is_slideshow = excluded.is_slideshow, is_pinned = excluded.is_pinned,
           cover_url = COALESCE(excluded.cover_url, videos.cover_url),
           last_seen_at = MAX(videos.last_seen_at, excluded.last_seen_at)`,
      ).bind(v.id, v.username, v.url, v.caption, v.postedAt, v.isSlideshow ? 1 : 0, v.isPinned ? 1 : 0, v.coverUrl, at, at),
      env.DB.prepare(
        `INSERT OR REPLACE INTO video_snapshots (video_id, run_id, scraped_at, views, likes, comments, shares, saves, reposts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(v.id, row.id, at, m.views, m.likes, m.comments, m.shares, m.saves, m.reposts),
    );
  }
  for (const pr of profiles.values()) {
    stmts.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO profile_snapshots (username, run_id, scraped_at, followers, following, likes, videos)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(pr.username, row.id, at, pr.followers, pr.following, pr.likes, pr.videos),
      env.DB.prepare(
        `UPDATE profiles SET last_error = NULL,
           tiktok_id = COALESCE(?, tiktok_id), nickname = COALESCE(?, nickname), avatar_url = COALESCE(?, avatar_url)
         WHERE username = ?`,
      ).bind(pr.tiktokId, pr.nickname, pr.avatarUrl, pr.username),
    );
  }
  if (counts.skipped) log.info("run.skipped_items", { runId: row.id, skipReasons });
  for (let i = 0; i < stmts.length; i += D1_BATCH) await env.DB.batch(stmts.slice(i, i + D1_BATCH));
  return counts;
}

async function finishRun(env: Env, row: RunRow, saved: number): Promise<void> {
  const at = now();
  log.info("run.done", { runId: row.id, savedItems: saved, totalItems: row.total_items });
  const usernames: string[] = JSON.parse(row.profiles);
  await env.DB.batch([
    env.DB.prepare("UPDATE scrape_runs SET status = 'done', finished_at = ?, saved_items = ?, error = NULL WHERE id = ?").bind(at, saved, row.id),
    ...usernames.map((u) => env.DB.prepare("UPDATE profiles SET last_scraped_at = ? WHERE username = ?").bind(at, u)),
  ]);
}
