// Turns Apify TikTok scraper items into database rows. No Worker APIs, so it can be unit tested.

/** The fields we read from one dataset item (clockworks/tiktok-scraper). Everything is optional: never trust it. */
export interface ApifyItem {
  id?: string | number;
  text?: string;
  createTimeISO?: string;
  createTime?: number;
  webVideoUrl?: string;
  playCount?: number;
  diggCount?: number;
  commentCount?: number;
  shareCount?: number;
  collectCount?: number;
  repostCount?: number;
  isSlideshow?: boolean;
  isPinned?: boolean;
  fromProfileSection?: string;
  input?: string;
  videoMeta?: { coverUrl?: string; originalCoverUrl?: string };
  authorMeta?: {
    id?: string | number;
    name?: string;
    nickName?: string;
    avatar?: string;
    fans?: number;
    following?: number;
    heart?: number;
    video?: number;
    privateAccount?: boolean;
  };
  // Error items (e.g. a private or empty profile).
  error?: string;
  errorCode?: string;
  url?: string;
}

export interface VideoRow {
  id: string;
  username: string;
  url: string | null;
  caption: string | null;
  postedAt: string | null;
  isSlideshow: boolean;
  isPinned: boolean;
  coverUrl: string | null;
}

export interface Metrics {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  reposts: number | null;
}

export interface ProfileRow {
  username: string;
  tiktokId: string | null;
  nickname: string | null;
  avatarUrl: string | null;
  followers: number | null;
  following: number | null;
  likes: number | null;
  videos: number | null;
}

export type Parsed =
  | { kind: "post"; video: VideoRow; metrics: Metrics; profile: ProfileRow }
  | { kind: "error"; username: string | null; code: string }
  | { kind: "skip"; reason: string };

/** "@Some.User" or a profile link → "some.user". */
export function cleanUsername(s: string | null | undefined): string {
  let u = String(s ?? "").trim();
  const m = u.match(/tiktok\.com\/@([^/?#]+)/i);
  if (m) u = m[1];
  return u.replace(/^@+/, "").toLowerCase();
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

function postedAt(item: ApifyItem): string | null {
  if (item.createTimeISO && !Number.isNaN(Date.parse(item.createTimeISO))) return new Date(item.createTimeISO).toISOString();
  if (typeof item.createTime === "number") return new Date(item.createTime * 1000).toISOString();
  return null;
}

/**
 * One dataset item → a post with its numbers, an error for a profile, or something to skip.
 * `wanted` are the usernames in this scrape: posts by anyone else (e.g. reposts) are skipped.
 */
export function parseItem(item: ApifyItem, wanted: Set<string>): Parsed {
  if (item.errorCode || item.error) {
    const who = cleanUsername(item.input || item.url);
    return { kind: "error", username: wanted.has(who) ? who : null, code: item.errorCode || "ERROR" };
  }
  if (item.fromProfileSection && item.fromProfileSection.toLowerCase() !== "videos") {
    return { kind: "skip", reason: `section ${item.fromProfileSection}` };
  }
  const id = item.id == null ? "" : String(item.id);
  if (!/^\d+$/.test(id)) return { kind: "skip", reason: "no post id" };
  const username = cleanUsername(item.authorMeta?.name || item.input);
  if (!wanted.has(username)) return { kind: "skip", reason: `not one of ours (${username || "unknown"})` };

  const a = item.authorMeta || {};
  return {
    kind: "post",
    video: {
      id,
      username,
      url: str(item.webVideoUrl) ?? `https://www.tiktok.com/@${username}/video/${id}`,
      caption: typeof item.text === "string" ? item.text : null,
      postedAt: postedAt(item),
      isSlideshow: !!item.isSlideshow,
      isPinned: !!item.isPinned,
      coverUrl: str(item.videoMeta?.coverUrl) ?? str(item.videoMeta?.originalCoverUrl),
    },
    metrics: {
      views: num(item.playCount),
      likes: num(item.diggCount),
      comments: num(item.commentCount),
      shares: num(item.shareCount),
      saves: num(item.collectCount),
      reposts: num(item.repostCount),
    },
    profile: {
      username,
      tiktokId: a.id == null ? null : String(a.id),
      nickname: str(a.nickName),
      avatarUrl: str(a.avatar),
      followers: num(a.fans),
      following: num(a.following),
      likes: num(a.heart),
      videos: num(a.video),
    },
  };
}

/** The TikTok post id in a link like https://www.tiktok.com/@user/video/7353646097262202145 (or /photo/). */
export function videoIdFromUrl(url: string | null | undefined): string | null {
  const m = String(url ?? "").match(/\/(?:video|photo)\/(\d{8,})/);
  return m ? m[1] : null;
}
