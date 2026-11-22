-- TikTok accounts to scrape. Usernames are lowercase without the @.
CREATE TABLE profiles (
  username        TEXT PRIMARY KEY,
  active          INTEGER NOT NULL DEFAULT 1,  -- 0 = removed in the app; history is kept
  added_at        TEXT NOT NULL,
  tiktok_id       TEXT,
  nickname        TEXT,
  avatar_url      TEXT,
  last_scraped_at TEXT,
  last_error      TEXT                          -- e.g. PROFILE_PRIVATE from the last scrape
);

-- One row per account per scrape.
CREATE TABLE profile_snapshots (
  username   TEXT NOT NULL,
  run_id     TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  followers  INTEGER,
  following  INTEGER,
  likes      INTEGER,  -- total likes across the account
  videos     INTEGER,  -- number of posts
  PRIMARY KEY (username, run_id)
);
CREATE INDEX profile_snapshots_by_time ON profile_snapshots (username, scraped_at);

-- One row per TikTok post (video or photo slideshow).
CREATE TABLE videos (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL,
  url           TEXT,
  caption       TEXT,
  posted_at     TEXT,
  is_slideshow  INTEGER NOT NULL DEFAULT 0,
  is_pinned     INTEGER NOT NULL DEFAULT 0,
  cover_url     TEXT,     -- TikTok's signed link; it expires after a while
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL  -- stops moving if the post is deleted
);
CREATE INDEX videos_by_user ON videos (username, posted_at);

-- One row per post per scrape.
CREATE TABLE video_snapshots (
  video_id   TEXT NOT NULL,
  run_id     TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  views      INTEGER,
  likes      INTEGER,
  comments   INTEGER,
  shares     INTEGER,
  saves      INTEGER,
  reposts    INTEGER,  -- NULL when the scraper doesn't report it
  PRIMARY KEY (video_id, run_id)
);
CREATE INDEX video_snapshots_by_time ON video_snapshots (video_id, scraped_at);

-- One row per Apify run.
CREATE TABLE scrape_runs (
  id          TEXT PRIMARY KEY,  -- Apify run id
  trigger     TEXT NOT NULL,     -- schedule | manual
  profiles    TEXT NOT NULL,     -- JSON array of usernames
  status      TEXT NOT NULL,     -- running | saving | done | failed
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  dataset_id  TEXT,
  saved_items INTEGER NOT NULL DEFAULT 0,  -- how far saving has got, so it can resume
  total_items INTEGER,
  error       TEXT
);
CREATE INDEX scrape_runs_by_status ON scrape_runs (status, started_at);

-- TikTok post <-> OpenUGC post, with what the slideshow contained, for hook and app insights.
CREATE TABLE post_links (
  video_id    TEXT PRIMARY KEY,
  post_id     TEXT NOT NULL UNIQUE,
  username    TEXT NOT NULL,
  post_name   TEXT,
  hook        TEXT,
  apps        TEXT,     -- JSON array of app names in slide order
  my_app      TEXT,
  my_app_slot INTEGER,
  linked_by   TEXT NOT NULL,  -- auto | manual
  linked_at   TEXT NOT NULL
);
