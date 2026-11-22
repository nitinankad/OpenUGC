// OpenUGC metrics: scrapes your TikTok profiles twice a day and serves the numbers to the app.

import { cleanUsername } from "./items.ts";
import { log } from "./log.ts";
import { catchUp, checkRuns, startScrape, type Env } from "./scrape.ts";

const START_CRON = "0 */12 * * *";

export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    try {
      if (event.cron === START_CRON) {
        log.info("cron.start", { cron: event.cron });
        // Save anything still pending first, so a slow earlier run doesn't block the new one forever.
        await checkRuns(env);
        // Skip if a catch-up scrape already ran in the last 2 hours.
        log.info("cron.done", { cron: event.cron, ...(await catchUp(env, 2 * 3_600_000)) });
      } else {
        await checkRuns(env);
        const r = await catchUp(env);
        if (r.started) log.info("cron.caught_up", { cron: event.cron, ...r });
      }
    } catch (e) {
      log.error("cron.failed", e, { cron: event.cron });
      throw e; // also marks the invocation as failed in Cloudflare's dashboard
    }
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(req.url).pathname;
    try {
      if (!(await authorized(req, env))) {
        log.warn("http.unauthorized", { method: req.method, path, workerHasToken: !!env.API_TOKEN });
        return json({ error: "Missing or wrong API token" }, 401);
      }
      return await route(req, env, ctx);
    } catch (e) {
      if (e instanceof HttpError) {
        log.warn("http.error", { method: req.method, path, status: e.status, error: e.message });
        return json({ error: e.message }, e.status);
      }
      log.error("http.failed", e, { method: req.method, path });
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function authorized(req: Request, env: Env): Promise<boolean> {
  if (!env.API_TOKEN) return false; // refuse everything until a token is set
  const given = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(env.API_TOKEN);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "Expected a JSON body");
  }
}

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const m = req.method;
  const at = (...p: string[]) => p.length === parts.length && p.every((x, i) => x === "*" || x === parts[i]);

  if (m === "GET" && at("status")) return json(await status(env));
  if (m === "GET" && at("profiles")) return json(await profiles(env));
  if (m === "PUT" && at("profiles")) return json(await setProfiles(env, await body(req)));
  if (m === "GET" && at("profiles", "*", "history")) return json(await profileHistory(env, cleanUsername(parts[1])));
  if (m === "GET" && at("profiles", "*", "totals")) return json(await profileTotals(env, cleanUsername(parts[1])));
  if (m === "GET" && at("videos")) return json(await videos(env, url.searchParams.get("username")));
  if (m === "GET" && at("videos", "*", "history")) return json(await videoHistory(env, parts[1]));
  if (m === "POST" && at("scrape")) {
    const r = await startScrape(env, "manual");
    return json(r, r.started ? 202 : 409);
  }
  if (m === "POST" && at("scrape", "check")) {
    await checkRuns(env);
    return json(await status(env));
  }
  if (m === "GET" && at("links")) return json(await links(env));
  if (m === "PUT" && at("links")) return json(await putLinks(env, await body(req)));
  if (m === "DELETE" && at("links", "*")) return json(await deleteLink(env, parts[1]));
  throw new HttpError(404, `No route for ${m} ${url.pathname}`);
}

/* ---------- read ---------- */

async function status(env: Env) {
  const [runs, counts] = await Promise.all([
    env.DB.prepare("SELECT * FROM scrape_runs ORDER BY started_at DESC LIMIT 10").all(),
    env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM profiles WHERE active = 1) AS profiles, (SELECT COUNT(*) FROM videos) AS videos, (SELECT COUNT(*) FROM video_snapshots) AS snapshots",
    ).first(),
  ]);
  return { ...counts, runs: runs.results.map((r: any) => ({ ...r, profiles: JSON.parse(r.profiles) })) };
}

const SNAP_PROFILE = "followers, following, likes, videos, scraped_at";
const SNAP_VIDEO = "views, likes, comments, shares, saves, reposts, scraped_at";
/** Picks the given columns off a row with a prefix, e.g. latest_views → { views }. Null if there's no snapshot. */
function pick(row: any, prefix: string, cols: string): Record<string, unknown> | null {
  if (row[`${prefix}scraped_at`] == null) return null;
  return Object.fromEntries(cols.split(", ").map((c) => [c === "scraped_at" ? "scrapedAt" : c, row[`${prefix}${c}`]]));
}
const prefixed = (alias: string, prefix: string, cols: string) => cols.split(", ").map((c) => `${alias}.${c} AS ${prefix}${c}`).join(", ");

async function profiles(env: Env) {
  const { results } = await env.DB.prepare(
    `WITH ranked AS (
       SELECT *, ROW_NUMBER() OVER (PARTITION BY username ORDER BY scraped_at DESC) AS rn FROM profile_snapshots
     )
     SELECT p.*, ${prefixed("l", "latest_", SNAP_PROFILE)}, ${prefixed("pv", "prev_", SNAP_PROFILE)}
     FROM profiles p
     LEFT JOIN ranked l ON l.username = p.username AND l.rn = 1
     LEFT JOIN ranked pv ON pv.username = p.username AND pv.rn = 2
     ORDER BY p.active DESC, p.username`,
  ).all<any>();
  return results.map((r) => ({
    username: r.username,
    active: !!r.active,
    addedAt: r.added_at,
    nickname: r.nickname,
    avatarUrl: r.avatar_url,
    lastScrapedAt: r.last_scraped_at,
    lastError: r.last_error,
    latest: pick(r, "latest_", SNAP_PROFILE),
    previous: pick(r, "prev_", SNAP_PROFILE),
  }));
}

async function profileHistory(env: Env, username: string) {
  const { results } = await env.DB.prepare(`SELECT ${SNAP_PROFILE} FROM profile_snapshots WHERE username = ? ORDER BY scraped_at`)
    .bind(username)
    .all<any>();
  return results.map((r) => pick(r, "", SNAP_PROFILE));
}

/**
 * One point per scrape: every post's numbers added up, plus followers from the same scrape.
 * Posts that weren't returned by a scrape (deleted, or past MAX_POSTS_PER_PROFILE) aren't in its sum.
 */
async function profileTotals(env: Env, username: string) {
  const { results } = await env.DB.prepare(
    `SELECT s.run_id, MIN(s.scraped_at) AS scraped_at, COUNT(*) AS posts,
            SUM(s.views) AS views, SUM(s.likes) AS likes, SUM(s.comments) AS comments,
            SUM(s.shares) AS shares, SUM(s.saves) AS saves, SUM(s.reposts) AS reposts,
            (SELECT p.followers FROM profile_snapshots p WHERE p.username = ?1 AND p.run_id = s.run_id) AS followers
     FROM video_snapshots s JOIN videos v ON v.id = s.video_id
     WHERE v.username = ?1
     GROUP BY s.run_id
     ORDER BY scraped_at`,
  )
    .bind(username)
    .all<any>();
  return results.map((r) => ({
    scrapedAt: r.scraped_at,
    posts: r.posts,
    views: r.views,
    likes: r.likes,
    comments: r.comments,
    shares: r.shares,
    saves: r.saves,
    reposts: r.reposts,
    followers: r.followers,
  }));
}

async function videos(env: Env, username: string | null) {
  const where = username ? "WHERE v.username = ?" : "";
  const stmt = env.DB.prepare(
    `WITH ranked AS (
       SELECT s.*, ROW_NUMBER() OVER (PARTITION BY s.video_id ORDER BY s.scraped_at DESC) AS rn
       FROM video_snapshots s ${username ? "JOIN videos v0 ON v0.id = s.video_id AND v0.username = ?" : ""}
     )
     SELECT v.*, ${prefixed("l", "latest_", SNAP_VIDEO)}, ${prefixed("pv", "prev_", SNAP_VIDEO)},
            k.post_id, k.post_name, k.hook, k.apps, k.my_app, k.my_app_slot, k.linked_by
     FROM videos v
     LEFT JOIN ranked l ON l.video_id = v.id AND l.rn = 1
     LEFT JOIN ranked pv ON pv.video_id = v.id AND pv.rn = 2
     LEFT JOIN post_links k ON k.video_id = v.id
     ${where}
     ORDER BY v.posted_at DESC`,
  );
  const u = username ? cleanUsername(username) : null;
  const { results } = await (u ? stmt.bind(u, u) : stmt).all<any>();
  return results.map((r) => ({
    id: r.id,
    username: r.username,
    url: r.url,
    caption: r.caption,
    postedAt: r.posted_at,
    isSlideshow: !!r.is_slideshow,
    isPinned: !!r.is_pinned,
    coverUrl: r.cover_url,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    latest: pick(r, "latest_", SNAP_VIDEO),
    previous: pick(r, "prev_", SNAP_VIDEO),
    link: r.post_id ? linkOut(r) : null,
  }));
}

async function videoHistory(env: Env, id: string) {
  const { results } = await env.DB.prepare(`SELECT ${SNAP_VIDEO} FROM video_snapshots WHERE video_id = ? ORDER BY scraped_at`)
    .bind(id)
    .all<any>();
  return results.map((r) => pick(r, "", SNAP_VIDEO));
}

/* ---------- profiles ---------- */

/** The app sends its full account list; accounts no longer in it stop being scraped but keep their history. */
async function setProfiles(env: Env, b: { usernames?: unknown }) {
  if (!Array.isArray(b.usernames)) throw new HttpError(400, "Send { usernames: [...] }");
  const names = [...new Set(b.usernames.map((u) => cleanUsername(String(u))).filter((u) => /^[a-z0-9._]{2,24}$/.test(u)))];
  const at = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE profiles SET active = 0 WHERE username NOT IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(names)),
    ...names.map((u) =>
      env.DB.prepare("INSERT INTO profiles (username, active, added_at) VALUES (?, 1, ?) ON CONFLICT (username) DO UPDATE SET active = 1").bind(u, at),
    ),
  ]);
  return profiles(env);
}

/* ---------- links ---------- */

interface LinkIn {
  videoId?: string;
  postId?: string;
  username?: string;
  postName?: string;
  hook?: string;
  apps?: string[];
  myApp?: string | null;
  myAppSlot?: number | null;
  linkedBy?: string;
}

function linkOut(r: any) {
  return {
    videoId: r.video_id ?? r.id,
    postId: r.post_id,
    postName: r.post_name,
    hook: r.hook,
    apps: r.apps ? JSON.parse(r.apps) : [],
    myApp: r.my_app,
    myAppSlot: r.my_app_slot,
    linkedBy: r.linked_by,
  };
}

async function links(env: Env) {
  const { results } = await env.DB.prepare("SELECT * FROM post_links ORDER BY linked_at DESC").all<any>();
  return results.map(linkOut);
}

/** Links (or re-links) TikTok posts to OpenUGC posts. A post or video already linked elsewhere is moved. */
async function putLinks(env: Env, b: { links?: LinkIn[] }) {
  if (!Array.isArray(b.links)) throw new HttpError(400, "Send { links: [...] }");
  const at = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  for (const l of b.links) {
    if (!l.videoId || !/^\d+$/.test(l.videoId) || !l.postId) throw new HttpError(400, "Each link needs a numeric videoId and a postId");
    stmts.push(
      env.DB.prepare("DELETE FROM post_links WHERE post_id = ? AND video_id <> ?").bind(l.postId, l.videoId),
      env.DB.prepare(
        `INSERT OR REPLACE INTO post_links (video_id, post_id, username, post_name, hook, apps, my_app, my_app_slot, linked_by, linked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        l.videoId,
        l.postId,
        cleanUsername(l.username),
        l.postName ?? null,
        l.hook ?? null,
        JSON.stringify(Array.isArray(l.apps) ? l.apps.map(String) : []),
        l.myApp ?? null,
        Number.isInteger(l.myAppSlot) ? l.myAppSlot : null,
        l.linkedBy === "auto" ? "auto" : "manual",
        at,
      ),
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
  return links(env);
}

async function deleteLink(env: Env, videoId: string) {
  await env.DB.prepare("DELETE FROM post_links WHERE video_id = ?").bind(videoId).run();
  return links(env);
}
