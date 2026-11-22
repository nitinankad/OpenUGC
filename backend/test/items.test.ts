import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanUsername, parseItem, videoIdFromUrl } from "../src/items.ts";

const wanted = new Set(["paperpond.app"]);

// Shape taken from the sample item on the clockworks/tiktok-profile-scraper page.
const sample = {
  id: "7353646097262202145",
  text: "6 apps for pen pals #penpal",
  createTime: 1712154160,
  createTimeISO: "2024-04-03T14:22:40.000Z",
  authorMeta: { id: "735357", name: "PaperPond.App", nickName: "Paper Pond", fans: 852, heart: 2611, video: 18, following: 1 },
  webVideoUrl: "https://www.tiktok.com/@paperpond.app/photo/7353646097262202145",
  videoMeta: { coverUrl: "https://p16.example/cover.jpg" },
  diggCount: 725,
  shareCount: 30,
  playCount: 83900,
  collectCount: 135,
  commentCount: 10,
  isSlideshow: true,
  isPinned: false,
  input: "paperpond.app",
};

test("maps a post and its numbers", () => {
  const p = parseItem(sample, wanted);
  assert.equal(p.kind, "post");
  if (p.kind !== "post") return;
  assert.equal(p.video.id, "7353646097262202145");
  assert.equal(p.video.username, "paperpond.app");
  assert.equal(p.video.postedAt, "2024-04-03T14:22:40.000Z");
  assert.equal(p.video.isSlideshow, true);
  assert.equal(p.video.coverUrl, "https://p16.example/cover.jpg");
  assert.deepEqual(p.metrics, { views: 83900, likes: 725, comments: 10, shares: 30, saves: 135, reposts: null });
  assert.equal(p.profile.followers, 852);
  assert.equal(p.profile.likes, 2611);
  assert.equal(p.profile.videos, 18);
});

test("keeps reposts when the scraper reports them", () => {
  const p = parseItem({ ...sample, repostCount: 4 }, wanted);
  assert.equal(p.kind === "post" && p.metrics.reposts, 4);
});

test("falls back to createTime and builds a link when fields are missing", () => {
  const { createTimeISO, webVideoUrl, ...rest } = sample;
  const p = parseItem(rest, wanted);
  assert.equal(p.kind === "post" && p.video.postedAt, "2024-04-03T14:22:40.000Z");
  assert.equal(p.kind === "post" && p.video.url, "https://www.tiktok.com/@paperpond.app/video/7353646097262202145");
});

test("skips other people's posts and non-video sections", () => {
  assert.equal(parseItem({ ...sample, authorMeta: { name: "someone.else" } }, wanted).kind, "skip");
  assert.equal(parseItem({ ...sample, fromProfileSection: "reposts" }, wanted).kind, "skip");
  assert.equal(parseItem({ ...sample, id: undefined }, wanted).kind, "skip");
});

test("reports profile errors", () => {
  const p = parseItem({ url: "https://www.tiktok.com/@paperpond.app", input: "paperpond.app", errorCode: "PROFILE_PRIVATE", error: "private" }, wanted);
  assert.deepEqual(p, { kind: "error", username: "paperpond.app", code: "PROFILE_PRIVATE" });
});

test("bad numbers become null, not NaN", () => {
  const p = parseItem({ ...sample, playCount: "lots" as unknown as number, diggCount: -3 }, wanted);
  assert.equal(p.kind === "post" && p.metrics.views, null);
  assert.equal(p.kind === "post" && p.metrics.likes, 0);
});

test("cleans usernames and reads post ids from links", () => {
  assert.equal(cleanUsername("@PaperPond.App"), "paperpond.app");
  assert.equal(cleanUsername("https://www.tiktok.com/@paperpond.app?lang=en"), "paperpond.app");
  assert.equal(videoIdFromUrl("https://www.tiktok.com/@a/video/7353646097262202145?is_from_webapp=1"), "7353646097262202145");
  assert.equal(videoIdFromUrl("https://www.tiktok.com/@a/photo/7353646097262202145"), "7353646097262202145");
  assert.equal(videoIdFromUrl("https://www.tiktok.com/@a"), null);
});
