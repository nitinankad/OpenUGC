# OpenUGC metrics

A Cloudflare Worker that scrapes your TikTok accounts every 12 hours with Apify and keeps the
numbers for every post in Cloudflare D1. The OpenUGC app reads them on its Analytics page.

- **00:00 and 12:00 UTC**: starts one Apify run covering every account.
- **Every 10 minutes**: checks for finished runs and saves their results. Saving resumes where it
  left off if it's cut short. If no scrape has started in the last 12.5 hours (a missed cron, a
  failed run, or a fresh deploy), it starts one, at most 3 tries per 12.5 hours. So the first
  scrape happens within 10 minutes of deploying.

Nothing runs between invocations: every step reads its progress from D1, so deploys, Cloudflare
restarts and failed invocations don't lose work or double-count. Snapshots are keyed by
(post, scrape), so saving the same page twice just overwrites it.
- Each scrape stores, per post: views, likes, comments, shares, saves (and reposts, if Apify ever
  reports them). Per account: followers, following, total likes, post count. Snapshots are kept,
  so you can see growth over time.

## One-time setup

You need a Cloudflare account (the one with your R2 bucket is fine) and an Apify account.

```sh
cd backend
npm install
npx wrangler login

# 1. Create your config (wrangler.toml is gitignored), create the database,
#    then paste the printed database_id (and database_name, if you chose another) into wrangler.toml.
cp wrangler.example.toml wrangler.toml
npx wrangler d1 create openugc-metrics

# 2. Create the tables.
npm run db:migrate

# 3. Secrets. APIFY_TOKEN is at https://console.apify.com/settings/integrations.
#    API_TOKEN is any long random string; you'll paste the same one into OpenUGC's Settings.
npx wrangler secret put APIFY_TOKEN
npx wrangler secret put API_TOKEN

# 4. Deploy. Note the URL it prints (https://openugc-metrics.<you>.workers.dev).
npm run deploy
```

Then in OpenUGC → Settings → Analytics, enter the Worker URL and the same API_TOKEN, and press
**Save**. The app sends your account usernames to the Worker. Press **Scrape now** on the
Analytics page for the first scrape instead of waiting for the next 12-hour mark.

A quick way to make a random token: `node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"`.

## Check what Apify returns first (optional, a few cents)

```sh
APIFY_TOKEN=... npm run sample -- yourtiktokusername          # Git Bash / macOS
$env:APIFY_TOKEN="..."; npm run sample -- yourtiktokusername  # PowerShell
```

This prints the latest 3 posts with their numbers and every field name, so you can confirm
slideshows come through and whether `repostCount` exists.

## Cost

Apify's `clockworks/tiktok-scraper` charges per post scraped (from about $1.70 per 1,000; check
the actor's pricing tab). Every scrape re-reads every post on every account, so:

    monthly cost ≈ total posts across accounts × 60 scrapes × price per post

For example 3 accounts × 100 posts → 18,000 results a month ≈ $31. Lower
`MAX_POSTS_PER_PROFILE` in `wrangler.toml` to only re-scrape the newest posts, or set
`MAX_CHARGE_USD` to cap each run. Cloudflare's free tier covers the Worker and D1 at this size.

## API

Every request needs `Authorization: Bearer <API_TOKEN>`.

| Method | Path | What it does |
|---|---|---|
| GET | `/status` | counts and the last 10 scrapes |
| GET | `/profiles` | accounts with latest and previous follower numbers |
| PUT | `/profiles` | `{ "usernames": [...] }`: the full account list; missing ones stop being scraped |
| GET | `/profiles/:username/history` | every follower snapshot |
| GET | `/videos?username=` | posts with latest and previous numbers and their OpenUGC link |
| GET | `/videos/:id/history` | every snapshot of one post |
| POST | `/scrape` | start a scrape now (409 if one is running) |
| POST | `/scrape/check` | save finished scrapes now instead of waiting for the 10-minute check |
| GET / PUT | `/links` | `{ "links": [{ videoId, postId, username, postName, hook, apps, myApp, myAppSlot, linkedBy }] }` |
| DELETE | `/links/:videoId` | unlink a post |

## Local development

```sh
printf 'APIFY_TOKEN=...\nAPI_TOKEN=dev\n' > .dev.vars
npm run db:migrate:local
npm run dev        # then: curl "http://localhost:8787/__scheduled?cron=0+*/12+*+*+*"
npm test           # unit tests for reading Apify's items
npm run typecheck
```
