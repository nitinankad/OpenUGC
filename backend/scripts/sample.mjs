// Scrapes the latest 3 posts of one profile and prints the fields Apify returns, so you can
// check the numbers before deploying. Costs a few cents at most.
//
//   APIFY_TOKEN=... npm run sample -- yourusername        (Git Bash / macOS)
//   $env:APIFY_TOKEN="..."; npm run sample -- yourusername (PowerShell)

const token = process.env.APIFY_TOKEN;
const username = (process.argv[2] || "").replace(/^@/, "");
if (!token || !username) {
  console.error("Usage: APIFY_TOKEN=... npm run sample -- <tiktok username>");
  process.exit(1);
}

const res = await fetch("https://api.apify.com/v2/acts/clockworks~tiktok-scraper/run-sync-get-dataset-items?timeout=300", {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    profiles: [username],
    profileScrapeSections: ["videos"],
    resultsPerPage: 3,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
    shouldDownloadSlideshowImages: false,
    shouldDownloadAvatars: false,
    shouldDownloadSubtitles: false,
  }),
});
if (!res.ok) {
  console.error(`Apify said ${res.status}: ${(await res.text()).slice(0, 500)}`);
  process.exit(1);
}
const items = await res.json();
console.log(`${items.length} item(s)\n`);
for (const it of items) {
  if (it.errorCode || it.error) {
    console.log("Error item:", it.errorCode, it.error);
    continue;
  }
  console.log({
    id: it.id,
    url: it.webVideoUrl,
    posted: it.createTimeISO,
    slideshow: it.isSlideshow,
    views: it.playCount,
    likes: it.diggCount,
    comments: it.commentCount,
    shares: it.shareCount,
    saves: it.collectCount,
    reposts: it.repostCount ?? "(not returned)",
    followers: it.authorMeta?.fans,
  });
}
if (items[0]) {
  console.log("\nAll top-level fields:", Object.keys(items[0]).sort().join(", "));
  console.log("Count-like fields:", Object.keys(items[0]).filter((k) => /count/i.test(k)).join(", "));
}
