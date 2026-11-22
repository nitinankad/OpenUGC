// Apify REST API v2: start the TikTok scraper, check on a run, read its results.

import type { ApifyItem } from "./items.ts";
import { log } from "./log.ts";

export interface ApifyEnv {
  APIFY_TOKEN: string;
  APIFY_ACTOR: string;
  MAX_POSTS_PER_PROFILE: string;
  MAX_CHARGE_USD?: string;
  /** Only for local testing against a stand-in server. */
  APIFY_API_BASE?: string;
}

export interface ApifyRun {
  id: string;
  status: string; // READY | RUNNING | SUCCEEDED | FAILED | TIMING-OUT | TIMED-OUT | ABORTING | ABORTED
  defaultDatasetId: string;
  startedAt?: string;
  finishedAt?: string;
  /** Apify's own explanation, e.g. why a run failed. */
  statusMessage?: string;
}

export const FINISHED_OK = "SUCCEEDED";
export const FINISHED_BAD = new Set(["FAILED", "TIMED-OUT", "ABORTED"]);

const base = (env: ApifyEnv) => (env.APIFY_API_BASE || "https://api.apify.com/v2").replace(/\/$/, "");

async function call<T>(env: ApifyEnv, path: string, init: RequestInit = {}): Promise<{ body: T; res: Response }> {
  if (!env.APIFY_TOKEN) throw new Error("APIFY_TOKEN isn't set. Run: npx wrangler secret put APIFY_TOKEN");
  const method = init.method || "GET";
  const where = path.split("?")[0];
  let res: Response;
  try {
    res = await fetch(`${base(env)}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${env.APIFY_TOKEN}`, "Content-Type": "application/json", ...(init.headers || {}) },
    });
  } catch (e) {
    log.error("apify.unreachable", e, { method, path: where });
    throw new Error(`Couldn't reach Apify (${method} ${where}): ${e instanceof Error ? e.message : e}`);
  }
  if (!res.ok) {
    const text = (await res.text()).slice(0, 1000);
    log.error("apify.http", `Apify answered ${res.status}`, { method, path: where, status: res.status, body: text });
    throw new Error(`Apify ${method} ${where} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return { body: (await res.json()) as T, res };
}

/** The scraper's input: every post of each profile, numbers only (no video, cover or image downloads). */
export function scraperInput(env: ApifyEnv, usernames: string[]) {
  const perProfile = Math.max(1, Number(env.MAX_POSTS_PER_PROFILE) || 1000);
  return {
    profiles: usernames,
    profileScrapeSections: ["videos"],
    resultsPerPage: perProfile,
    excludePinnedPosts: false,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
    shouldDownloadSlideshowImages: false,
    shouldDownloadAvatars: false,
    shouldDownloadMusicCovers: false,
    shouldDownloadSubtitles: false,
    downloadSubtitlesOptions: "NEVER_DOWNLOAD_SUBTITLES",
  };
}

export async function startRun(env: ApifyEnv, usernames: string[]): Promise<ApifyRun> {
  const q = new URLSearchParams();
  const cap = Number(env.MAX_CHARGE_USD);
  if (env.MAX_CHARGE_USD && cap > 0) q.set("maxTotalChargeUsd", String(cap));
  const { body } = await call<{ data: ApifyRun }>(env, `/acts/${env.APIFY_ACTOR}/runs${q.size ? `?${q}` : ""}`, {
    method: "POST",
    body: JSON.stringify(scraperInput(env, usernames)),
  });
  return body.data;
}

export async function getRun(env: ApifyEnv, runId: string): Promise<ApifyRun> {
  const { body } = await call<{ data: ApifyRun }>(env, `/actor-runs/${encodeURIComponent(runId)}`);
  return body.data;
}

/** One page of a run's results, plus the dataset's total item count. */
export async function getItems(env: ApifyEnv, datasetId: string, offset: number, limit: number): Promise<{ items: ApifyItem[]; total: number | null }> {
  const q = new URLSearchParams({ clean: "true", format: "json", offset: String(offset), limit: String(limit) });
  const { body, res } = await call<ApifyItem[]>(env, `/datasets/${encodeURIComponent(datasetId)}/items?${q}`);
  const total = Number(res.headers.get("X-Apify-Pagination-Total"));
  return { items: Array.isArray(body) ? body : [], total: Number.isFinite(total) && res.headers.has("X-Apify-Pagination-Total") ? total : null };
}
