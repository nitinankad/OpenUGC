const { invoke, convertFileSrc } = window.__TAURI__.core;

const MAX_APPS = 6;
const OVERVIEW_LIMIT = 140;
const MAX_HASHTAGS = 5;
const WRITER_NAMES = { claude: "Claude", codex: "Codex" };

const DEFAULT_COLORS = { accent: "#0b8a67", text: "#15171c", background: "#ffffff", wallpaper: "#e9ecef" };
const DEFAULT_SLIDE_OPTIONS = {
  hookAccent: "hidden gems",
  hookLine2: "of the",
  hookLine3: "App Store",
  part: 1,
  ctaAccent: "save & follow",
  ctaLine2: "for more",
  ctaLine3: "hidden gems",
  ...DEFAULT_COLORS,
};

/** Slideshow formats. Each account picks one; each post keeps the format it was made with. */
const FORMATS = { gems: "Hidden gem apps", drawn: "Relatable drawings", spotlight: "App spotlight" };
const DEFAULT_DRAWN_STYLE = { background: "#faf9f6", text: "#111111", accent: "#e0201b" };
/** App spotlight: screenshot slides by default, and the look that carries over between posts. */
const DEFAULT_SPOT_COUNT = 3;
const DEFAULT_SPOT_LOOK = { windowTitle: "Notes", color: "#0a84ff" };
const DEFAULT_POINTS = 6;
/** Drawings made at once; each is a separate Codex or Claude run. */
const DRAW_PARALLEL = 3;

/*
 * Saved state. Accounts are TikTok usernames; each post belongs to one account and holds
 * everything for one slideshow. Prepared apps are a shared cache so a gem used in two posts
 * is only downloaded once.
 */
const state = {
  version: 2,
  writer: "claude",
  /** Who draws for the relatable-drawings format: "codex" (image generation) or "claude" (SVG). */
  artist: "codex",
  filter: { country: "us", minRating: 4.5, minRatings: 30, maxRatings: 5000, maxDaysSinceUpdate: 365 },
  /** Latest search results, shared by all posts. */
  results: [],
  resultsNiche: "",
  /** Shown above the results, e.g. which suggestions weren't on the App Store. */
  resultsNote: "",
  prepared: [],
  /** { id, username, format, myApp, myAppSlot, createdAt } */
  accounts: [],
  /**
   * { id, accountId, format, name, createdAt, niche, picked, slideOptions, slides, caption, phone, posted, drawn }
   * phone (after Send to phone): { folder, url, sentAt, renderedAt, text } (renderedAt and text are what was sent)
   * posted (marked by you): { at, link? }
   * drawn (relatable drawings only): { topic, points, accent, slides: [{ id, text, scene, image }], plug, style }
   * spotlight (app spotlight only): { hook, accent, lines: [{ id, trackId, text, shot, image }] (one per app), cta, windowTitle, color, desk }
   */
  posts: [],
  currentPostId: null,
};
const ui = {
  view: "board",
  searching: false,
  /** "search" or "suggest" while one is running. */
  searchKind: "search",
  rendering: false,
  hooking: false,
  busy: new Set(),
  /** Relatable drawings: writing the script, and ids of slides being drawn or waiting their turn. */
  writing: false,
  drawing: new Set(),
  drawActive: new Set(),
  drawQueue: [],
  justAdded: null,
  mine: { editing: false, searching: false, results: [] },
  settings: null,
  post: { writing: false, sending: false },
  /** The QR code drawn for the open post's phone link. */
  qr: { url: "", svg: "" },
  /** Account form open on the board: null, "new", or an account id. */
  editingAccount: null,
  /** Delete button waiting for a second click, e.g. "post:<id>". */
  confirm: null,
  /** App spotlight: desk photos ({ path, screen, width, height }), and what's running. */
  desks: [],
  desksLoaded: false,
  spotWriting: false,
  makingDesk: false,
  /** Ids of spotlight slides whose own screenshot is being saved. */
  uploading: new Set(),
  /** Marking a desk's screen: { path, width, height, points: [[x, y]] in photo pixels }. */
  marking: null,
};

/* ---------- helpers ---------- */
const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fileSrc = (p) => (p ? convertFileSrc(p) : "");
const fmtCount = (n) => new Intl.NumberFormat().format(n);
const fmtMonth = (iso) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", year: "numeric" }) : "Unknown";
const fmtWhen = (iso) =>
  iso
    ? new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "No time";
const mixHex = (a, b, t) => {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(",")})`;
};
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const cleanUsername = (s) => String(s || "").trim().replace(/^@+/, "");
const handle = (a) => (a?.username ? `@${a.username}` : "Unnamed account");

const post = () => state.posts.find((p) => p.id === state.currentPostId) || null;
const accountOf = (p) => state.accounts.find((a) => a.id === p?.accountId) || null;
const acct = () => accountOf(post());
const postsOf = (a) => state.posts.filter((p) => p.accountId === a.id).sort((x, y) => x.createdAt - y.createdAt);
const picked = () => post()?.picked || [];
const opts = () => post()?.slideOptions || DEFAULT_SLIDE_OPTIONS;
/** The account's own app, unless this post leaves it out. */
const ownAppOf = (p) => (p && !p.skipMine && accountOf(p)?.myApp) || null;
const myApp = () => ownAppOf(post());
const mySlot = () => acct()?.myAppSlot || 3;
const isPicked = (id) => picked().some((a) => a.trackId === id);
const preparedFor = (id) => state.prepared.find((p) => p.app.trackId === id);
const isMine = (id) => myApp()?.trackId === id;
const formatOf = (p) => (FORMATS[p?.format] ? p.format : "gems");
const cleanFormat = (f) => (FORMATS[f] ? f : "gems");
const isDrawn = (p = post()) => formatOf(p) === "drawn";
const drawnOf = (p = post()) => p?.drawn || null;
const isSpot = (p = post()) => formatOf(p) === "spotlight";
const spotOf = (p = post()) => p?.spotlight || null;
/** Apps a post holds. */
const maxApps = () => MAX_APPS;
/** How many gems fit next to the account's own app. */
const gemCapacity = () => maxApps() - (myApp() ? 1 : 0);
/** The headline a post goes out with, whatever its format. */
const postHook = (p) =>
  isDrawn(p) ? drawnOf(p)?.slides?.[0]?.text?.trim() || "" : isSpot(p) ? spotOf(p)?.hook?.trim() || "" : hookText(p.slideOptions);

/** Every app in a post, in slide order: the gems with the account's app at its chosen position. */
function lineupFor(p) {
  if (!p || isDrawn(p)) return [];
  const mine = ownAppOf(p);
  const apps = [...p.picked];
  if (mine) apps.splice(Math.min((accountOf(p).myAppSlot || 3) - 1, apps.length), 0, mine);
  return apps;
}
const lineup = () => lineupFor(post());
/** Prepared apps for the current post, in slide order. */
const slideApps = () => lineup().map((a) => preparedFor(a.trackId)).filter(Boolean);

/* ---------- persistence ---------- */
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    invoke("save_state", { state }).catch((e) => toast(`Couldn't save your work: ${e}`, true));
  }, 400);
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("is-error", isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 7000 : 3000);
}

/** Two-click delete: the first click arms the button, a second within 4 seconds confirms. */
let confirmTimer;
function confirmed(key) {
  if (ui.confirm === key) {
    ui.confirm = null;
    return true;
  }
  ui.confirm = key;
  clearTimeout(confirmTimer);
  confirmTimer = setTimeout(() => {
    ui.confirm = null;
    renderBoard();
  }, 4000);
  renderBoard();
  return false;
}

/* ---------- navigation ---------- */
const POST_VIEWS = ["find", "prepare", "write", "slides"];

function setView(view) {
  if (POST_VIEWS.includes(view) && !post()) view = "board";
  // Each format has its own steps before Slides.
  if (isDrawn() && (view === "find" || view === "prepare")) view = "write";
  if (post() && !isDrawn() && view === "write") view = "find";
  ui.view = view;
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("is-active", b.dataset.view === view));
  for (const v of ["board", ...POST_VIEWS, "analytics", "settings"]) $(`#view-${v}`).hidden = v !== view;
  // The hook preview has nothing to do with analytics, so its charts get the room.
  $(".shell").classList.toggle("no-tray", view === "analytics");
  if (view === "board") renderBoard();
  if (view === "analytics") loadAnalytics();
  else clearTimeout(pollTimer);
  if (view === "slides") {
    renderSlides();
    // Pick up photos added to the desks folder since last time.
    if (isSpot()) loadDesks();
  }
  if (view === "settings") renderSettings();
  if (view === "find") {
    $("#niche").value = post()?.niche || "";
    renderHookIdeas();
  }
  if (view === "write") {
    $("#drawn-topic").value = drawnOf()?.topic || "";
    renderWrite();
  }
}

function renderRail() {
  const p = post();
  $("#rail-post").hidden = !p;
  const fmt = formatOf(p);
  // The hook ideas in Find are list hooks ("6 apps for…"); a spotlight writes its own in Slides.
  $(".hook-start").hidden = isSpot(p);
  $("#find-title").textContent = isSpot(p) ? "Find apps to spotlight" : "Find hidden gems";
  document.querySelectorAll(".nav-step").forEach((b) => {
    b.disabled = !p;
    if (b.dataset.format) b.hidden = !b.dataset.format.split(" ").includes(fmt);
  });
  if (!p) return;
  $("#rail-account").textContent = handle(acct());
  const name = $("#post-name");
  if (document.activeElement !== name) name.value = p.name;
  $("#nav-prepared").textContent = slideApps().length || "";
}

/* ---------- Posts board ---------- */
function postStatus(p) {
  if (p.posted) return { cls: "status-sent", label: "Posted", detail: fmtWhen(p.posted.at) };
  if (p.phone) return { cls: "status-phone", label: "On phone", detail: fmtWhen(p.phone.sentAt) };
  if (p.slides) return { cls: "status-ready", label: "Slides ready", detail: "" };
  if (isDrawn(p)) {
    const s = drawnOf(p)?.slides || [];
    const drawn = s.filter((x) => x.image).length;
    return { cls: "", label: "Draft", detail: s.length ? `${drawn} of ${s.length} slides drawn` : "Not written yet" };
  }
  const lu = lineupFor(p);
  return { cls: "", label: "Draft", detail: lu.length ? `${lu.length} of ${MAX_APPS} apps` : "No apps yet" };
}

function accountForm(a) {
  const id = a ? a.id : "new";
  return `<form class="acct-form" data-acct-form="${id}" autocomplete="off">
    <label class="field">TikTok username <input name="username" type="text" spellcheck="false" placeholder="@yourhandle" value="${esc(a ? handle(a).replace("Unnamed account", "") : "")}" /></label>
    <label class="field">Slideshow format
      <select name="format">
        ${Object.entries(FORMATS)
          .map(([k, label]) => `<option value="${k}" ${(a?.format || "gems") === k ? "selected" : ""}>${esc(label)}</option>`)
          .join("")}
      </select>
      <span class="field-note">New posts use this format. Existing posts keep theirs.</span>
    </label>
    <div class="inline">
      <button type="submit" class="btn btn-primary btn-sm">${a ? "Save" : "Add account"}</button>
      <button type="button" class="btn btn-quiet" data-acct-cancel>Cancel</button>
    </div>
  </form>`;
}

function postCard(p) {
  const st = postStatus(p);
  const lu = lineupFor(p);
  const hookSlide = drawnOf(p)?.slides?.[0];
  const thumb = p.slides?.slides?.[0]
    ? `<img class="card-slide" src="${esc(fileSrc(p.slides.slides[0]))}?v=${p.slides.renderedAt || 0}" alt="" />`
    : isDrawn(p)
      ? hookSlide?.text
        ? `<div class="card-drawn">${hookSlide.image ? `<img src="${esc(fileSrc(hookSlide.image))}" alt="" />` : ""}<span>${esc(hookSlide.text)}</span></div>`
        : `<div class="card-empty">Not written yet</div>`
      : lu.length
      ? `<div class="card-icons">${lu
          .map((a) => {
            const pr = preparedFor(a.trackId);
            return `<img src="${esc(pr?.icon ? fileSrc(pr.icon) : a.artworkUrl100 || "")}" alt="" />`;
          })
          .join("")}</div>`
      : `<div class="card-empty">No apps yet</div>`;
  const armed = ui.confirm === `post:${p.id}`;
  return `<article class="card ${p.id === state.currentPostId ? "is-current" : ""}">
    <button class="card-open" data-open-post="${p.id}" aria-label="Open ${esc(p.name)}">
      <div class="card-thumb">${thumb}</div>
      <div class="card-name">${esc(p.name)}</div>
      <div class="card-meta"><span class="status ${st.cls}">${esc(st.label)}</span><span>${esc(st.detail)}</span></div>
    </button>
    <button class="card-delete ${armed ? "is-armed" : ""}" data-delete-post="${p.id}">${armed ? "Click again to delete" : "Delete"}</button>
  </article>`;
}

function renderBoard() {
  $("#add-account").hidden = ui.editingAccount === "new";

  const parts = [];
  if (ui.editingAccount === "new") parts.push(`<section class="acct">${accountForm(null)}</section>`);
  for (const a of state.accounts) {
    const armed = ui.confirm === `acct:${a.id}`;
    const posts = postsOf(a);
    const head =
      ui.editingAccount === a.id
        ? accountForm(a)
        : `<header class="acct-head">
            <div>
              <h2>${esc(handle(a))}</h2>
              <p class="acct-sub">${esc(FORMATS[a.format] || FORMATS.gems)}${a.myApp ? `. Promotes ${esc(a.myApp.trackName)}` : ""}</p>
            </div>
            <div class="inline">
              <button class="btn btn-quiet" data-edit-acct="${a.id}">Edit</button>
              <button class="btn btn-quiet ${armed ? "is-armed" : ""}" data-delete-acct="${a.id}">${armed ? `Delete ${posts.length} post${posts.length === 1 ? "" : "s"} too?` : "Delete"}</button>
            </div>
          </header>`;
    parts.push(`<section class="acct">
      ${head}
      <div class="cards">
        ${posts.map(postCard).join("")}
        <button class="card card-new" data-new-post="${a.id}"><span>New post</span></button>
      </div>
    </section>`);
  }
  $("#board").innerHTML = parts.join("");
  $("#board-empty").hidden = state.accounts.length > 0 || ui.editingAccount === "new";
}

function newPost(accountId) {
  const a = state.accounts.find((x) => x.id === accountId);
  if (!a) return;
  const format = cleanFormat(a.format);
  // Carry the account's look over from its latest post of the same format, and bump the part number.
  const prev = postsOf(a).filter((q) => formatOf(q) === format).at(-1);
  const slideOptions = prev ? { ...prev.slideOptions } : { ...DEFAULT_SLIDE_OPTIONS };
  if (prev && Number(slideOptions.part) > 0) slideOptions.part = Number(slideOptions.part) + 1;
  // Each post starts with a blank hook; colours and the rest carry over.
  Object.assign(slideOptions, { hookAccent: "", hookLine2: "", hookLine3: "" });
  const p = {
    id: uid(),
    accountId,
    format,
    drawn:
      format === "drawn"
        ? { topic: "", points: prev?.drawn?.points || DEFAULT_POINTS, accent: "", slides: [], plug: null, style: { ...DEFAULT_DRAWN_STYLE, ...(prev?.drawn?.style || {}) } }
        : undefined,
    // A new spotlight starts with blank words and lets Make slides pick a desk; the window look carries over.
    spotlight: format === "spotlight" ? newSpotlight(prev?.spotlight) : undefined,
    name: `Post ${postsOf(a).length + 1}`,
    createdAt: Date.now(),
    niche: "",
    picked: [],
    slideOptions,
    slides: null,
    caption: { title: "", caption: "", hashtags: [] },
    phone: null,
    posted: null,
  };
  state.posts.push(p);
  // A new post starts with a clean search, not the last post's results.
  if (!ui.searching) Object.assign(state, { results: [], resultsNiche: "", resultsNote: "" });
  openPost(p.id, format === "drawn" ? "write" : "find");
  save();
}

function newSpotlight(prev) {
  return {
    count: prev?.count || DEFAULT_SPOT_COUNT,
    hook: "",
    accent: "",
    lines: [],
    cta: "",
    windowTitle: prev?.windowTitle ?? DEFAULT_SPOT_LOOK.windowTitle,
    color: prev?.color || DEFAULT_SPOT_LOOK.color,
    desk: null,
  };
}

function openPost(id, view) {
  const p = state.posts.find((x) => x.id === id);
  if (!p) return;
  state.currentPostId = id;
  ui.mine = { editing: false, searching: false, results: [] };
  renderSlideSettings();
  renderAll();
  setView(view || (p.slides ? "slides" : isDrawn(p) ? "write" : lineupFor(p).length ? "prepare" : "find"));
  save();
}

function saveAccountForm(form) {
  const id = form.dataset.acctForm;
  const username = cleanUsername(form.username.value);
  if (!username) return toast("Enter the TikTok username for this account.", true);
  const format = cleanFormat(form.format?.value);
  if (id === "new") {
    const first = state.accounts[0];
    state.accounts.push({
      id: uid(),
      username,
      format,
      // New accounts start out promoting the same app as the first one; change it per account.
      myApp: first?.myApp || null,
      myAppSlot: first?.myAppSlot || 3,
      createdAt: Date.now(),
    });
  } else {
    const a = state.accounts.find((x) => x.id === id);
    if (!a) return;
    a.username = username;
    a.format = format;
  }
  ui.editingAccount = null;
  renderAll();
  save();
  syncProfiles();
}

function startAccountForm(id) {
  ui.editingAccount = id;
  renderBoard();
  $(`[data-acct-form="${id}"] input[name="username"]`)?.focus();
}

function bindBoard() {
  $("#add-account").addEventListener("click", () => startAccountForm("new"));
  const board = $("#board");
  board.addEventListener("submit", (e) => {
    e.preventDefault();
    saveAccountForm(e.target);
  });
  board.addEventListener("click", (e) => {
    const t = (sel) => e.target.closest(sel);
    let b;
    if ((b = t("[data-open-post]"))) return openPost(b.dataset.openPost);
    if ((b = t("[data-new-post]"))) return newPost(b.dataset.newPost);
    if ((b = t("[data-edit-acct]"))) return startAccountForm(b.dataset.editAcct);
    if (t("[data-acct-cancel]")) {
      ui.editingAccount = null;
      return renderBoard();
    }
    if ((b = t("[data-delete-post]"))) {
      const id = b.dataset.deletePost;
      if (!confirmed(`post:${id}`)) return;
      state.posts = state.posts.filter((p) => p.id !== id);
      if (state.currentPostId === id) state.currentPostId = null;
      renderAll();
      return save();
    }
    if ((b = t("[data-delete-acct]"))) {
      const id = b.dataset.deleteAcct;
      if (!confirmed(`acct:${id}`)) return;
      state.accounts = state.accounts.filter((a) => a.id !== id);
      state.posts = state.posts.filter((p) => p.accountId !== id);
      if (!post()) state.currentPostId = null;
      renderAll();
      syncProfiles();
      return save();
    }
  });
}

/* ---------- Repeat guard ---------- */
/** Uses within this many days (and drafts, which are still to come) count as recent. */
const RECENT_DAYS = 30;
const DAY_MS = 86_400_000;
const isMade = (p) => !!(p.slides || p.phone || p.posted);
/** When a post went out: when you marked it posted, else sent it to your phone, else made its slides, else created it. */
const postTime = (p) => p.posted?.at || p.phone?.sentAt || p.slides?.renderedAt || p.createdAt;
const hookKey = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const isRecent = (p) => !isMade(p) || Math.abs(Date.now() - postTime(p)) <= RECENT_DAYS * DAY_MS;
function ago(t) {
  const d = Math.round((Date.now() - t) / DAY_MS);
  if (d < 0) return d === -1 ? "tomorrow" : `in ${-d} days`;
  return d === 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
}
const repeatLabel = (p) => (isMade(p) ? `${p.name}, ${ago(postTime(p))}` : `${p.name} (draft)`);

/** This account's other posts with the app, newest first. */
function appRepeats(id, p = post()) {
  const a = accountOf(p);
  if (!a) return [];
  return postsOf(a)
    .filter((q) => q.id !== p.id && q.picked.some((x) => x.trackId === id))
    .sort((x, y) => postTime(y) - postTime(x));
}

/** This account's other posts that went out with the same hook. Drafts don't count: new posts start with the last post's hook. */
function hookRepeats(text, p = post()) {
  const a = accountOf(p);
  const key = hookKey(text);
  if (!a || !key) return [];
  return postsOf(a)
    .filter((q) => q.id !== p?.id && isMade(q) && hookKey(postHook(q)) === key)
    .sort((x, y) => postTime(y) - postTime(x));
}

/* ---------- Find ---------- */
function renderResults() {
  const list = $("#results");
  const hasResults = state.results.length > 0;
  $("#results-head").hidden = !hasResults;
  $("#find-empty").hidden = hasResults || ui.searching;
  const writer = WRITER_NAMES[state.writer];
  const suggesting = ui.searching && ui.searchKind === "suggest";
  $("#search-btn").disabled = ui.searching;
  $("#search-btn").textContent = ui.searching && !suggesting ? "Searching" : "Search";
  $("#suggest-btn").disabled = ui.searching;
  $("#suggest-btn").textContent = suggesting ? `Asking ${writer}` : `Ask ${writer}`;
  $("#results-note").hidden = ui.searching || !state.resultsNote || !hasResults;
  $("#results-note").textContent = state.resultsNote;

  if (ui.searching) {
    list.innerHTML = suggesting
      ? `<li class="loading-row"><span class="spinner"></span>${esc(writer)} is picking apps${state.resultsNiche ? ` for "${esc(state.resultsNiche)}"` : ""}, then each one is looked up on the App Store</li>`
      : `<li class="loading-row"><span class="spinner"></span>Searching the App Store for "${esc(state.resultsNiche)}"</li>`;
    return;
  }
  const full = picked().length >= gemCapacity();
  list.innerHTML = state.results
    .map((a) => {
      const on = isPicked(a.trackId);
      const mine = isMine(a.trackId);
      const icon = a.artworkUrl100 || a.artworkUrl512 || "";
      const reps = mine ? [] : appRepeats(a.trackId);
      const used = reps.length
        ? `<span class="repeat ${isRecent(reps[0]) ? "is-recent" : ""}" title="Used in ${esc(reps.map(repeatLabel).join("; "))}">Used in ${esc(repeatLabel(reps[0]))}${reps.length > 1 ? ` +${reps.length - 1}` : ""}</span>`
        : "";
      return `<li class="row ${on ? "is-picked" : ""}">
        <div class="ident">
          <img class="icon" src="${esc(icon)}" alt="" loading="lazy" />
          <div class="ident-text">
            <span class="name" title="${esc(a.trackName)}">${esc(a.trackName)}</span>
            <span class="sub">${esc(a.artistName)}</span>
            ${used}
          </div>
        </div>
        <div>
          <span class="rating-val"><span class="star" aria-hidden="true">★</span>${a.averageUserRating.toFixed(2)}</span>
          <span class="sub num">${fmtCount(a.userRatingCount)} ratings</span>
        </div>
        <div>
          <span class="name">${esc(a.primaryGenreName)}</span>
          <span class="sub">${esc(a.formattedPrice || "Free")}</span>
        </div>
        <div class="num">${fmtMonth(a.currentVersionReleaseDate)}</div>
        <div class="gem" title="Gem score: high rating, few ratings, recently updated">
          <span class="gem-val">${Math.round(a.gemScore)}</span>
          <span class="gem-bar"><i style="width:${Math.round(a.gemScore)}%"></i></span>
        </div>
        ${mine
          ? `<button class="pick is-on" disabled>Your app</button>`
          : `<button class="pick ${on ? "is-on" : ""}" data-pick="${a.trackId}" ${!on && full ? "disabled" : ""}>${on ? "Added" : "Add"}</button>`}
      </li>`;
    })
    .join("");
}

async function search() {
  const niche = $("#niche").value.trim();
  if (!niche || ui.searching) return;
  const p = post();
  if (p) p.niche = niche;
  state.resultsNiche = niche;
  state.resultsNote = "";
  ui.searching = true;
  ui.searchKind = "search";
  renderResults();
  try {
    state.results = await invoke("search_gems", { niche, filter: state.filter });
    if (!state.results.length) toast("No apps matched. Try a broader niche or loosen the filters.");
  } catch (e) {
    toast(`Search failed: ${e}`, true);
  } finally {
    ui.searching = false;
    renderResults();
    save();
  }
}

/** Apps the current account has already used, so suggestions bring new ones. */
function usedByAccount() {
  const a = acct();
  const names = new Set();
  if (a?.myApp) names.add(a.myApp.trackName);
  for (const p of a ? postsOf(a) : []) for (const app of p.picked) names.add(app.trackName);
  return [...names];
}

async function suggest() {
  const niche = $("#niche").value.trim();
  if (ui.searching) return;
  const p = post();
  if (p && niche) p.niche = niche;
  state.resultsNiche = niche;
  ui.searching = true;
  ui.searchKind = "suggest";
  const writer = WRITER_NAMES[state.writer];
  renderResults();
  try {
    const out = await invoke("suggest_apps", {
      niche,
      hook: p ? hookText(p.slideOptions) : "",
      count: 12,
      exclude: usedByAccount(),
      filter: state.filter,
      writer: state.writer,
    });
    state.results = out.apps;
    const total = out.suggested;
    const mix = `Showing ${out.gems} hidden gem${out.gems === 1 ? "" : "s"} (up to ${fmtCount(state.filter.maxRatings)} ratings) first, then ${out.popular} popular app${out.popular === 1 ? "" : "s"}.`;
    const missing = out.notFound.length ? ` Not on the App Store: ${out.notFound.join(", ")}.` : "";
    const unrated = out.unrated.length ? ` Left out with no ratings yet: ${out.unrated.join(", ")}.` : "";
    state.resultsNote = `${writer} suggested ${total} apps. ${mix}${missing}${unrated}`;
    if (!out.apps.length) toast(`None of ${writer}'s suggestions were found on the App Store. Try again or reword the niche.`, true);
  } catch (e) {
    toast(`Couldn't get suggestions: ${e}`, true);
  } finally {
    ui.searching = false;
    renderResults();
    save();
  }
}

/** Adds apps from pasted App Store links: into this post up to its limit, and all into the list below. */
async function addByLinks() {
  const p = post();
  const links = $("#links-input").value.trim();
  if (!p || !links || ui.addingLinks) return;
  ui.addingLinks = true;
  $("#add-links").disabled = true;
  $("#add-links").textContent = "Looking up";
  try {
    const out = await invoke("lookup_links", { links, filter: state.filter });
    const added = [];
    const skipped = [];
    for (const app of out.apps) {
      if (isMine(app.trackId) || isPicked(app.trackId)) continue;
      if (p.picked.length < gemCapacity()) {
        p.picked.push(app);
        added.push(app.trackName);
      } else skipped.push(app.trackName);
    }
    if (out.apps.length) {
      state.results = out.apps;
      state.resultsNote = `From your links: ${out.apps.length} app${out.apps.length === 1 ? "" : "s"}.`;
    }
    const parts = [];
    if (added.length) parts.push(`Added ${added.length} app${added.length === 1 ? "" : "s"} to this post`);
    if (skipped.length)
      parts.push(`${skipped.length} didn't fit (${MAX_APPS} apps max), so they're in the list to swap in`);
    if (out.notFound.length) parts.push(`not found on the App Store: ${out.notFound.join(", ")}`);
    if (out.invalid.length) parts.push(`not App Store links: ${out.invalid.slice(0, 3).join(", ")}${out.invalid.length > 3 ? "…" : ""}`);
    const bad = !out.apps.length;
    toast(parts.length ? parts.join(". ") + "." : "Those apps are already in this post.", bad);
    if (out.apps.length) $("#links-input").value = "";
    renderAll();
    save();
  } catch (e) {
    toast(`Couldn't look up those links: ${e}`, true);
  } finally {
    ui.addingLinks = false;
    $("#add-links").disabled = false;
    $("#add-links").textContent = "Add apps";
  }
}

function togglePick(id) {
  const p = post();
  if (!p) return;
  if (isPicked(id)) {
    p.picked = p.picked.filter((a) => a.trackId !== id);
  } else if (p.picked.length < gemCapacity() && !isMine(id)) {
    const app = state.results.find((a) => a.trackId === id);
    if (!app) return;
    p.picked.push(app);
    ui.justAdded = id;
  }
  renderAll();
  ui.justAdded = null;
  save();
}

/* ---------- Slot menu (click or right-click an app on the phone) ---------- */
let slotMenuFor = null;

function openSlotMenu(btn, x, y) {
  const id = Number(btn.dataset.slot);
  const app = lineup().find((a) => a.trackId === id);
  if (!app) return;
  const own = isMine(id);
  const items = own
    ? [
        ["skip", "Leave out of this post"],
        ["change", "Change your app"],
      ]
    : [["remove", "Remove from post", "is-danger"]];
  if (app.trackViewUrl) items.push(["store", "Open in App Store"]);
  const menu = $("#slot-menu");
  menu.innerHTML =
    `<p class="ctx-title">${esc(app.trackName)}</p>` +
    items.map(([act, label, cls = ""]) => `<button type="button" role="menuitem" class="${cls}" data-act="${act}">${label}</button>`).join("");
  slotMenuFor = { id, btn };
  menu.hidden = false;
  // Below the icon (or at the pointer for a right-click), kept inside the window.
  const r = btn.getBoundingClientRect();
  const left = x ?? r.left + r.width / 2 - menu.offsetWidth / 2;
  const top = y ?? r.bottom + 6;
  menu.style.left = `${Math.max(8, Math.min(left, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${top + menu.offsetHeight > innerHeight - 8 ? Math.max(8, (y ?? r.top - 6) - menu.offsetHeight) : top}px`;
  btn.setAttribute("aria-expanded", "true");
  menu.querySelector("button").focus();
}

function closeSlotMenu(refocus = true) {
  const menu = $("#slot-menu");
  if (menu.hidden) return;
  menu.hidden = true;
  const btn = slotMenuFor?.btn;
  slotMenuFor = null;
  if (btn?.isConnected) {
    btn.removeAttribute("aria-expanded");
    if (refocus) btn.focus();
  }
}

function slotMenuAction(act) {
  const id = slotMenuFor?.id;
  closeSlotMenu(act !== "change");
  const app = lineup().find((a) => a.trackId === id);
  if (!app) return;
  if (act === "remove") togglePick(id);
  else if (act === "skip") toggleSkipMine();
  else if (act === "change") {
    ui.mine.editing = true;
    renderMine();
    $("#mine-query").focus();
  } else if (act === "store") window.__TAURI__.opener.openUrl(app.trackViewUrl).catch((e) => toast(`Couldn't open the App Store: ${e}`, true));
}

function bindSlotMenu() {
  const grid = $("#home-grid");
  grid.addEventListener("click", (e) => {
    const b = e.target.closest("[data-slot]");
    if (!b) return;
    if (slotMenuFor?.btn === b) return closeSlotMenu();
    openSlotMenu(b);
  });
  grid.addEventListener("contextmenu", (e) => {
    const b = e.target.closest("[data-slot]");
    if (!b) return;
    e.preventDefault();
    openSlotMenu(b, e.clientX, e.clientY);
  });
  const menu = $("#slot-menu");
  menu.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (b) slotMenuAction(b.dataset.act);
  });
  menu.addEventListener("keydown", (e) => {
    const items = [...menu.querySelectorAll("button")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
    } else if (e.key === "Tab") closeSlotMenu(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) closeSlotMenu();
  });
  document.addEventListener("pointerdown", (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !e.target.closest("[data-slot]")) closeSlotMenu(false);
  });
  addEventListener("resize", () => closeSlotMenu(false));
  document.addEventListener("scroll", () => closeSlotMenu(false), true);
}

/* ---------- Tray ---------- */
function renderTray() {
  const p = post();
  const drawnMode = isDrawn(p);
  const spotMode = isSpot(p);
  $(".phone").hidden = drawnMode || spotMode;
  $("#dprev").hidden = !drawnMode;
  $("#sprev").hidden = !spotMode;
  $("#artist-row").hidden = !drawnMode;
  $("#writer-label").textContent = drawnMode ? "Writing by" : spotMode ? "Writing by" : "Overviews by";
  if (drawnMode) return renderDrawnTray(p);
  if (spotMode) return renderSpotTray(p);
  const apps = lineup();
  const mine = myApp();
  // On the phone, your app sits in its chosen slot even before the gems around it are added.
  const grid = Array(MAX_APPS).fill(null);
  if (mine) grid[mySlot() - 1] = mine;
  let g = 0;
  const gems = picked();
  for (let i = 0; i < MAX_APPS && g < gems.length; i++) if (!grid[i]) grid[i] = gems[g++];
  $("#home-grid").innerHTML = grid
    .map((a) => {
      if (!a) return `<li class="slot"><span class="slot-icon"></span><span class="slot-label">&nbsp;</span></li>`;
      const pr = preparedFor(a.trackId);
      const src = pr?.icon ? fileSrc(pr.icon) : a.artworkUrl512 || a.artworkUrl100;
      const own = isMine(a.trackId);
      return `<li class="slot is-filled ${ui.justAdded === a.trackId ? "is-new" : ""}">
        ${own ? `<span class="slot-badge" title="Your app">You</span>` : ""}
        <button data-slot="${a.trackId}" aria-haspopup="menu" title="${esc(a.trackName)}${own ? " (your app)" : ""}">
          <img class="slot-icon" src="${esc(src)}" alt="" />
          <span class="slot-label">${esc(a.trackName)}</span>
        </button>
      </li>`;
    })
    .join("");

  // Keep the preview in step with the chosen slide text and colours.
  const o = opts();
  const hook = $(".hook");
  hook.innerHTML = `<span style="color:${esc(o.accent)}">${esc(o.hookAccent)}</span> ${esc(o.hookLine2)} ${esc(o.hookLine3)}`;
  hook.style.color = o.text;
  $(".screen").style.setProperty("--label", o.text);
  $(".screen").style.background = `linear-gradient(180deg, ${mixHex(o.wallpaper, "#ffffff", 0.55)}, ${o.wallpaper} 45%, ${mixHex(o.wallpaper, "#000000", 0.35)})`;

  $("#mine").hidden = !p;
  const n = apps.length;
  const todo = apps.filter((a) => !preparedFor(a.trackId) && !ui.busy.has(a.trackId)).length;
  const working = apps.filter((a) => ui.busy.has(a.trackId)).length;
  $("#tray-status").textContent = !p
    ? "Open a post or make a new one to start."
    : n === 0
      ? "Add apps to fill the hook slide."
      : n < MAX_APPS
        ? `${n} of ${MAX_APPS} apps added`
        : "Hook slide is full";

  // Warn about apps this account showed recently; older repeats only get a note in the results.
  const recent = (p ? picked() : [])
    .map((a) => ({ a, q: appRepeats(a.trackId).find(isRecent) }))
    .filter((r) => r.q);
  const warn = $("#tray-repeats");
  warn.hidden = !recent.length;
  warn.textContent = recent.length
    ? `Already on ${handle(acct())} recently: ${recent.map(({ a, q }) => `${a.trackName} (${repeatLabel(q)})`).join(", ")}.`
    : "";
  document.querySelectorAll("#home-grid [data-slot]").forEach((b) => {
    b.parentElement.classList.toggle("is-repeat", recent.some((r) => String(r.a.trackId) === b.dataset.slot));
  });
  closeSlotMenu(false);

  const btn = $("#prepare-btn");
  btn.disabled = todo === 0;
  btn.textContent = working
    ? `Preparing ${working} app${working > 1 ? "s" : ""}`
    : todo
      ? `Prepare ${todo} app${todo > 1 ? "s" : ""}`
      : n
        ? "All apps prepared"
        : "Prepare apps";
}

/** The tray for a spotlight: its hook window over the desk, and the Prepare button for its apps. */
function renderSpotTray(p) {
  const s = spotOf(p);
  const desk = deskFor(p);
  const img = $("#sprev-desk");
  img.hidden = !desk;
  if (desk && img.dataset.path !== desk.path) {
    img.src = fileSrc(desk.path);
    img.dataset.path = desk.path;
  }
  $("#sprev-title").textContent = s?.windowTitle || "";
  $("#sprev-text").innerHTML = s?.hook?.trim()
    ? accentHtml(s.hook.trim(), s.accent, s.color)
    : `<span class="dprev-empty">Your hook shows here</span>`;
  $("#mine").hidden = !p;
  $("#tray-repeats").hidden = true;
  closeSlotMenu(false);

  const apps = lineup();
  const n = apps.length;
  const todo = apps.filter((a) => !preparedFor(a.trackId) && !ui.busy.has(a.trackId)).length;
  const working = apps.filter((a) => ui.busy.has(a.trackId)).length;
  $("#tray-status").textContent = n
    ? `${n} app${n > 1 ? "s" : ""}: ${apps.map((a) => shortAppName(a.trackName)).join(", ")}`
    : "Add apps to spotlight in Find apps.";
  const btn = $("#prepare-btn");
  btn.disabled = todo === 0;
  btn.textContent = working
    ? `Preparing ${working} app${working > 1 ? "s" : ""}`
    : todo
      ? `Prepare ${todo} app${todo > 1 ? "s" : ""}`
      : n
        ? "All apps prepared"
        : "Prepare apps";
}

/** The tray for a relatable-drawings post: a live preview of its hook slide and a Draw button. */
function renderDrawnTray(p) {
  const d = drawnOf(p);
  const hook = d?.slides?.[0];
  const st = d?.style || DEFAULT_DRAWN_STYLE;
  const prev = $("#dprev");
  prev.style.background = st.background;
  prev.style.color = st.text;
  $("#dprev-text").innerHTML = hook?.text ? accentHtml(hook.text, d.accent, st.accent) : `<span class="dprev-empty">Your hook shows here</span>`;
  const art = $("#dprev-art");
  art.hidden = !hook?.image;
  if (hook?.image) art.src = fileSrc(hook.image);
  $("#mine").hidden = !p;
  $("#tray-repeats").hidden = true;
  closeSlotMenu(false);

  const all = drawnSlides(p);
  const done = all.filter((s) => s.image).length;
  const todo = all.filter((s) => !s.image && s.scene.trim() && !ui.drawing.has(s.id)).length;
  const busy = all.filter((s) => ui.drawing.has(s.id)).length;
  $("#tray-status").textContent = !all.length ? "Write the slideshow to start." : `${done} of ${all.length} slides drawn`;
  const btn = $("#prepare-btn");
  btn.disabled = todo === 0;
  const n = (k) => `${k} slide${k > 1 ? "s" : ""}`;
  btn.textContent = busy ? `Drawing ${n(busy)}` : todo ? `Draw ${n(todo)} with ${WRITER_NAMES[state.artist]}` : all.length ? "All slides drawn" : "Draw slides";
}

/* ---------- Prepared ---------- */
function renderPrepared() {
  const apps = lineup();
  const cards = apps.map((a) => {
    const p = preparedFor(a.trackId);
    const busy = ui.busy.has(a.trackId);
    if (!p) {
      return `<article class="prep is-busy">
        <img class="icon" src="${esc(a.artworkUrl100 || "")}" alt="" />
        <div>
          <div class="prep-top"><span class="prep-name">${esc(a.trackName)}</span></div>
          ${busy
            ? `<div class="loading-row" style="padding:0"><span class="spinner"></span>Downloading screenshots and writing an overview with ${WRITER_NAMES[state.writer]}</div>`
            : `<p class="hint">Not prepared yet. Press Prepare in the preview.</p>`}
        </div>
      </article>`;
    }
    const own = isMine(a.trackId);
    const len = p.overview.length;
    return `<article class="prep" data-id="${a.trackId}">
      <img class="icon" src="${esc(fileSrc(p.icon))}" alt="" />
      <div>
        <div class="prep-top">
          <span class="prep-name">${esc(a.trackName)}</span>
          ${own ? `<span class="prep-mine">Your app</span>` : ""}
          <span class="prep-meta"><span class="star">★</span>${a.averageUserRating.toFixed(1)} from ${fmtCount(a.userRatingCount)} ratings</span>
          <span class="prep-actions">
            <button class="btn btn-quiet" data-rewrite="${a.trackId}" ${busy ? "disabled" : ""}>${busy ? "Rewriting" : "Rewrite overview"}</button>
            ${own ? "" : `<button class="btn btn-quiet" data-remove="${a.trackId}">Remove from post</button>`}
          </span>
        </div>
        <textarea class="overview" data-overview="${a.trackId}" ${busy ? "disabled" : ""}>${esc(p.overview)}</textarea>
        <div class="charcount ${len > OVERVIEW_LIMIT ? "is-over" : ""}" data-count="${a.trackId}">${len} / ${OVERVIEW_LIMIT}</div>
        <div class="shots">${p.screenshots.map((s) => `<img src="${esc(fileSrc(s))}" alt="" loading="lazy" />`).join("")}</div>
      </div>
    </article>`;
  });
  $("#prepared").innerHTML = cards.join("");
  $("#prepare-empty").hidden = apps.length > 0;
}

function prepareAll() {
  const todo = lineup().filter((a) => !preparedFor(a.trackId) && !ui.busy.has(a.trackId));
  if (!todo.length) return;
  setView("prepare");
  for (const app of todo) {
    ui.busy.add(app.trackId);
    invoke("prepare_app", { info: app, writer: state.writer })
      .then((p) => {
        state.prepared = state.prepared.filter((x) => x.app.trackId !== app.trackId).concat(p);
        save();
      })
      .catch((e) => toast(`Couldn't prepare ${app.trackName}: ${e}`, true))
      .finally(() => {
        ui.busy.delete(app.trackId);
        renderAll();
      });
  }
  renderAll();
}

function rewrite(id) {
  const p = preparedFor(id);
  if (!p || ui.busy.has(id)) return;
  ui.busy.add(id);
  renderPrepared();
  invoke("rewrite_overview", { info: p.app, writer: state.writer })
    .then((text) => {
      p.overview = text;
      save();
      toast(`${WRITER_NAMES[state.writer]} rewrote the overview for ${p.app.trackName}`);
    })
    .catch((e) => toast(`Couldn't rewrite the overview: ${e}`, true))
    .finally(() => {
      ui.busy.delete(id);
      renderPrepared();
    });
}

/* ---------- Write (relatable drawings) ---------- */
/** The plug slide, if this post ends with one (it needs the account's app, not left out). */
const activePlug = (p = post()) => (ownAppOf(p) && drawnOf(p)?.plug) || null;
/** Every slide in order, the plug last. */
function drawnSlides(p = post()) {
  const d = drawnOf(p);
  if (!d) return [];
  const plug = activePlug(p);
  return plug ? [...d.slides, plug] : [...d.slides];
}
function findDrawnSlide(id, p = post()) {
  const d = drawnOf(p);
  return d?.slides.find((s) => s.id === id) || (d?.plug?.id === id ? d.plug : null);
}
const newDrawnSlide = (s = {}) => ({ id: uid(), text: s.text || "", scene: s.scene || "", image: s.image || null, ...(s.turn ? { turn: true } : {}) });

/** The text with its accent words in the highlight colour, as on the slide. */
function accentHtml(text, accent, color) {
  const i = accent ? text.toLowerCase().indexOf(accent.toLowerCase()) : -1;
  if (i < 0) return esc(text);
  return `${esc(text.slice(0, i))}<span style="color:${esc(color)}">${esc(text.slice(i, i + accent.length))}</span>${esc(text.slice(i + accent.length))}`;
}

function renderWrite() {
  const p = post();
  const d = drawnOf(p);
  if (!d || ui.view !== "write") return;
  const writer = WRITER_NAMES[state.writer];
  const artist = WRITER_NAMES[state.artist];
  const app = ownAppOf(p);
  const has = d.slides.length > 0;

  $("#drawn-points").innerHTML = [3, 4, 5, 6, 7, 8, 9].map((n) => `<option value="${n}" ${d.points === n ? "selected" : ""}>${n}</option>`).join("");
  const btn = $("#write-btn");
  btn.disabled = ui.writing;
  btn.textContent = ui.writing ? `${writer} is writing` : has ? `Write again with ${writer}` : `Write with ${writer}`;
  $("#write-hint").textContent = has
    ? "Writing again replaces these slides and their drawings."
    : `${writer} writes the hook, ${d.points} slides${app ? ` and a last slide about ${app.trackName}` : ""}. Then ${artist} draws each one.`;

  const reps = hookRepeats(postHook(p));
  const rep = $("#drawn-repeat");
  rep.hidden = !reps.length;
  rep.classList.toggle("is-old", !!reps.length && !isRecent(reps[0]));
  rep.textContent = reps.length ? `${handle(acct())} already used this hook in ${reps.map(repeatLabel).join("; ")}.` : "";

  const all = drawnSlides(p);
  const todo = all.filter((s) => !s.image && s.scene.trim() && !ui.drawing.has(s.id)).length;
  $("#drawn-bar").hidden = !has;
  $("#write-empty").hidden = has || ui.writing;
  const drawAllBtn = $("#draw-all");
  drawAllBtn.disabled = !todo;
  drawAllBtn.textContent = todo ? `Draw ${todo} with ${artist}` : all.some((s) => ui.drawing.has(s.id)) ? "Drawing" : "All drawn";
  $("#drawn-count").textContent = has ? `${all.filter((s) => s.image).length} of ${all.length} drawn. Each drawing takes about a minute.` : "";

  const item = (s, label, o = {}) => {
    const busy = ui.drawing.has(s.id);
    const active = ui.drawActive?.has(s.id);
    const art = busy
      ? `<span class="loading-row"><span class="spinner"></span>${active ? "Drawing" : "Waiting"}</span>`
      : s.image
        ? `<img src="${esc(fileSrc(s.image))}" alt="" />`
        : `<span class="dslide-noart">No drawing yet</span>`;
    const moves = o.point
      ? `<button type="button" class="btn btn-quiet btn-icon" data-move-up="${s.id}" ${o.idx <= 1 ? "disabled" : ""} aria-label="Move up" title="Move up">↑</button>
         <button type="button" class="btn btn-quiet btn-icon" data-move-down="${s.id}" ${o.last ? "disabled" : ""} aria-label="Move down" title="Move down">↓</button>
         <button type="button" class="btn btn-quiet" data-remove-slide="${s.id}">Remove</button>`
      : o.plug
        ? `<button type="button" class="btn btn-quiet" data-remove-plug>Remove</button>`
        : "";
    // The hook has its own repeat note above the list.
    const rep = o.hook ? null : lineRepeat(s.text, p);
    return `<li class="dslide" data-id="${s.id}">
      <div class="dslide-art" style="background:${esc(d.style.background)}">${art}</div>
      <div class="dslide-body">
        <div class="dslide-top">
          <span class="dslide-label">${esc(label)}${rep ? ` <span class="repeat is-recent" title="Reword it so the account doesn't repeat itself">also in ${esc(rep.name)}</span>` : ""}</span>
          <span class="dslide-actions">
            <button type="button" class="btn btn-quiet" data-draw="${s.id}" ${busy || !s.scene.trim() ? "disabled" : ""}>${busy ? (active ? "Drawing" : "Waiting") : s.image ? "Redraw" : "Draw"}</button>
            ${moves}
          </span>
        </div>
        <textarea class="overview dslide-text" data-dtext="${s.id}" rows="2" aria-label="${esc(label)} text">${esc(s.text)}</textarea>
        ${o.hook ? `<label class="field dslide-field">Highlighted words <input type="text" data-daccent value="${esc(d.accent)}" placeholder="loneliness" /></label>` : ""}
        <label class="field dslide-field">Drawing shows <input type="text" data-dscene="${s.id}" value="${esc(s.scene)}" placeholder="a stick figure alone on a bench, looking at their phone" /></label>
      </div>
    </li>`;
  };

  let html = "";
  if (ui.writing && !has) html = `<li class="loading-row"><span class="spinner"></span>${esc(writer)} is writing a slideshow about ${esc(d.topic)}</li>`;
  html += d.slides
    .map((s, i) => item(s, i === 0 ? "Hook" : s.turn ? `Slide ${i + 1}, leads into your app` : `Slide ${i + 1}`, { hook: i === 0, point: i > 0, idx: i, last: i === d.slides.length - 1 }))
    .join("");
  if (has) {
    const mineApp = acct()?.myApp;
    if (app && d.plug) html += item(d.plug, `Last slide: ${app.trackName}`, { plug: true });
    else if (app) html += `<li class="dslide-note"><button type="button" class="btn btn-quiet" data-add-plug>Add a last slide about ${esc(app.trackName)}</button></li>`;
    else if (mineApp) html += `<li class="dslide-note">${esc(mineApp.trackName)} is left out of this post, so it ends on the slide above.</li>`;
    else html += `<li class="dslide-note">Pick your app in the panel to end each post with a slide about it.</li>`;
  }

  // Keep the caret where it was if a drawing finishes while you're typing.
  const list = $("#drawn-list");
  const focus = document.activeElement;
  const key = list.contains(focus) ? [...focus.attributes].find((a) => a.name.startsWith("data-d"))?.name : null;
  const sel = key ? [focus.getAttribute(key), focus.selectionStart, focus.selectionEnd] : null;
  list.innerHTML = html;
  if (key) {
    const el = list.querySelector(sel[0] ? `[${key}="${CSS.escape(sel[0])}"]` : `[${key}]`);
    if (el) {
      el.focus();
      el.setSelectionRange?.(sel[1], sel[2]);
    }
  }
}

async function writeDrawn() {
  const p = post();
  const d = drawnOf(p);
  if (!d || ui.writing) return;
  const topic = $("#drawn-topic").value.trim();
  if (!topic) return toast("Enter a topic first, like adult friendships or burnout.", true);
  d.topic = topic;
  ui.writing = true;
  renderWrite();
  try {
    const used = usedHooks(p);
    if (d.slides[0]?.text) used.push(d.slides[0].text);
    const r = await invoke("write_drawn", { topic, points: d.points, ownApp: ownAppOf(p), used, usedLines: usedLines(p), writer: state.writer });
    // Drawings still on their way belong to the old slides.
    ui.drawQueue = ui.drawQueue.filter((j) => j.postId !== p.id);
    // The last r.turn slides lead from the problem into the plug.
    const firstTurn = r.slides.length - (r.turn || 0);
    d.slides = r.slides.map((s, i) => newDrawnSlide({ ...s, turn: i >= firstTurn }));
    d.accent = r.accent || "";
    d.plug = r.plug ? newDrawnSlide(r.plug) : null;
    save();
    toast(`${WRITER_NAMES[state.writer]} wrote ${d.slides.length} slides${d.plug ? " and a last slide" : ""}`);
  } catch (e) {
    toast(`Couldn't write the slideshow: ${e}`, true);
  } finally {
    ui.writing = false;
    renderAll();
  }
}

/** An earlier drawing from the post, so Codex keeps one line style across the slideshow. */
function styleRefFor(p, id) {
  const all = drawnSlides(p);
  return (all.find((s) => s.id !== id && s.image) || {}).image || null;
}

function queueDraw(ids) {
  const p = post();
  if (!p) return;
  for (const id of ids) {
    if (ui.drawing.has(id)) continue;
    ui.drawing.add(id);
    ui.drawQueue.push({ postId: p.id, id });
  }
  pumpDraws();
  renderAll();
}

function pumpDraws() {
  ui.drawActive ||= new Set();
  while (ui.drawActive.size < DRAW_PARALLEL && ui.drawQueue.length) {
    const job = ui.drawQueue[0];
    const p = state.posts.find((x) => x.id === job.postId);
    const s = p && findDrawnSlide(job.id, p);
    if (!s || !s.scene.trim()) {
      ui.drawQueue.shift();
      ui.drawing.delete(job.id);
      continue;
    }
    // Codex matches the first drawing's style, so with none yet, draw one before the rest.
    const running = drawnSlides(p).some((x) => ui.drawActive.has(x.id));
    if (state.artist === "codex" && running && !drawnSlides(p).some((x) => x.image)) break;
    ui.drawQueue.shift();
    ui.drawActive.add(job.id);
    const scene = s.scene;
    invoke("draw_scene", { scene, artist: state.artist, styleRef: state.artist === "codex" ? styleRefFor(p, s.id) : null })
      .then((path) => {
        const cur = findDrawnSlide(job.id, p);
        if (cur) {
          cur.image = path;
          save();
        }
      })
      .catch((e) => toast(`Couldn't draw "${s.text.slice(0, 40) || scene.slice(0, 40)}": ${e}`, true))
      .finally(() => {
        ui.drawActive.delete(job.id);
        ui.drawing.delete(job.id);
        pumpDraws();
        renderAll();
      });
  }
}

function drawAll() {
  queueDraw(drawnSlides().filter((s) => !s.image && s.scene.trim()).map((s) => s.id));
}

function bindWrite() {
  $("#write-form").addEventListener("submit", (e) => {
    e.preventDefault();
    writeDrawn();
  });
  $("#drawn-topic").addEventListener("input", (e) => {
    const d = drawnOf();
    if (!d) return;
    d.topic = e.target.value;
    save();
  });
  $("#drawn-points").addEventListener("change", (e) => {
    const d = drawnOf();
    if (!d) return;
    d.points = Number(e.target.value) || DEFAULT_POINTS;
    renderWrite();
    save();
  });
  $("#draw-all").addEventListener("click", drawAll);
  $("#add-slide").addEventListener("click", () => {
    const d = drawnOf();
    if (!d) return;
    const s = newDrawnSlide();
    d.slides.push(s);
    renderAll();
    save();
    $(`[data-dtext="${s.id}"]`)?.focus();
  });

  const list = $("#drawn-list");
  list.addEventListener("click", (e) => {
    const d = drawnOf();
    if (!d) return;
    const t = (sel) => e.target.closest(sel);
    let b;
    if ((b = t("[data-draw]"))) return queueDraw([b.dataset.draw]);
    if ((b = t("[data-move-up]")) || (b = t("[data-move-down]"))) {
      const id = b.dataset.moveUp || b.dataset.moveDown;
      const i = d.slides.findIndex((s) => s.id === id);
      const j = b.dataset.moveUp ? i - 1 : i + 1;
      // The hook stays first.
      if (i < 1 || j < 1 || j >= d.slides.length) return;
      [d.slides[i], d.slides[j]] = [d.slides[j], d.slides[i]];
    } else if ((b = t("[data-remove-slide]"))) {
      d.slides = d.slides.filter((s, i) => i === 0 || s.id !== b.dataset.removeSlide);
    } else if (t("[data-remove-plug]")) {
      d.plug = null;
    } else if (t("[data-add-plug]")) {
      d.plug = newDrawnSlide({ scene: "a stick figure smiling at their phone, looking calmer and less alone" });
    } else return;
    renderAll();
    save();
  });
  list.addEventListener("input", (e) => {
    const p = post();
    const d = drawnOf(p);
    if (!d) return;
    const el = e.target;
    if (el.dataset.dtext) {
      const s = findDrawnSlide(el.dataset.dtext, p);
      if (s) s.text = el.value;
      if (s === d.slides[0]) renderTray();
    } else if (el.dataset.dscene) {
      const s = findDrawnSlide(el.dataset.dscene, p);
      if (!s) return;
      s.scene = el.value;
      const btn = list.querySelector(`[data-draw="${CSS.escape(s.id)}"]`);
      if (btn && !ui.drawing.has(s.id)) btn.disabled = !s.scene.trim();
    } else if (el.hasAttribute("data-daccent")) {
      d.accent = el.value;
      renderTray();
    } else return;
    save();
  });
  // Re-check the hook against earlier posts once you've finished typing it.
  list.addEventListener("change", (e) => {
    if (e.target.dataset.dtext && e.target.dataset.dtext === drawnOf()?.slides[0]?.id) renderWrite();
  });
}

/* ---------- Slides ---------- */
const HEX = /^#[0-9a-f]{6}$/i;

function renderSlideSettings() {
  const o = opts();
  document.querySelectorAll("[data-o]").forEach((el) => {
    if (document.activeElement !== el) el.value = o[el.dataset.o];
  });
  for (const key of Object.keys(DEFAULT_COLORS)) {
    $(`[data-color="${key}"]`).value = o[key];
    const hex = $(`[data-hex="${key}"]`);
    if (document.activeElement !== hex) hex.value = o[key];
  }
  const st = drawnOf()?.style || DEFAULT_DRAWN_STYLE;
  for (const key of Object.keys(DEFAULT_DRAWN_STYLE)) {
    $(`[data-dcolor="${key}"]`).value = st[key];
    const hex = $(`[data-dhex="${key}"]`);
    if (document.activeElement !== hex) hex.value = st[key];
  }
}

function renderSlides() {
  const p = post();
  const drawnMode = isDrawn(p);
  const spotMode = isSpot(p);
  $("#slide-settings").hidden = drawnMode || spotMode;
  $("#drawn-settings").hidden = !drawnMode;
  $("#spot-settings").hidden = !spotMode;
  if (spotMode) return renderSpotSlides(p);
  const apps = slideApps();
  const written = drawnSlides(p).filter((s) => s.text.trim());
  const bare = written.filter((s) => !s.image).length;
  $("#slides-lede").textContent = drawnMode
    ? written.length
      ? `${written.length} slides from Write${bare ? `. ${bare} without a drawing will be text only` : ""}. Slides are 2160 × 2700 JPEGs.`
      : "Write the slideshow first. Slides use the text and drawings from Write."
    : apps.length
      ? `Uses this post's ${apps.length} prepared app${apps.length > 1 ? "s" : ""}, in the order shown on the phone. Slides are 2160 × 2700 JPEGs.`
      : "Prepare this post's apps first. Slides use the apps on the phone, in that order.";
  $("#slides-empty p:last-child").textContent = drawnMode
    ? "Pick your colours, then press Make slides. You'll get 2160 × 2700 JPEGs: the hook, one slide per line, and the slide about your app."
    : "Pick your text and colours, then press Make slides. You'll get 2160 × 2700 JPEGs: the hook, one slide per app, and the last slide.";
  const btn = $("#make-slides");
  btn.disabled = ui.rendering || !(drawnMode ? written.length : apps.length);
  btn.textContent = ui.rendering ? "Making slides" : p?.slides ? "Make slides again" : "Make slides";

  const plugLast = drawnMode && !!activePlug(p);
  renderThumbs(p, (i, end) => (i === 0 ? "Hook" : drawnMode ? (end && plugLast ? "Your app" : `Slide ${i + 1}`) : end ? "Last slide" : `App ${i}`));
  renderHookIdeas();
  renderPost();
}

/** The made slides, each with a label from `label(index, isLast)`. */
function renderThumbs(p, label) {
  const last = p?.slides;
  $("#show-folder").hidden = !last;
  $("#slides-empty").hidden = !!last;
  $("#thumbs").innerHTML = last
    ? last.slides
        .map((s, i) => {
          const name = label(i, i === last.slides.length - 1);
          return `<li><figure><img src="${esc(fileSrc(s))}?v=${last.renderedAt}" alt="${esc(name)}" /><figcaption>${i + 1}. ${esc(name)}</figcaption></figure></li>`;
        })
        .join("")
    : "";
}

/* ---------- App spotlight ---------- */
/** The spotlight's apps, prepared, in slide order; null until every one is prepared. */
const spotApps = (p = post()) => {
  const apps = lineupFor(p).map((a) => preparedFor(a.trackId));
  return apps.length && apps.every(Boolean) ? apps : null;
};
/**
 * Keeps one slide per app in the post, in slide order. A slide stays with its app (by trackId)
 * when apps are reordered; slides from before that (no trackId) go to apps in order.
 */
function syncSpotLines(p) {
  const s = spotOf(p);
  if (!s) return [];
  const apps = lineupFor(p);
  const loose = s.lines.filter((l) => !l.trackId);
  const next = apps.map((a) => s.lines.find((l) => l.trackId === a.trackId) || { ...(loose.shift() || newSpotLine()), trackId: a.trackId });
  const changed = next.length !== s.lines.length || next.some((l, i) => l !== s.lines[i]);
  if (changed) {
    s.lines = next;
    save();
  }
  return s.lines;
}
/** The desk photo this post uses, if it's still in the desks folder. */
const deskFor = (p = post()) => ui.desks.find((d) => d.path === spotOf(p)?.desk) || null;
const deskReady = (d) => d?.screen?.source === "green" || d?.screen?.source === "marked";
/** One app's slide. `image` is your own screenshot, shown before App Store screenshot `shot` and the rest. */
const newSpotLine = (l = {}) => ({
  id: l.id || uid(),
  trackId: l.trackId ?? null,
  text: l.text || "",
  shot: Number.isInteger(l.shot) && l.shot >= 0 ? l.shot : 0,
  image: l.image || null,
});

const spotLines = (q) => (spotOf(q)?.lines || []).map((l) => l.text.trim()).filter(Boolean);
/** This account's other spotlight posts, newest first, drafts included. */
const otherSpotPosts = (p) => {
  const a = accountOf(p);
  return (a ? postsOf(a) : []).filter((q) => q.id !== p.id && isSpot(q)).sort((x, y) => postTime(y) - postTime(x));
};
/** The other spotlight post that already has this line or a close rewording of it. */
function spotLineRepeat(text, p = post()) {
  const key = hookKey(text);
  if (!p || words(text).size < 3) return null;
  return otherSpotPosts(p).find((q) => spotLines(q).some((l) => hookKey(l) === key || overlap(l, text) >= 0.8)) || null;
}

async function loadDesks() {
  try {
    ui.desks = await invoke("list_desks");
  } catch (e) {
    toast(`Couldn't read the desk photos: ${e}`, true);
  }
  ui.desksLoaded = true;
  if (ui.marking && !ui.desks.some((d) => d.path === ui.marking.path)) ui.marking = null;
  if (isSpot()) {
    renderSpotSlides(post());
    renderTray();
  }
}

function renderSpotSlides(p) {
  const s = spotOf(p);
  if (!s) return;
  const lines = syncSpotLines(p);
  const lu = lineupFor(p);
  const apps = spotApps(p);
  const writer = WRITER_NAMES[state.writer];
  // Only a text box counts: a focused button (like Upload) mustn't stop the list updating.
  const typing = (sel) => document.activeElement?.matches?.("textarea, input[type=text]") && document.activeElement.closest(sel);

  const wbtn = $("#spot-write");
  const written = s.hook.trim() || lines.some((l) => l.text.trim());
  wbtn.disabled = ui.spotWriting || !apps;
  wbtn.textContent = ui.spotWriting ? `${writer} is writing` : written ? `Write again with ${writer}` : `Write with ${writer}`;
  $("#spot-write-note").textContent = !lu.length
    ? "Add apps to this post in Find apps first."
    : !apps
      ? "Prepare this post's apps first, so the writer can read their descriptions."
      : written
        ? "Writing again replaces the words below."
        : `${writer} writes the hook, a line for each of the ${apps.length} app${apps.length > 1 ? "s" : ""} and the last slide from their descriptions.`;
  document.querySelectorAll("[data-spot]").forEach((el) => {
    if (document.activeElement !== el) el.value = s[el.dataset.spot] ?? "";
  });

  const reps = hookRepeats(s.hook);
  const rep = $("#spot-repeat");
  rep.hidden = !reps.length;
  rep.classList.toggle("is-old", !!reps.length && !isRecent(reps[0]));
  rep.textContent = reps.length ? `${handle(acct())} already used this hook in ${reps.map(repeatLabel).join("; ")}.` : "";

  // Don't rebuild the list under someone typing in it.
  if (!typing("#spot-lines")) {
    $("#spot-lines").innerHTML = lines
      .map((l, i) => {
        const info = lu[i];
        const shots = preparedFor(info?.trackId)?.screenshots || [];
        const src = l.image || shots[l.shot] || shots[0];
        const again = spotLineRepeat(l.text, p);
        const uploading = ui.uploading?.has(l.id);
        const which = l.image
          ? `<span class="own-tag">Your screenshot</span>`
          : shots.length
            ? `<label>App Store screenshot <select data-spot-shot="${l.id}">${shots.map((_, k) => `<option value="${k}" ${k === l.shot ? "selected" : ""}>${k + 1}</option>`).join("")}</select></label>`
            : preparedFor(info?.trackId)
              ? `<span>No App Store screenshots</span>`
              : `<span>Prepare this app to see its screenshots</span>`;
        return `<li class="spot-line" data-drop-line="${l.id}">
          ${src ? `<img class="spot-shot" src="${esc(fileSrc(src))}" alt="${l.image ? "Your screenshot" : `Screenshot ${l.shot + 1}`}" />` : `<span class="spot-shot"></span>`}
          <div>
            <div class="spot-line-head">
              <b>Slide ${i + 2}: ${esc(shortAppName(info?.trackName || ""))}</b>
              ${which}
              ${again ? `<span class="repeat is-recent">also in ${esc(again.name)}</span>` : ""}
            </div>
            <textarea class="overview" rows="2" data-spot-line="${l.id}" aria-label="Slide ${i + 2} text">${esc(l.text)}</textarea>
            <div class="spot-line-foot">
              <button type="button" class="btn btn-quiet btn-xs" data-spot-upload="${l.id}" ${uploading ? "disabled" : ""}>${uploading ? "Uploading" : l.image ? "Replace screenshot" : "Upload screenshot"}</button>
              ${l.image && shots.length ? `<button type="button" class="link" data-spot-store="${l.id}">Use App Store screenshot</button>` : ""}
              <span class="spot-drop-hint">or drop an image here</span>
            </div>
          </div>
        </li>`;
      })
      .join("");
  }

  // Desk photos.
  $("#desk-list").innerHTML = ui.desks
    .map((d) => {
      const on = d.path === s.desk;
      const name = d.path.split(/[\\/]/).pop();
      return `<li><button type="button" class="desk ${on ? "is-on" : ""}" data-desk="${esc(d.path)}" aria-pressed="${on}" title="${esc(name)}">
        <img src="${esc(fileSrc(d.path))}" alt="" loading="lazy" />${deskReady(d) ? "" : `<span class="desk-flag">Mark the screen</span>`}
      </button></li>`;
    })
    .join("");
  $("#desk-empty").textContent = ui.desks.length
    ? `Drag in more photos, or pick one. ${s.desk ? "" : "With none picked, Make slides chooses one at random."}`
    : "Drag desk photos here: a phone on a stand, facing the camera. Free stock sites like Pexels and Unsplash have plenty.";
  const desk = deskFor(p);
  const markBtn = $("#desk-mark-open");
  markBtn.disabled = !desk || !!ui.marking;
  markBtn.textContent = desk?.screen.source === "marked" ? "Mark the screen again" : "Mark the screen";
  $("#desk-make").disabled = ui.makingDesk;
  $("#desk-make").textContent = ui.makingDesk ? "Codex is making a desk" : "Make one with Codex";
  renderMarking();

  $(`[data-scolor]`).value = s.color;
  const hex = $(`[data-shex]`);
  if (document.activeElement !== hex) hex.value = s.color;

  const filled = lines.filter((l) => l.text.trim()).length;
  $("#slides-lede").textContent = apps
    ? `The hook in a Mac window, then one slide per app (${apps.length}) with its App Store page on a phone on your desk photo, then the last slide. Slides are 2160 × 2700 JPEGs.`
    : lu.length
      ? "Prepare this post's apps first, in the panel on the right."
      : "Add apps to spotlight in Find apps first.";
  $("#slides-empty p:last-child").textContent = "Write the words and pick a desk photo, then press Make slides.";
  const btn = $("#make-slides");
  btn.disabled = ui.rendering || !apps || !s.hook.trim() || filled < lines.length;
  btn.textContent = ui.rendering ? "Making slides" : p.slides ? "Make slides again" : "Make slides";
  renderThumbs(p, (i, end) => (i === 0 ? "Hook" : end && s.cta.trim() ? "Last slide" : shortAppName(lu[i - 1]?.trackName || `App ${i}`)));
  renderPost();
}

/* Marking a desk photo's screen: four clicks on the photo, in photo pixels. */
function startMarking() {
  const d = deskFor();
  if (!d) return;
  ui.marking = { path: d.path, width: d.width, height: d.height, points: [] };
  renderSpotSlides(post());
  $("#desk-mark").scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/** Points sorted around their centre, so the outline doesn't cross itself. */
const aroundCentre = (pts) => {
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  return [...pts].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
};

function renderMarking() {
  const m = ui.marking;
  $("#desk-mark").hidden = !m;
  if (!m) return;
  const img = $("#desk-mark-img");
  if (img.dataset.path !== m.path) {
    img.src = fileSrc(m.path);
    img.dataset.path = m.path;
  }
  const svg = $("#desk-mark-svg");
  svg.setAttribute("viewBox", `0 0 ${m.width} ${m.height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  const r = Math.max(m.width, m.height) / 110;
  const pts = m.points;
  const shape = pts.length > 2 ? aroundCentre(pts) : pts;
  const outline = pts.length > 1
    ? `<polygon points="${shape.map((p) => p.join(",")).join(" ")}" fill="rgba(43,196,151,.22)" stroke="#2bc497" stroke-width="${r / 2.5}" />`
    : "";
  svg.innerHTML = outline + pts.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#2bc497" stroke="#fff" stroke-width="${r / 3}" />`).join("");
  $("#desk-mark-note").textContent =
    pts.length < 4
      ? `Click the ${["first", "second", "third", "fourth"][pts.length]} corner of the phone's screen, right at the edge of the glass. Any order works.`
      : "If the outline sits on the screen's edges, save it. Start over to redo it.";
  $("#desk-mark-save").disabled = pts.length < 4;
  $("#desk-mark-auto").hidden = ui.desks.find((d) => d.path === m.path)?.screen.source !== "marked";
}

async function saveMarking(corners) {
  const m = ui.marking;
  if (!m) return;
  try {
    const screen = await invoke("set_desk_screen", { desk: m.path, corners });
    const d = ui.desks.find((x) => x.path === m.path);
    if (d) d.screen = screen;
    ui.marking = null;
    toast(screen.source === "none" ? "No green screen found in this photo, so mark its corners." : "Saved. This photo is ready to use.", screen.source === "none");
    if (screen.source === "none") startMarking();
  } catch (e) {
    toast(`Couldn't save the corners: ${e}`, true);
  }
  renderSpotSlides(post());
  renderTray();
}

/** Picks a desk for the post, asking for its screen corners if they aren't known yet. */
function pickDesk(path) {
  const s = spotOf();
  if (!s) return;
  s.desk = path;
  ui.marking = null;
  save();
  renderSpotSlides(post());
  renderTray();
  if (!deskReady(deskFor())) startMarking();
}

async function addDeskPhotos(paths) {
  if (!isSpot() || ui.view !== "slides") return toast("Open an app spotlight post's Slides to add desk photos.", true);
  try {
    const added = await invoke("add_desks", { paths });
    await loadDesks();
    toast(`Added ${added.length} desk photo${added.length === 1 ? "" : "s"}`);
    if (added[0]) pickDesk(added[0]);
  } catch (e) {
    toast(`Couldn't add those photos: ${e}`, true);
  }
}

/**
 * Puts your own screenshot on one app's slide, first in its App Store page. `saveOne` turns the
 * source (a dropped path or a picked File) into its copy in the app's data folder.
 */
async function useOwnScreenshots(lineId, sources, saveOne) {
  const p = post();
  const s = spotOf(p);
  const i = s?.lines.findIndex((l) => l.id === lineId) ?? -1;
  if (i < 0 || !sources.length) return;
  ui.uploading.add(lineId);
  renderSpotSlides(p);
  try {
    const path = await saveOne(sources[0]);
    const l = s.lines.find((x) => x.id === lineId);
    if (l) l.image = path;
    toast(`Using your screenshot on slide ${i + 2}`);
  } catch (e) {
    toast(`Couldn't use that screenshot: ${e}`, true);
  } finally {
    ui.uploading.delete(lineId);
    save();
    if (post() === p) renderSpotSlides(p);
  }
  if (sources.length > 1) toast("Each slide takes one screenshot of yours, so only the first was used.", true);
}
const uploadScreenshot = async (file) => {
  if (!/^image\/(png|jpeg)$/.test(file.type)) throw `${file.name} isn't a PNG or JPEG`;
  return invoke("save_screenshot", new Uint8Array(await file.arrayBuffer()));
};
const copyScreenshot = async (path) => (await invoke("add_screenshots", { paths: [path] }))[0];

async function makeDesk() {
  if (ui.makingDesk) return;
  ui.makingDesk = true;
  renderSpotSlides(post());
  try {
    const path = await invoke("make_desk");
    await loadDesks();
    if (isSpot()) pickDesk(path);
    toast("Codex made a new desk photo");
  } catch (e) {
    toast(`Couldn't make a desk photo: ${e}`, true);
  } finally {
    ui.makingDesk = false;
    if (isSpot()) renderSpotSlides(post());
  }
}

async function writeSpotlight() {
  const p = post();
  const s = spotOf(p);
  const apps = spotApps(p);
  if (!s || !apps || ui.spotWriting) return;
  ui.spotWriting = true;
  renderSpotSlides(p);
  try {
    const r = await invoke("write_spotlight", {
      apps,
      usedHooks: usedHooks(p),
      // Other spotlights' lines, newest first, then this post's (when writing again).
      usedLines: [...new Set([...otherSpotPosts(p).flatMap(spotLines), ...spotLines(p)])],
      writer: state.writer,
    });
    // New words, but each app's slide keeps the screenshot you chose or uploaded for it.
    const lines = syncSpotLines(p);
    Object.assign(s, {
      hook: r.hook,
      accent: r.accent,
      cta: r.cta,
      lines: lines.map((l, i) => ({ ...l, text: r.lines[i] ?? l.text })),
    });
    if (r.lines.length < lines.length) toast(`${WRITER_NAMES[state.writer]} wrote ${r.lines.length} of ${lines.length} app lines. Fill in the rest, or write again.`, true);
    save();
  } catch (e) {
    toast(`Couldn't write the slideshow: ${e}`, true);
  } finally {
    ui.spotWriting = false;
    if (post() === p) renderSpotSlides(p);
    renderTray();
  }
}

async function makeSpotSlides(p) {
  const s = spotOf(p);
  const apps = spotApps(p);
  if (!apps) return toast("Prepare this post's apps first.", true);
  const lines = syncSpotLines(p);
  if (!s.hook.trim()) return toast("Write the hook first.", true);
  const gap = lines.findIndex((l) => !l.text.trim());
  if (gap >= 0) return toast(`Write the line for slide ${gap + 2} (${shortAppName(apps[gap].app.trackName)}) first.`, true);
  if (!ui.desksLoaded) await loadDesks();
  let desk = deskFor(p);
  if (!desk) {
    const usable = ui.desks.filter(deskReady);
    if (!usable.length)
      return toast(ui.desks.length ? "Mark the phone screen on one of your desk photos first." : "Add a desk photo first: drag one into Desk photo.", true);
    // A different desk from the account's last spotlight, when there's a choice.
    const last = otherSpotPosts(p).find((q) => spotOf(q)?.desk)?.spotlight.desk;
    const pool = usable.length > 1 ? usable.filter((d) => d.path !== last) : usable;
    desk = pool[Math.floor(Math.random() * pool.length)];
    s.desk = desk.path;
  }
  if (!deskReady(desk)) {
    startMarking();
    return toast("Mark the phone screen on this desk photo first.", true);
  }
  ui.rendering = true;
  renderSlides();
  try {
    const spot = {
      hook: s.hook,
      accent: s.accent,
      lines: lines.map(({ text, shot, image }) => ({ text, shot, image })),
      cta: s.cta,
      windowTitle: s.windowTitle,
      color: s.color,
    };
    const out = await invoke("render_spotlight", { prepared: apps, spot, desk: desk.path });
    p.slides = { ...out, renderedAt: Date.now() };
    save();
    toast(`Made ${out.slides.length} slides`);
  } catch (e) {
    toast(`Couldn't make slides: ${e}`, true);
  } finally {
    ui.rendering = false;
    renderAll();
  }
}

function bindSpot() {
  const form = $("#spot-settings");
  form.addEventListener("submit", (e) => e.preventDefault());
  const edit = (fn, { rerender = false } = {}) => {
    const s = spotOf();
    if (!s) return;
    fn(s);
    save();
    renderTray();
    renderPost();
    if (rerender) renderSpotSlides(post());
  };
  form.addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset.spot) return edit((s) => (s[t.dataset.spot] = t.value));
    if (t.dataset.spotLine) return edit((s) => {
      const l = s.lines.find((x) => x.id === t.dataset.spotLine);
      if (l) l.text = t.value;
    });
  });
  // Re-check repeats once you've finished typing.
  form.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.spotShot) {
      return edit((s) => {
        const l = s.lines.find((x) => x.id === t.dataset.spotShot);
        if (l) l.shot = Number(t.value) || 0;
      }, { rerender: true });
    }
    if (t.dataset.spot || t.dataset.spotLine) renderSpotSlides(post());
  });
  form.addEventListener("click", (e) => {
    const t = (sel) => e.target.closest(sel);
    let b;
    if ((b = t("[data-spot-upload]"))) {
      const input = $("#spot-file");
      input.dataset.line = b.dataset.spotUpload;
      input.value = "";
      return input.click();
    }
    if ((b = t("[data-spot-store]")))
      return edit((s) => {
        const l = s.lines.find((x) => x.id === b.dataset.spotStore);
        if (l) l.image = null;
      }, { rerender: true });
    if ((b = t("[data-desk]"))) return pickDesk(b.dataset.desk);
  });
  $("#spot-file").addEventListener("change", (e) => {
    const files = [...e.target.files];
    if (files.length) useOwnScreenshots(e.target.dataset.line, files, uploadScreenshot);
  });
  $("#spot-write").addEventListener("click", writeSpotlight);

  const picker = $("[data-scolor]");
  const hex = $("[data-shex]");
  picker.addEventListener("input", () => {
    hex.value = picker.value;
    edit((s) => (s.color = picker.value));
  });
  hex.addEventListener("input", () => {
    const v = hex.value.trim().startsWith("#") ? hex.value.trim() : `#${hex.value.trim()}`;
    if (!HEX.test(v)) return;
    picker.value = v;
    edit((s) => (s.color = v.toLowerCase()));
  });
  hex.addEventListener("blur", () => (hex.value = spotOf()?.color || DEFAULT_SPOT_LOOK.color));

  $("#desk-folder").addEventListener("click", () => invoke("open_desks_folder").catch((e) => toast(`Couldn't open the folder: ${e}`, true)));
  $("#desk-make").addEventListener("click", makeDesk);
  $("#desk-mark-open").addEventListener("click", startMarking);
  $("#desk-mark-cancel").addEventListener("click", () => {
    ui.marking = null;
    renderSpotSlides(post());
  });
  $("#desk-mark-reset").addEventListener("click", () => {
    if (!ui.marking) return;
    ui.marking.points = [];
    renderMarking();
  });
  $("#desk-mark-save").addEventListener("click", () => ui.marking?.points.length === 4 && saveMarking(ui.marking.points));
  $("#desk-mark-auto").addEventListener("click", () => saveMarking(null));
  $("#desk-mark-stage").addEventListener("click", (e) => {
    const m = ui.marking;
    if (!m || m.points.length >= 4) return;
    const r = $("#desk-mark-img").getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * m.width;
    const y = ((e.clientY - r.top) / r.height) * m.height;
    m.points.push([Math.round(Math.min(Math.max(x, 0), m.width)), Math.round(Math.min(Math.max(y, 0), m.height))]);
    renderMarking();
  });

  // Images dropped onto the window (Tauri hands over their paths): onto a slide they become its
  // screenshot, onto Desk photo they become desk photos.
  const dropTarget = (pos) => {
    if (!pos || !isSpot() || ui.view !== "slides") return null;
    const el = document.elementFromPoint(pos.x / devicePixelRatio, pos.y / devicePixelRatio);
    return el?.closest?.("[data-drop-line], #desk-drop") || null;
  };
  let lit = null;
  const light = (el) => {
    if (lit === el) return;
    lit?.classList.remove("is-over");
    el?.classList.add("is-over");
    lit = el;
  };
  window.__TAURI__.webview
    ?.getCurrentWebview?.()
    ?.onDragDropEvent((e) => {
      const { type, paths, position } = e.payload;
      if (type === "leave") return light(null);
      const target = dropTarget(position);
      if (type !== "drop") return light(target);
      light(null);
      if (!paths?.length) return;
      if (!isSpot() || ui.view !== "slides") return toast("Open an app spotlight post's Slides to drop images in.", true);
      if (!target) return toast("Drop screenshots onto a slide, or desk photos onto Desk photo.", true);
      if (target.id === "desk-drop") return addDeskPhotos(paths);
      useOwnScreenshots(target.dataset.dropLine, paths, copyScreenshot);
    })
    .catch((e) => console.warn("Drag and drop isn't available:", e));
  // Photos added to the folder by hand show up when you come back to the app.
  addEventListener("focus", () => {
    if (isSpot() && ui.view === "slides") loadDesks();
  });
}

/* ---------- Hook ideas ---------- */
const hookText = (o) => [o.hookAccent, o.hookLine2, o.hookLine3].map((x) => String(x || "").trim()).filter(Boolean).join(" ");
const ideaText = (h) => [h.accent, h.line2, h.line3].map((x) => String(x || "").trim()).filter(Boolean).join(" ");

/** What kind of hooks to suggest. Kept per account, since an account usually sticks to one kind. */
const HOOK_MODES = ["generic", "niche", "fit"];
const hookStyle = () => {
  const s = acct()?.hookStyle || {};
  return { mode: HOOK_MODES.includes(s.mode) ? s.mode : "fit", niche: s.niche || "" };
};
const needsHookNiche = () => {
  const s = hookStyle();
  return s.mode === "niche" && !s.niche.trim();
};
function setHookStyle(patch) {
  const a = acct();
  if (!a) return;
  a.hookStyle = { ...hookStyle(), ...patch };
  renderHookIdeas();
  save();
}
function hookModeNote(p) {
  const s = hookStyle();
  if (s.mode === "generic") return `Broad hooks any iPhone user would stop for, like "underrated iphone apps". No niche.`;
  if (s.mode === "niche") return s.niche.trim() ? `Every hook speaks to people into ${s.niche.trim()}.` : "Type the niche the hooks should speak to.";
  const parts = [ownAppOf(p) && "your app", slideApps().length && "the apps you've picked", p?.niche?.trim() && `"${p.niche.trim()}"`].filter(Boolean);
  return parts.length
    ? `Fits ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]}.`
    : "Fits the apps you pick for this post. With none picked yet, the hooks come out general.";
}

/** Hook ideas appear in Find apps (to start a post from a hook) and in Slides; both stay in sync. */
function renderHookIdeas() {
  const p = post();
  const o = opts();
  const writer = WRITER_NAMES[state.writer];
  const has = !!p?.hookIdeas?.length;
  const hs = hookStyle();
  document.querySelectorAll("[data-hook-mode]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.hookMode === hs.mode)));
  document.querySelectorAll("[data-hook-niche]").forEach((input) => {
    input.hidden = hs.mode !== "niche";
    if (document.activeElement !== input) input.value = hs.niche;
    if (!hs.niche && p?.niche) input.placeholder = p.niche;
  });
  const note = p ? hookModeNote(p) : "";
  document.querySelectorAll("[data-hook-mode-note]").forEach((el) => (el.textContent = note));
  document.querySelectorAll("[data-hook-suggest]").forEach((btn) => {
    btn.disabled = !p || ui.hooking || needsHookNiche();
    btn.textContent = ui.hooking ? `${writer} is writing hooks` : has ? "More hook ideas" : `Suggest hooks with ${writer}`;
  });
  document.querySelectorAll("[data-hook-clear]").forEach((b) => (b.hidden = !has || ui.hooking));
  const current = hookKey(hookText(o));
  const saved = savedHooks();
  const isSaved = (h) => saved.some((s) => hookKey(ideaText(s)) === hookKey(ideaText(h)));
  const label = (h) => `<b style="color:${esc(o.accent)}">${esc(h.accent)}</b> ${[h.line2, h.line3].filter(Boolean).map(esc).join(" ")}`;
  const usedTag = (h) => {
    const reps = p ? hookRepeats(ideaText(h)) : [];
    return reps.length ? ` <span class="repeat ${isRecent(reps[0]) ? "is-recent" : ""}">used in ${esc(reps[0].name)}</span>` : "";
  };
  const ideas = (p?.hookIdeas || [])
    .map((h, i) => {
      const on = hookKey(ideaText(h)) === current;
      const star = isSaved(h);
      return `<li class="hook-item">
        <button type="button" class="hook-pick ${on ? "is-on" : ""}" data-hook="${i}">${label(h)}${usedTag(h)}</button>
        <button type="button" class="hook-side hook-star ${star ? "is-on" : ""}" data-star="${i}" aria-pressed="${star}" aria-label="${star ? "Remove from saved hooks" : "Save hook"}" title="${star ? "Saved. Click to remove." : "Save for later"}">${star ? "★" : "☆"}</button>
      </li>`;
    })
    .join("");
  document.querySelectorAll(".hook-ideas:not(.hook-saved)").forEach((ul) => (ul.innerHTML = ideas));

  const savedHtml = saved
    .map((h, i) => {
      const on = hookKey(ideaText(h)) === current;
      return `<li class="hook-item">
        <button type="button" class="hook-pick ${on ? "is-on" : ""}" data-saved-hook="${i}">${label(h)}${usedTag(h)}</button>
        <button type="button" class="hook-side" data-unsave="${i}" aria-label="Remove from saved hooks" title="Remove">×</button>
      </li>`;
    })
    .join("");
  document.querySelectorAll(".hook-saved").forEach((ul) => (ul.innerHTML = savedHtml));
  document.querySelectorAll("[data-saved-hooks]").forEach((d) => (d.hidden = !p));
  document.querySelectorAll("[data-saved-count]").forEach((s) => (s.textContent = saved.length ? `(${saved.length})` : ""));
  document.querySelectorAll("[data-saved-empty]").forEach((e) => (e.hidden = saved.length > 0));
  const curSaved = isSaved({ accent: o.hookAccent, line2: o.hookLine2, line3: o.hookLine3 });
  document.querySelectorAll("[data-hook-save]").forEach((b) => {
    b.disabled = !p || !current || curSaved;
    b.textContent = curSaved ? "Hook saved" : "Save this hook";
  });

  // Repeat guard for the hook in the fields.
  const reps = p ? hookRepeats(hookText(o)) : [];
  document.querySelectorAll("[data-hook-repeat]").forEach((el) => {
    el.hidden = !reps.length;
    el.classList.toggle("is-old", !!reps.length && !isRecent(reps[0]));
    el.textContent = reps.length
      ? `${handle(acct())} already used this hook in ${reps.map(repeatLabel).join("; ")}. ${isRecent(reps[0]) ? "Pick a new one so the account doesn't look repetitive." : "It was a while ago, so reusing it is probably fine."}`
      : "";
  });

  const rest = [o.hookLine2, o.hookLine3].filter(Boolean).map(esc).join(" ");
  $("#find-hook-text").innerHTML = !p
    ? ""
    : !current
    ? `No hook yet. Suggest some below, or type your own in Slides.`
    : `This post's hook: <b style="color:${esc(o.accent)}">${esc(o.hookAccent)}</b> ${rest}. Pick a new one, then Ask ${esc(writer)} for apps that fit it.`;
}

/* Saved hooks belong to the account, so they're there for every post (and go with the settings code). */
const savedHooks = () => acct()?.savedHooks || [];
const MAX_SAVED_HOOKS = 100;

function saveHook(h) {
  const a = acct();
  const hook = { accent: String(h.accent || "").trim(), line2: String(h.line2 || "").trim(), line3: String(h.line3 || "").trim() };
  if (!a || !hookKey(ideaText(hook))) return;
  const key = hookKey(ideaText(hook));
  a.savedHooks = [{ ...hook, savedAt: Date.now() }, ...(a.savedHooks || []).filter((s) => hookKey(ideaText(s)) !== key)].slice(0, MAX_SAVED_HOOKS);
  renderHookIdeas();
  save();
}

function unsaveHook(h) {
  const a = acct();
  if (!a) return;
  const key = hookKey(ideaText(h));
  a.savedHooks = (a.savedHooks || []).filter((s) => hookKey(ideaText(s)) !== key);
  renderHookIdeas();
  save();
}

function toggleStar(i) {
  const h = post()?.hookIdeas?.[i];
  if (!h) return;
  const key = hookKey(ideaText(h));
  if (savedHooks().some((s) => hookKey(ideaText(s)) === key)) unsaveHook(h);
  else saveHook(h);
}

function saveCurrentHook() {
  const o = opts();
  saveHook({ accent: o.hookAccent, line2: o.hookLine2, line3: o.hookLine3 });
  toast("Hook saved");
}

/** Hooks this account has already used, so new ones take a different angle. */
function usedHooks(p) {
  const a = accountOf(p);
  const used = new Set();
  // Written drawings drafts count too, so a batch of posts written together doesn't share hooks.
  for (const q of a ? postsOf(a) : [])
    if (q.id !== p.id && (q.slides || (isDrawn(q) && drawnOf(q)?.slides?.length) || (isSpot(q) && spotOf(q)?.hook?.trim()))) used.add(postHook(q));
  for (const h of p.hookIdeas || []) used.add(ideaText(h));
  for (const t of p.seenHooks || []) used.add(t);
  for (const h of a?.savedHooks || []) used.add(ideaText(h));
  return [...used].filter(Boolean);
}

/** The non-hook lines (points, turn slides, plug) of a drawings post. */
const bodyLines = (q) => {
  const d = drawnOf(q);
  return d ? [...d.slides.slice(1), ...(d.plug ? [d.plug] : [])].map((s) => s.text.trim()).filter(Boolean) : [];
};
/** This account's other drawings posts, newest first, drafts included. */
const otherDrawnPosts = (p) => {
  const a = accountOf(p);
  return (a ? postsOf(a) : []).filter((q) => q.id !== p.id && isDrawn(q)).sort((x, y) => postTime(y) - postTime(x));
};
/** Lines the writer shouldn't reuse: other posts' lines, newest first, then this post's current ones (when rewriting). */
const usedLines = (p) => [...new Set([...otherDrawnPosts(p).flatMap(bodyLines), ...bodyLines(p)])];
/** The other post that already has this line or a close rewording of it, if any. */
function lineRepeat(text, p = post()) {
  const key = hookKey(text);
  if (!p || words(text).size < 3) return null;
  return otherDrawnPosts(p).find((q) => bodyLines(q).some((l) => hookKey(l) === key || overlap(l, text) >= 0.8)) || null;
}

async function suggestHooks() {
  const p = post();
  if (!p || ui.hooking) return;
  const hs = hookStyle();
  if (needsHookNiche()) {
    document.querySelector(".view:not([hidden]) [data-hook-niche]")?.focus();
    return toast("Type a niche for the hooks first.", true);
  }
  ui.hooking = true;
  renderHookIdeas();
  try {
    const ideas = await invoke("suggest_hooks", {
      style: hs.mode,
      niche: hs.mode === "niche" ? hs.niche.trim() : hs.mode === "fit" ? p.niche || "" : "",
      ownApp: ownAppOf(p),
      apps: slideApps(),
      count: MAX_APPS,
      used: usedHooks(p),
      writer: state.writer,
    });
    // Newest ideas on top; keep a short history so earlier favourites stay clickable.
    p.hookIdeas = [...ideas, ...(p.hookIdeas || [])].slice(0, 24);
    save();
  } catch (e) {
    toast(`Couldn't write hooks: ${e}`, true);
  } finally {
    ui.hooking = false;
    renderHookIdeas();
  }
}

/** Clears the idea list. The hook text in the fields stays; cleared ideas are remembered so they aren't suggested again. */
function clearHooks() {
  const p = post();
  if (!p?.hookIdeas?.length) return;
  p.seenHooks = [...new Set([...(p.seenHooks || []), ...p.hookIdeas.map(ideaText)])].slice(-60);
  p.hookIdeas = [];
  renderHookIdeas();
  save();
}

function useHook(h) {
  const p = post();
  if (!p || !h) return;
  Object.assign(p.slideOptions, { hookAccent: h.accent, hookLine2: h.line2 || "", hookLine3: h.line3 || "" });
  renderSlideSettings();
  renderTray();
  renderHookIdeas();
  renderPost();
  save();
}

async function makeSlides() {
  const p = post();
  if (p && isSpot(p)) return ui.rendering ? undefined : makeSpotSlides(p);
  const apps = slideApps();
  const d = drawnOf(p);
  if (!p || ui.rendering || (isDrawn(p) ? !drawnSlides(p).some((s) => s.text.trim()) : !apps.length)) return;
  if (!isDrawn(p) && !hookText(p.slideOptions)) return toast("Add a hook first: pick a suggested one or type it in the hook fields.", true);
  ui.rendering = true;
  renderSlides();
  try {
    const plug = activePlug(p);
    const out = isDrawn(p)
      ? await invoke("render_drawn", {
          slides: d.slides.filter((s) => s.text.trim()),
          accent: d.accent || "",
          plug,
          plugApp: plug ? ownAppOf(p) : null,
          style: d.style,
        })
      : await invoke("render_slides", { apps, options: p.slideOptions });
    p.slides = { ...out, renderedAt: Date.now() };
    save();
    toast(`Made ${out.slides.length} slides`);
  } catch (e) {
    toast(`Couldn't make slides: ${e}`, true);
  } finally {
    ui.rendering = false;
    renderAll();
  }
}

function setOption(key, value) {
  const p = post();
  if (!p) return;
  p.slideOptions[key] = value;
  renderTray();
  if (key.startsWith("hook")) renderHookIdeas();
  save();
}

function bindSlides() {
  document.querySelectorAll("[data-o]").forEach((el) =>
    el.addEventListener("input", () => setOption(el.dataset.o, el.type === "number" ? Math.max(0, Number(el.value) || 0) : el.value)),
  );
  for (const key of Object.keys(DEFAULT_COLORS)) {
    const picker = $(`[data-color="${key}"]`);
    const hex = $(`[data-hex="${key}"]`);
    picker.addEventListener("input", () => {
      hex.value = picker.value;
      setOption(key, picker.value);
    });
    hex.addEventListener("input", () => {
      const v = hex.value.trim().startsWith("#") ? hex.value.trim() : `#${hex.value.trim()}`;
      if (!HEX.test(v)) return;
      picker.value = v;
      setOption(key, v.toLowerCase());
    });
    hex.addEventListener("blur", () => (hex.value = opts()[key]));
  }
  $("#reset-colors").addEventListener("click", () => {
    const p = post();
    if (!p) return;
    Object.assign(p.slideOptions, DEFAULT_COLORS);
    renderSlideSettings();
    renderTray();
    save();
  });
  $("#slide-settings").addEventListener("submit", (e) => e.preventDefault());
  $("#drawn-settings").addEventListener("submit", (e) => e.preventDefault());
  const setDrawnColor = (key, v) => {
    const d = drawnOf();
    if (!d) return;
    d.style[key] = v;
    renderTray();
    save();
  };
  for (const key of Object.keys(DEFAULT_DRAWN_STYLE)) {
    const picker = $(`[data-dcolor="${key}"]`);
    const hex = $(`[data-dhex="${key}"]`);
    picker.addEventListener("input", () => {
      hex.value = picker.value;
      setDrawnColor(key, picker.value);
    });
    hex.addEventListener("input", () => {
      const v = hex.value.trim().startsWith("#") ? hex.value.trim() : `#${hex.value.trim()}`;
      if (!HEX.test(v)) return;
      picker.value = v;
      setDrawnColor(key, v.toLowerCase());
    });
    hex.addEventListener("blur", () => (hex.value = (drawnOf()?.style || DEFAULT_DRAWN_STYLE)[key]));
  }
  $("#reset-dcolors").addEventListener("click", () => {
    const d = drawnOf();
    if (!d) return;
    d.style = { ...DEFAULT_DRAWN_STYLE };
    renderSlideSettings();
    renderTray();
    save();
  });
  document.addEventListener("input", (e) => {
    const n = e.target.closest?.("[data-hook-niche]");
    if (!n) return;
    const a = acct();
    if (!a) return;
    a.hookStyle = { ...hookStyle(), niche: n.value };
    // Keep the other copy (Find apps / Slides) and the button in step without re-rendering this box.
    document.querySelectorAll("[data-hook-niche]").forEach((x) => x !== n && (x.value = n.value));
    const note = hookModeNote(post());
    document.querySelectorAll("[data-hook-mode-note]").forEach((el) => (el.textContent = note));
    document.querySelectorAll("[data-hook-suggest]").forEach((b) => (b.disabled = !post() || ui.hooking || needsHookNiche()));
    save();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.closest?.("[data-hook-niche]")) {
      e.preventDefault();
      suggestHooks();
    }
  });
  document.addEventListener("click", (e) => {
    const mode = e.target.closest("[data-hook-mode]");
    if (mode) {
      setHookStyle({ mode: mode.dataset.hookMode });
      if (mode.dataset.hookMode === "niche") mode.closest(".hook-style")?.querySelector("[data-hook-niche]")?.focus();
      return;
    }
    if (e.target.closest("[data-hook-suggest]")) return suggestHooks();
    if (e.target.closest("[data-hook-clear]")) return clearHooks();
    if (e.target.closest("[data-hook-save]")) return saveCurrentHook();
    const t = e.target.closest(".hook-ideas button");
    if (!t) return;
    if (t.dataset.hook) useHook(post()?.hookIdeas?.[Number(t.dataset.hook)]);
    else if (t.dataset.star) toggleStar(Number(t.dataset.star));
    else if (t.dataset.savedHook) useHook(savedHooks()[Number(t.dataset.savedHook)]);
    else if (t.dataset.unsave) unsaveHook(savedHooks()[Number(t.dataset.unsave)]);
  });
  $("#make-slides").addEventListener("click", makeSlides);
  $("#show-folder").addEventListener("click", () => {
    const first = post()?.slides?.slides?.[0];
    if (first) window.__TAURI__.opener.revealItemInDir(first).catch((e) => toast(`Couldn't open the folder: ${e}`, true));
  });
}

/* ---------- Your app (per account) ---------- */
function renderMine() {
  const a = acct();
  if (!a) return;
  const m = ui.mine;
  const app = a.myApp;
  const editing = !app || m.editing;
  $("#mine-title").textContent = a.username ? `Your app on ${handle(a)}` : "Your app";
  $("#mine-set").hidden = editing;
  $("#mine-form").hidden = !editing;
  $("#mine-cancel").hidden = !app;
  $("#mine-remove").hidden = !app;
  const off = !!post()?.skipMine;
  const drawnMode = isDrawn();
  $("#mine-app").classList.toggle("is-off", off);
  const spotMode = isSpot();
  // In the drawings format the app is always the last slide, so there's no position to pick.
  $("#mine-pos").hidden = off || drawnMode;
  $(".mine-hint").textContent = drawnMode
    ? "Each post ends with a slide about it."
    : spotMode
      ? "Goes into every spotlight for this account, alongside the apps you pick."
      : "Goes into every post for this account, alongside the gems.";
  $("#mine-off").hidden = !off;
  $("#mine-skip").textContent = off ? "Add back to this post" : "Leave out of this post";
  $("#mine-find").disabled = m.searching;
  $("#mine-find").textContent = m.searching ? "Finding" : "Find";

  if (app) {
    const pr = preparedFor(app.trackId);
    $("#mine-icon").src = pr?.icon ? fileSrc(pr.icon) : app.artworkUrl100 || app.artworkUrl512 || "";
    $("#mine-name").textContent = app.trackName;
    $("#mine-artist").textContent = app.artistName;
    $("#mine-slot").innerHTML = ["1st", "2nd", "3rd", "4th", "5th", "6th"]
      .slice(0, MAX_APPS)
      .map((o, i) => `<option value="${i + 1}" ${mySlot() === i + 1 ? "selected" : ""}>${o}</option>`)
      .join("");
  }

  $("#mine-results").innerHTML = m.results
    .map(
      (r) => `<li><button type="button" data-mine-pick="${r.trackId}">
        <img class="icon" src="${esc(r.artworkUrl100 || r.artworkUrl512 || "")}" alt="" />
        <span class="ident-text"><span class="name">${esc(r.trackName)}</span><span class="sub">${esc(r.artistName)}</span></span>
      </button></li>`,
    )
    .join("");
}

async function findMine() {
  const query = $("#mine-query").value.trim();
  if (!query || ui.mine.searching) return;
  ui.mine.searching = true;
  renderMine();
  try {
    ui.mine.results = await invoke("find_app", { query, country: state.filter.country || "us" });
    if (!ui.mine.results.length) toast("No App Store app matched. Try pasting its App Store link.");
  } catch (e) {
    toast(`Couldn't search the App Store: ${e}`, true);
  } finally {
    ui.mine.searching = false;
    renderMine();
    $("#mine-results").lastElementChild?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function setMine(app) {
  const a = acct();
  const p = post();
  if (!a || !p) return;
  a.myApp = app;
  a.myAppSlot = a.myAppSlot || 3;
  delete p.skipMine;
  p.picked = p.picked.filter((x) => x.trackId !== app.trackId);
  const dropped = p.picked.splice(gemCapacity());
  ui.mine = { editing: false, searching: false, results: [] };
  $("#mine-query").value = "";
  ui.justAdded = app.trackId;
  renderAll();
  ui.justAdded = null;
  save();
  if (dropped.length) toast(`Removed ${dropped.map((d) => d.trackName).join(", ")} to make room for your app`);
}

/** Leaves the account's app out of the current post, or puts it back. */
function toggleSkipMine() {
  const p = post();
  const a = acct();
  if (!p || !a?.myApp) return;
  let dropped = [];
  if (p.skipMine) {
    delete p.skipMine;
    // Back in: make room the same way picking a new app does.
    p.picked = p.picked.filter((x) => x.trackId !== a.myApp.trackId);
    dropped = p.picked.splice(gemCapacity());
  } else {
    p.skipMine = true;
  }
  renderAll();
  save();
  if (dropped.length) toast(`Removed ${dropped.map((d) => d.trackName).join(", ")} to make room for your app`);
}

function bindMine() {
  $("#mine-form").addEventListener("submit", (e) => {
    e.preventDefault();
    findMine();
  });
  $("#mine-results").addEventListener("click", (e) => {
    const b = e.target.closest("[data-mine-pick]");
    if (!b) return;
    const app = ui.mine.results.find((r) => r.trackId === Number(b.dataset.minePick));
    if (app) setMine(app);
  });
  $("#mine-change").addEventListener("click", () => {
    ui.mine.editing = true;
    renderMine();
    $("#mine-query").focus();
  });
  $("#mine-cancel").addEventListener("click", () => {
    ui.mine = { editing: false, searching: false, results: [] };
    renderMine();
  });
  $("#mine-skip").addEventListener("click", toggleSkipMine);
  $("#mine-remove").addEventListener("click", () => {
    const a = acct();
    if (!a) return;
    a.myApp = null;
    for (const p of postsOf(a)) delete p.skipMine;
    ui.mine = { editing: false, searching: false, results: [] };
    renderAll();
    save();
    toast(`${handle(a)} no longer promotes an app`);
  });
  $("#mine-slot").addEventListener("change", (e) => {
    const a = acct();
    if (!a) return;
    a.myAppSlot = Number(e.target.value);
    renderAll();
    save();
  });
}

/* ---------- Caption + Send to phone ---------- */
const hookTitle = () => {
  if (isDrawn() || isSpot()) return postHook(post());
  const o = opts();
  const t = [o.hookAccent, o.hookLine2, o.hookLine3].map((x) => String(x || "").trim()).filter(Boolean).join(" ");
  return Number(o.part) > 0 ? `${t} (part ${o.part})` : t;
};
const parseTags = (text) =>
  [...new Set(text.split(/[\s,]+/).map((t) => t.replace(/[^\p{L}\p{N}_]/gu, "").toLowerCase()).filter(Boolean))];
const postText = (c = post()?.caption) => {
  if (!c) return "";
  const tags = c.hashtags.map((t) => `#${t}`).join(" ");
  return [c.caption.trim(), tags].filter(Boolean).join("\n\n");
};
const r2Ready = () => {
  const s = ui.settings;
  return !!(s && s.hasR2Secret && s.r2AccountId && s.r2AccessKeyId && s.r2Bucket && s.r2PublicUrl);
};
const postTitle = (p) => p.caption.title.trim() || hookTitle();
/** What the phone page shows besides the slides, to tell when it's out of date. */
const phoneText = (p) => JSON.stringify([postTitle(p), postText(p.caption)]);
/** "new" when the slides changed since they were sent, "text" when only the caption or title did. */
function phoneStale(p) {
  if (!p.phone) return null;
  if (p.phone.renderedAt !== p.slides?.renderedAt) return "new";
  return p.phone.text !== phoneText(p) ? "text" : null;
}

function renderPhone(p) {
  const ready = r2Ready();
  $("#phone-needs").hidden = ready;
  $("#phone-send").hidden = !ready;
  if (!ready) return;
  const ph = p.phone;
  const stale = phoneStale(p);
  const btn = $("#phone-btn");
  btn.hidden = !!ph && !stale;
  btn.disabled = ui.post.sending;
  btn.textContent = ui.post.sending
    ? stale === "text" ? "Updating" : "Uploading slides"
    : stale === "new" ? "Send new slides" : stale === "text" ? "Update phone page" : "Send to phone";
  $("#phone-copy").hidden = $("#phone-open").hidden = !ph;
  $("#phone-state").textContent = !ph
    ? ""
    : stale === "new"
      ? "You've remade the slides since sending them. Send them again for a new link."
      : stale === "text"
        ? "The caption or title changed since you sent it. Update the page to keep the same link."
        : `Sent ${fmtWhen(ph.sentAt)}. Scan the code with your phone's camera.`;

  const qr = $("#phone-qr");
  qr.hidden = !ph;
  if (ph && ui.qr.url !== ph.url) {
    ui.qr = { url: ph.url, svg: "" };
    invoke("qr_code", { text: ph.url }).then(
      (svg) => {
        if (ui.qr.url !== ph.url) return;
        ui.qr.svg = svg;
        renderPost();
      },
      (e) => toast(`Couldn't draw the QR code: ${e}`, true),
    );
  }
  // Generated locally from our own link, so it's safe to put in as markup.
  if (ph && qr.dataset.url !== ph.url) {
    qr.innerHTML = ui.qr.svg;
    qr.dataset.url = ui.qr.svg ? ph.url : "";
  }
  qr.classList.toggle("is-stale", stale === "new");

  const posted = $("#phone-posted");
  posted.hidden = !ph && !p.posted;
  posted.innerHTML = p.posted
    ? `<span class="status status-sent">Posted</span> <span>${esc(fmtWhen(p.posted.at))}</span> <button type="button" class="link" id="unmark-posted">Undo</button>`
    : `<button type="button" class="btn btn-quiet" id="mark-posted">Mark as posted</button>`;
}

function renderPost() {
  const p = post();
  const last = p?.slides;
  $("#post").hidden = !last;
  if (!last) return;
  const c = p.caption;
  const title = $("#post-title");
  title.placeholder = hookTitle();
  if (document.activeElement !== title) title.value = c.title;
  const cap = $("#post-caption");
  if (document.activeElement !== cap) cap.value = c.caption;
  const tags = $("#post-tags");
  if (document.activeElement !== tags) tags.value = c.hashtags.join(" ");
  const n = c.hashtags.length;
  $("#tag-count").textContent = n > MAX_HASHTAGS ? `${n} hashtags. TikTok allows ${MAX_HASHTAGS}.` : `${n} / ${MAX_HASHTAGS} hashtags`;
  $("#tag-count").classList.toggle("is-over", n > MAX_HASHTAGS);

  const write = $("#write-caption");
  write.disabled = ui.post.writing || !(isDrawn(p) ? drawnSlides(p).some((s) => s.text.trim()) : isSpot(p) ? !!spotApps(p) : slideApps().length);
  write.textContent = ui.post.writing ? `${WRITER_NAMES[state.writer]} is writing` : c.caption ? "Rewrite caption" : "Write caption";
  $("#copy-caption").disabled = !postText();
  renderPhone(p);
}

/** The account's own app, when this post shows it (so the caption has to say it's yours). */
function featuredOwnApp(p) {
  const own = ownAppOf(p);
  if (!own) return null;
  if (isDrawn(p)) return activePlug(p) ? own : null;
  return lineupFor(p).some((a) => a.trackId === own.trackId) ? own : null;
}

/** "Paper Pond: Origami Letters" -> "Paper Pond". */
function shortAppName(name) {
  const short = name.split(/[:|–—]| - /)[0].trim();
  return short || name.trim();
}

/** Puts "(fyi: i made App)" right after the caption's first sentence, so it shows before TikTok's "more". */
function withDisclosure(caption, app) {
  const name = shortAppName(app.trackName);
  const note = `(fyi: i made ${name})`;
  const text = caption.trim();
  if (!text) return note;
  if (text.toLowerCase().includes(`i made ${name.toLowerCase()}`)) return text;
  const line = text.indexOf("\n");
  const firstLine = line < 0 ? text.length : line;
  const stop = text.slice(0, firstLine).search(/[.!?…](?=\s|$)/);
  let at = stop < 0 ? firstLine : stop + 1;
  // Keep emoji that close the sentence with it.
  const tail = text.slice(at, firstLine).match(/^(\s*\p{Extended_Pictographic}[\p{Extended_Pictographic}\p{Cf}\p{M}\s]*)/u);
  if (tail) at += tail[1].trimEnd().length;
  return `${text.slice(0, at)} ${note}${text.slice(at)}`;
}

async function writeCaption() {
  const p = post();
  const apps = slideApps();
  const texts = drawnSlides(p).map((s) => s.text).filter((t) => t.trim());
  const spot = isSpot(p) ? spotOf(p) : null;
  const spotted = spot ? spotApps(p) : null;
  if (!p || ui.post.writing || !(isDrawn(p) ? texts.length : spot ? spotted : apps.length)) return;
  ui.post.writing = true;
  renderPost();
  try {
    const c = isDrawn(p)
      ? await invoke("generate_drawn_caption", { topic: drawnOf(p).topic || "", slides: texts, writer: state.writer })
      : spot
      ? await invoke("generate_spotlight_caption", {
          prepared: spotted,
          slides: [spot.hook, ...spot.lines.map((l) => l.text), spot.cta],
          writer: state.writer,
        })
      : await invoke("generate_caption", {
          // The hook and the picked apps set the theme. The search box may still hold another post's niche, so it's only a hint.
          hook: hookTitle(),
          niche: p.niche || "",
          apps,
          ownAppId: ownAppOf(p)?.trackId ?? null,
          writer: state.writer,
        });
    const own = featuredOwnApp(p);
    p.caption.caption = own ? withDisclosure(c.caption, own) : c.caption;
    p.caption.hashtags = c.hashtags;
    save();
  } catch (e) {
    toast(`Couldn't write the caption: ${e}`, true);
  } finally {
    ui.post.writing = false;
    renderPost();
  }
}

/** Uploads the slides and phone page, or just refreshes the page when only the caption or title changed. */
async function sendToPhone() {
  const p = post();
  if (!p?.slides || ui.post.sending) return;
  if (p.caption.hashtags.length > MAX_HASHTAGS) return toast(`TikTok allows ${MAX_HASHTAGS} hashtags. Remove a few first.`, true);
  const textOnly = phoneStale(p) === "text";
  const renderedAt = p.slides.renderedAt;
  const text = phoneText(p);
  ui.post.sending = true;
  renderPost();
  try {
    const out = await invoke("send_to_phone", {
      slides: p.slides.slides,
      name: p.name,
      account: handle(accountOf(p)),
      title: postTitle(p),
      caption: { caption: p.caption.caption, hashtags: p.caption.hashtags },
      folder: textOnly ? p.phone.folder : null,
      images: !textOnly,
    });
    p.phone = { folder: out.folder, url: out.url, sentAt: textOnly ? p.phone.sentAt : Date.now(), renderedAt, text };
    // Already have the code for this link.
    ui.qr = { url: out.url, svg: out.qr };
    save();
    toast(textOnly ? "Updated the phone page. Same link and code." : "Sent. Scan the code with your phone.");
  } catch (e) {
    toast(`Couldn't send to your phone: ${e}`, true);
  } finally {
    ui.post.sending = false;
    renderAll();
    renderPost();
  }
}

function setPosted(on) {
  const p = post();
  if (!p) return;
  p.posted = on ? { at: Date.now() } : null;
  save();
  renderPost();
}

function bindPost() {
  const edit = (fn) => (e) => {
    const p = post();
    if (!p) return;
    fn(p, e.target.value);
    save();
  };
  $("#post-title").addEventListener("input", edit((p, v) => {
    p.caption.title = v;
    renderPhone(p);
  }));
  $("#post-caption").addEventListener("input", edit((p, v) => {
    p.caption.caption = v;
    $("#copy-caption").disabled = !postText();
    renderPhone(p);
  }));
  $("#post-tags").addEventListener("input", edit((p, v) => {
    p.caption.hashtags = parseTags(v);
    renderPost();
  }));
  $("#post-tags").addEventListener("blur", renderPost);
  $("#write-caption").addEventListener("click", writeCaption);
  $("#copy-caption").addEventListener("click", () =>
    navigator.clipboard.writeText(postText()).then(
      () => toast("Caption and hashtags copied"),
      (e) => toast(`Couldn't copy: ${e}`, true),
    ),
  );
  $("#phone-btn").addEventListener("click", sendToPhone);
  $("#phone-copy").addEventListener("click", () => {
    const url = post()?.phone?.url;
    if (url) navigator.clipboard.writeText(url).then(() => toast("Link copied"), (e) => toast(`Couldn't copy: ${e}`, true));
  });
  $("#phone-open").addEventListener("click", () => {
    const url = post()?.phone?.url;
    if (url) window.__TAURI__.opener.openUrl(url).catch((e) => toast(`Couldn't open the link: ${e}`, true));
  });
  $("#phone-posted").addEventListener("click", (e) => {
    if (e.target.closest("#mark-posted")) setPosted(true);
    else if (e.target.closest("#unmark-posted")) setPosted(false);
  });
  document.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.goto)));
  $("#post-name").addEventListener("input", (e) => {
    const p = post();
    if (!p) return;
    p.name = e.target.value;
    save();
  });
  $("#post-name").addEventListener("blur", (e) => {
    const p = post();
    if (p && !p.name.trim()) {
      p.name = "Untitled post";
      e.target.value = p.name;
      save();
    }
  });
}

/* ---------- Analytics ---------- */
const METRICS = [
  { key: "views", label: "Views" },
  { key: "likes", label: "Likes" },
  { key: "comments", label: "Comments" },
  { key: "shares", label: "Shares" },
  { key: "saves", label: "Saves" },
  { key: "reposts", label: "Reposts" },
];
const HOUR_MS = 3_600_000;
const an = {
  accountId: null,
  status: null,
  profiles: [],
  /** By username: posts with latest and previous numbers. */
  videos: {},
  /** By username: one point per scrape with every post's numbers added up. */
  totals: {},
  /** By video id: every snapshot of that post. */
  history: {},
  open: null,
  sort: { key: "postedAt", dir: -1 },
  loading: false,
  scraping: false,
  error: "",
};
const metricsReady = () => !!(ui.settings?.metricsUrl && ui.settings?.hasMetricsToken);
const api = (method, path, body) => invoke("metrics", { method, path, body: body ?? null });
const anAccounts = () => state.accounts.filter((a) => a.username);
const anAccount = () => anAccounts().find((a) => a.id === an.accountId) || anAccounts()[0] || null;
/** The Worker keeps usernames in lower case. */
const metricUser = (a) => a.username.toLowerCase();
const fmtShort = (n) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
const fmtDelta = (d) => (d > 0 ? `+${fmtCount(d)}` : d < 0 ? `−${fmtCount(-d)}` : "0");
const fmtDay = (t) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
function timeAgo(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!(ms >= 0)) return "just now";
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const h = Math.round(ms / HOUR_MS);
  if (h < 36) return `${h} hour${h === 1 ? "" : "s"} ago`;
  return ago(Date.parse(iso));
}
/** The Worker's scheduled scrapes start at 00:00 and 12:00 UTC. */
function nextScrape() {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(d.getUTCHours() < 12 ? 12 : 24);
  return d.toISOString();
}
const videoIdFromUrl = (u) => String(u || "").match(/\/(?:video|photo)\/(\d+)/)?.[1] || null;

/** Tells the Worker which accounts to scrape: every account with a username. */
let syncTimer;
let stateLoaded = false;
function syncProfiles() {
  if (!metricsReady() || !stateLoaded) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow().catch((e) => toast(`Couldn't send your accounts to the analytics Worker: ${e}`, true)), 300);
}
async function syncNow() {
  clearTimeout(syncTimer);
  an.profiles = await api("PUT", "/profiles", { usernames: anAccounts().map(metricUser) });
}

let pollTimer;
async function loadAnalytics() {
  if (!metricsReady()) return renderAnalytics();
  const a = anAccount();
  const u = a ? metricUser(a) : null;
  an.loading = true;
  an.error = "";
  renderAnalytics();
  try {
    const [status, profiles, videos, totals] = await Promise.all([
      api("GET", "/status"),
      api("GET", "/profiles"),
      u ? api("GET", `/videos?username=${encodeURIComponent(u)}`) : null,
      u ? api("GET", `/profiles/${encodeURIComponent(u)}/totals`) : null,
    ]);
    Object.assign(an, { status, profiles });
    if (u) {
      an.videos[u] = videos;
      an.totals[u] = totals;
      an.history = {};
      await autoLink(a, videos);
      if (an.open && videos.some((v) => v.id === an.open)) loadHistory(an.open);
    }
  } catch (e) {
    an.error = String(e);
  } finally {
    an.loading = false;
    renderAnalytics();
  }
  // While a scrape is running, look again every minute.
  clearTimeout(pollTimer);
  if (scrapeRunning() && ui.view === "analytics") pollTimer = setTimeout(() => refreshAnalytics(true), 60_000);
}
const scrapeRunning = () => (an.status?.runs || []).some((r) => r.status === "running" || r.status === "saving");

async function refreshAnalytics(quiet = false) {
  try {
    await api("POST", "/scrape/check");
  } catch (e) {
    if (!quiet) toast(`${e}`, true);
  }
  await loadAnalytics();
}

async function scrapeNow() {
  if (an.scraping) return;
  an.scraping = true;
  renderAnalytics();
  try {
    await syncNow();
    const r = await api("POST", "/scrape");
    toast(r.started ? "Scrape started. Numbers usually arrive within a few minutes." : r.reason || "A scrape is already running.");
    await loadAnalytics();
  } catch (e) {
    toast(`Couldn't start a scrape: ${e}`, true);
  } finally {
    an.scraping = false;
    renderAnalytics();
  }
}

async function loadHistory(id) {
  try {
    an.history[id] = await api("GET", `/videos/${encodeURIComponent(id)}/history`);
  } catch (e) {
    an.history[id] = [];
    toast(`Couldn't load this post's history: ${e}`, true);
  }
  renderAnalytics();
}

/* Linking TikTok posts to OpenUGC posts, so the numbers can be read against hooks and apps. */
function linkFor(p, videoId, linkedBy) {
  const a = accountOf(p);
  return {
    videoId,
    postId: p.id,
    username: a?.username || "",
    postName: p.name,
    hook: postHook(p),
    apps: lineupFor(p).map((x) => x.trackName),
    myApp: ownAppOf(p)?.trackName || null,
    myAppSlot: ownAppOf(p) ? a.myAppSlot || 3 : null,
    linkedBy,
  };
}
const words = (t) => new Set(String(t || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
function overlap(a, b) {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

/**
 * Links posts you sent to your phone (or marked posted) to the TikTok posts they became. A saved
 * link to the published post (from the Buffer days) is used when there is one; otherwise the
 * TikTok post closest to when you marked it posted (or sent it), if its caption matches or it
 * went out within 12 hours. Posts you unlinked by hand are left alone.
 */
async function autoLink(a, videos) {
  const taken = new Set(videos.filter((v) => v.link).map((v) => v.link.postId));
  const free = () => videos.filter((v) => !v.link);
  const candidates = postsOf(a).filter((p) => (p.posted || p.phone) && !p.noAutoLink && !taken.has(p.id));
  const links = [];
  const claim = (p, v) => {
    links.push(linkFor(p, v.id, "auto"));
    v.link = { postId: p.id, postName: p.name, linkedBy: "auto" };
    taken.add(p.id);
  };
  for (const p of candidates) {
    const id = videoIdFromUrl(p.posted?.link);
    const v = id && free().find((x) => x.id === id);
    if (v) claim(p, v);
  }
  const pairs = [];
  for (const p of candidates.filter((p) => !taken.has(p.id))) {
    const due = p.posted?.at || p.phone?.sentAt;
    if (!due) continue;
    const text = postText(p.caption);
    for (const v of free()) {
      const gap = Math.abs(Date.parse(v.postedAt) - due);
      if (!(gap <= 3 * DAY_MS)) continue;
      const sim = overlap(text, v.caption);
      if (sim >= 0.4 || (gap <= 12 * HOUR_MS && (sim >= 0.15 || !text.trim()))) pairs.push({ p, v, score: sim - gap / (3 * DAY_MS) });
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  for (const { p, v } of pairs) if (!taken.has(p.id) && !v.link) claim(p, v);
  if (!links.length) return;
  try {
    await api("PUT", "/links", { links });
  } catch (e) {
    toast(`Couldn't save post links: ${e}`, true);
  }
}

async function setLink(videoId, postId) {
  const v = (an.videos[metricUser(anAccount())] || []).find((x) => x.id === videoId);
  try {
    if (postId) {
      const p = state.posts.find((x) => x.id === postId);
      if (!p) return;
      delete p.noAutoLink;
      await api("PUT", "/links", { links: [linkFor(p, videoId, "manual")] });
    } else {
      // Don't link this post again automatically.
      const old = state.posts.find((x) => x.id === v?.link?.postId);
      if (old) old.noAutoLink = true;
      await api("DELETE", `/links/${encodeURIComponent(videoId)}`);
    }
    save();
    await loadAnalytics();
  } catch (e) {
    toast(`Couldn't change the link: ${e}`, true);
  }
}

/* ---------- Charts: one metric each, so one axis and one colour ---------- */
const charts = new Map();
let chartSeq = 0;

/** points: [{ t: ms, v: number }] oldest first. */
function chartCard(label, points, { sub = "" } = {}) {
  const id = `c${++chartSeq}`;
  charts.set(id, { label, points });
  const last = points.at(-1);
  const prev = points.at(-2);
  const delta = last && prev ? last.v - prev.v : null;
  return `<figure class="chart-card">
    <figcaption>
      <span class="chart-label">${esc(label)}</span>
      <span class="chart-value">${last ? esc(fmtShort(last.v)) : "None yet"}</span>
      <span class="chart-delta">${delta == null ? esc(sub) : `${esc(fmtDelta(delta))} since the scrape before`}</span>
    </figcaption>
    <div class="chart" data-chart="${id}"></div>
  </figure>`;
}

function niceStep(x) {
  if (!(x > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(x));
  const f = x / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
}
function niceTicks(lo, hi) {
  // Start at zero unless the line would be squashed against the top.
  if (lo <= hi - lo) lo = 0;
  if (hi === lo) {
    // A flat line: show it against zero rather than an axis zoomed into nothing.
    if (lo > 0) lo = 0;
    else hi = lo + 1;
  }
  const step = Math.max(1, niceStep((hi - lo) / 3));
  const ticks = [];
  for (let v = Math.floor(lo / step) * step; v < hi + step; v += step) ticks.push(v);
  return ticks.at(-1) < hi ? [...ticks, ticks.at(-1) + step] : ticks;
}

function drawChart(el) {
  const c = charts.get(el.dataset.chart);
  if (!c) return;
  const pts = c.points;
  if (!pts.length) {
    el.innerHTML = `<p class="chart-empty">Appears after the first scrape</p>`;
    return;
  }
  const W = Math.max(180, el.clientWidth);
  const H = 132;
  const m = { l: 46, r: 14, t: 8, b: 22 };
  const ts = pts.map((p) => p.t);
  let t0 = Math.min(...ts);
  let t1 = Math.max(...ts);
  if (t0 === t1) [t0, t1] = [t0 - 12 * HOUR_MS, t1 + 12 * HOUR_MS];
  const ticks = niceTicks(Math.min(...pts.map((p) => p.v)), Math.max(...pts.map((p) => p.v)));
  const [y0, y1] = [ticks[0], ticks.at(-1)];
  const x = (t) => m.l + ((t - t0) / (t1 - t0)) * (W - m.l - m.r);
  const y = (v) => H - m.b - ((v - y0) / (y1 - y0)) * (H - m.t - m.b);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const area = `${line}L${x(pts.at(-1).t).toFixed(1)},${y(y0)}L${x(pts[0].t).toFixed(1)},${y(y0)}Z`;
  const short = t1 - t0 < 2 * DAY_MS;
  const xLabel = (t) => (short ? new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : fmtDay(t));
  const last = pts.at(-1);
  el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(c.label)} over time">
    ${ticks.map((v) => `<line class="ch-grid" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text class="ch-axis" x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${esc(fmtShort(v))}</text>`).join("")}
    <text class="ch-axis" x="${m.l}" y="${H - 5}">${esc(xLabel(pts[0].t))}</text>
    ${pts.length > 1 ? `<text class="ch-axis" x="${W - m.r}" y="${H - 5}" text-anchor="end">${esc(xLabel(last.t))}</text>` : ""}
    ${pts.length > 1 ? `<path class="ch-area" d="${area}"/><path class="ch-line" d="${line}"/>` : ""}
    <circle class="ch-dot" cx="${x(last.t)}" cy="${y(last.v)}" r="4"/>
    <line class="ch-cross" y1="${m.t}" y2="${H - m.b}" hidden/>
    <circle class="ch-dot ch-hover" r="4" hidden/>
  </svg><div class="ch-tip" hidden></div>`;
  const svg = el.querySelector("svg");
  const cross = el.querySelector(".ch-cross");
  const dot = el.querySelector(".ch-hover");
  const tip = el.querySelector(".ch-tip");
  const hide = () => [cross, dot, tip].forEach((n) => n.setAttribute("hidden", ""));
  el.onpointerleave = hide;
  el.onpointermove = (e) => {
    const px = e.clientX - svg.getBoundingClientRect().left;
    let i = 0;
    for (let k = 1; k < pts.length; k++) if (Math.abs(x(pts[k].t) - px) < Math.abs(x(pts[i].t) - px)) i = k;
    const p = pts[i];
    const cx = x(p.t);
    cross.setAttribute("x1", cx);
    cross.setAttribute("x2", cx);
    dot.setAttribute("cx", cx);
    dot.setAttribute("cy", y(p.v));
    [cross, dot, tip].forEach((n) => n.removeAttribute("hidden"));
    const d = i ? p.v - pts[i - 1].v : null;
    tip.innerHTML = `<span class="ch-tip-when">${esc(fmtWhen(new Date(p.t).toISOString()))}</span><b>${esc(fmtCount(p.v))}</b> ${esc(c.label.toLowerCase())}${d == null ? "" : `<span class="ch-tip-d">${esc(fmtDelta(d))} since the scrape before</span>`}`;
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.min(Math.max(cx - tw / 2, 0), W - tw)}px`;
  };
}
const drawCharts = () => document.querySelectorAll("#view-analytics .chart[data-chart]").forEach(drawChart);

/** One chart per metric. Reposts only show if TikTok reported any. */
function metricCharts(rows, { followers = false } = {}) {
  const series = (key) => rows.filter((r) => r[key] != null).map((r) => ({ t: Date.parse(r.scrapedAt), v: r[key] }));
  const list = followers ? [{ key: "followers", label: "Followers" }, ...METRICS] : METRICS;
  return list
    .filter((m) => m.key !== "reposts" || rows.some((r) => r.reposts != null))
    .map((m) => chartCard(m.label, series(m.key)))
    .join("");
}

function renderAnalytics() {
  if (ui.view !== "analytics") return;
  const ready = metricsReady();
  const accts = anAccounts();
  const a = anAccount();
  if (a) an.accountId = a.id;
  const u = a ? metricUser(a) : null;
  $("#an-setup").hidden = ready;
  $("#an-actions").hidden = !ready || !accts.length;
  $("#an-account").innerHTML = accts.map((x) => `<option value="${esc(x.id)}" ${x.id === a?.id ? "selected" : ""}>${esc(handle(x))}</option>`).join("");
  const running = scrapeRunning();
  $("#an-refresh").disabled = an.loading;
  $("#an-refresh").textContent = an.loading ? "Refreshing" : "Refresh";
  $("#an-scrape").disabled = an.scraping || running;
  $("#an-scrape").textContent = an.scraping ? "Starting" : running ? "Scraping" : "Scrape now";

  // Status line under the title.
  const runs = an.status?.runs || [];
  const live = runs.find((r) => r.status === "running" || r.status === "saving");
  const done = runs.find((r) => r.status === "done");
  let status = "Views, likes, comments, shares and saves for every TikTok post, scraped every 12 hours.";
  if (ready && an.status) {
    if (live) status = `Scraping now, started ${timeAgo(live.started_at)}. ${live.status === "saving" ? "Saving the results." : "This usually takes a few minutes."}`;
    else if (done) status = `Last scraped ${timeAgo(done.finished_at || done.started_at)}. Next scrape ${fmtWhen(nextScrape())}.`;
    else status = "No scrapes yet. Press Scrape now for the first one.";
    if (runs[0]?.status === "failed") status += ` The last try failed: ${runs[0].error || "unknown error"}.`;
  }
  $("#an-status").textContent = status;

  const profile = an.profiles.find((p) => p.username === u);
  const totals = (u && an.totals[u]) || [];
  const videos = (u && an.videos[u]) || [];
  let note = "";
  if (an.error) note = an.error;
  else if (ready && !accts.length) note = "Add an account with a TikTok username on the Posts page first.";
  else if (profile?.lastError) note = `TikTok didn't return @${u} on the last scrape (${profile.lastError}). Private accounts can't be scraped.`;
  else if (ready && an.status && u && !totals.length && !an.loading) note = `No numbers for @${u} yet. They appear after its first scrape.`;
  $("#an-note").hidden = !note;
  $("#an-note").textContent = note;
  $("#an-note").classList.toggle("is-error", !!an.error || !!profile?.lastError);

  charts.clear();
  const showTotals = ready && totals.length > 0;
  $("#an-totals").hidden = !showTotals;
  if (showTotals) {
    const last = totals.at(-1);
    $("#an-totals-sub").textContent = `${fmtCount(last.posts)} post${last.posts === 1 ? "" : "s"}, numbers added up at each scrape`;
    $("#an-charts").innerHTML = metricCharts(totals, { followers: true });
  }
  $("#an-posts").hidden = !ready || !videos.length;
  if (videos.length) renderPostTable(a, videos);
  drawCharts();
}

function renderPostTable(a, videos) {
  const hasReposts = videos.some((v) => v.latest?.reposts != null);
  const cols = METRICS.filter((m) => m.key !== "reposts" || hasReposts);
  const { key, dir } = an.sort;
  const val = (v) => (key === "postedAt" ? Date.parse(v.postedAt) || 0 : key === "change" ? change(v) : v.latest?.[key] ?? -1);
  const sorted = [...videos].sort((x, y) => (val(x) - val(y)) * dir);
  const table = $("#view-analytics .an-table");
  table.style.setProperty("--an-cols", `minmax(220px, 3fr) repeat(${cols.length + 1}, minmax(70px, 1fr))`);
  const head = (k, label) =>
    `<button type="button" class="an-sort ${key === k ? "is-on" : ""}" data-sort="${k}" role="columnheader" aria-sort="${key === k ? (dir < 0 ? "descending" : "ascending") : "none"}">${esc(label)}${key === k ? (dir < 0 ? " ↓" : " ↑") : ""}</button>`;
  $("#an-thead").innerHTML = head("postedAt", "Post") + cols.map((m) => head(m.key, m.label)).join("") + head("change", "New views");
  $("#an-posts-sub").textContent = `${videos.length} on TikTok. Click a post to see it over time.`;
  const posts = postsOf(a);
  $("#an-rows").innerHTML = sorted
    .map((v) => {
      const open = an.open === v.id;
      const ch = change(v);
      const link = v.link && state.posts.find((p) => p.id === v.link.postId);
      const row = `<div class="an-row ${open ? "is-open" : ""}" role="row" tabindex="0" data-video="${esc(v.id)}" aria-expanded="${open}">
        <div class="an-post" role="cell">
          <span class="an-caption">${esc((v.caption || "No caption").slice(0, 120))}</span>
          <span class="an-meta">${v.postedAt ? esc(fmtDay(Date.parse(v.postedAt))) : "Unknown date"}${v.isSlideshow ? ", slideshow" : ""}${v.isPinned ? ", pinned" : ""}${link ? `. <span class="an-linked">${esc(link.name)}</span>` : ""}</span>
        </div>
        ${cols.map((m) => `<div class="num" role="cell">${v.latest?.[m.key] == null ? "–" : esc(fmtCount(v.latest[m.key]))}</div>`).join("")}
        <div class="num an-change" role="cell">${ch == null ? "–" : esc(fmtDelta(ch))}</div>
      </div>`;
      if (!open) return row;
      const hist = an.history[v.id];
      return `${row}<div class="an-detail">
        <div class="charts charts-tight">${hist ? metricCharts(hist) : `<p class="loading-row"><span class="spinner"></span>Loading this post's history</p>`}</div>
        <div class="an-detail-actions">
          <label class="an-link-pick">OpenUGC post
            <select data-link-video="${esc(v.id)}">
              <option value="">Not linked</option>
              ${posts.map((p) => `<option value="${esc(p.id)}" ${link?.id === p.id ? "selected" : ""}>${esc(p.name)}${p.posted || p.phone ? `, ${esc(fmtDay(p.posted?.at || p.phone.sentAt))}` : ""}</option>`).join("")}
            </select>
          </label>
          ${link ? `<button type="button" class="btn btn-quiet" data-open-post="${esc(link.id)}">Open ${esc(link.name)}</button>` : ""}
          ${v.url ? `<button type="button" class="btn btn-quiet" data-tiktok="${esc(v.url)}">Open on TikTok</button>` : ""}
          ${v.link ? `<span class="an-meta">${v.link.linkedBy === "auto" ? "Linked automatically" : "Linked by you"}</span>` : ""}
        </div>
      </div>`;
    })
    .join("");
}
/** Views gained since the scrape before. */
const change = (v) => (v.latest?.views != null && v.previous?.views != null ? v.latest.views - v.previous.views : null);

function bindAnalytics() {
  $("#an-account").addEventListener("change", (e) => {
    an.accountId = e.target.value;
    an.open = null;
    loadAnalytics();
  });
  $("#an-refresh").addEventListener("click", () => refreshAnalytics());
  $("#an-scrape").addEventListener("click", scrapeNow);
  const view = $("#view-analytics");
  const toggle = (row) => {
    const id = row.dataset.video;
    an.open = an.open === id ? null : id;
    if (an.open && !an.history[id]) loadHistory(id);
    renderAnalytics();
  };
  view.addEventListener("click", (e) => {
    const t = (sel) => e.target.closest(sel);
    let b;
    if ((b = t("[data-sort]"))) {
      const k = b.dataset.sort;
      an.sort = { key: k, dir: an.sort.key === k ? -an.sort.dir : -1 };
      return renderAnalytics();
    }
    if ((b = t("[data-open-post]"))) return openPost(b.dataset.openPost);
    if ((b = t("[data-tiktok]"))) return window.__TAURI__.opener.openUrl(b.dataset.tiktok).catch((err) => toast(`Couldn't open TikTok: ${err}`, true));
    if ((b = t("[data-video]"))) toggle(b);
  });
  view.addEventListener("keydown", (e) => {
    const row = e.target.closest?.("[data-video]");
    if (row && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      toggle(row);
    }
  });
  view.addEventListener("change", (e) => {
    const s = e.target.closest("[data-link-video]");
    if (s) setLink(s.dataset.linkVideo, s.value);
  });
  // Charts are drawn to their pixel width, so redraw them when the width changes (not the height).
  let frame;
  let width = 0;
  new ResizeObserver(([e]) => {
    const w = Math.round(e.contentRect.width);
    if (w === width) return;
    width = w;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(drawCharts);
  }).observe($("#an-body"));
}

/* ---------- Settings ---------- */
const SAVED_HINT = "Saved. Type a new key to replace it.";

function renderSettings() {
  const s = ui.settings || {};
  document.querySelectorAll("[data-s]").forEach((el) => {
    if (document.activeElement !== el) el.value = s[el.dataset.s] || "";
  });
  $("#set-r2-secret").placeholder = s.hasR2Secret ? SAVED_HINT : "";
  $("#set-metrics-token").placeholder = s.hasMetricsToken ? SAVED_HINT : "";
}

async function saveSettings({ quiet = false } = {}) {
  const settings = {};
  document.querySelectorAll("[data-s]").forEach((el) => (settings[el.dataset.s] = el.value.trim()));
  const r2Secret = $("#set-r2-secret").value.trim() || null;
  const metricsToken = $("#set-metrics-token").value.trim() || null;
  try {
    ui.settings = await invoke("save_settings", { settings, r2Secret, metricsToken });
    $("#set-r2-secret").value = "";
    $("#set-metrics-token").value = "";
    syncProfiles();
    renderSettings();
    renderPost();
    if (!quiet) toast("Settings saved");
    return true;
  } catch (e) {
    toast(`Couldn't save settings: ${e}`, true);
    return false;
  }
}

async function runCheck(btn, label, fn) {
  if (!(await saveSettings({ quiet: true }))) return;
  btn.disabled = true;
  btn.textContent = "Checking";
  try {
    toast(await fn());
  } catch (e) {
    toast(`${e}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/* A settings code is "openugc1:" + base64(JSON). It carries keys, so it's only ever put on the clipboard. */
const CODE_PREFIX = "openugc1:";
const toB64 = (text) => {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
};
const fromB64 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

async function copySettingsCode() {
  try {
    const exp = await invoke("export_settings");
    // Accounts come along (usernames, formats, the app each promotes); posts stay, since their files are local.
    const bundle = { ...exp, prefs: { writer: state.writer, filter: state.filter, accounts: state.accounts } };
    await navigator.clipboard.writeText(CODE_PREFIX + toB64(JSON.stringify(bundle)));
    toast("Settings code copied. It contains your keys, so keep it private.");
  } catch (e) {
    toast(`Couldn't copy the settings code: ${e}`, true);
  }
}

async function importSettingsCode() {
  const raw = $("#import-code").value.trim();
  if (!raw) return;
  let b;
  try {
    if (!raw.startsWith(CODE_PREFIX)) throw new Error();
    b = JSON.parse(fromB64(raw.slice(CODE_PREFIX.length)));
  } catch {
    return toast("That isn't a settings code. Copy it again from OpenUGC on your other computer.", true);
  }
  try {
    ui.settings = await invoke("save_settings", {
      settings: b.settings || {},
      r2Secret: b.r2Secret || null,
      metricsToken: b.metricsToken || null,
    });
    const prefs = b.prefs || {};
    if (prefs.writer) state.writer = prefs.writer;
    if (prefs.filter) state.filter = { ...state.filter, ...prefs.filter };
    for (const a of prefs.accounts || []) {
      const i = state.accounts.findIndex((x) => x.id === a.id);
      if (i === -1) state.accounts.push(a);
      else {
        // Keep saved hooks from both computers.
        const mine = state.accounts[i].savedHooks || [];
        const theirs = a.savedHooks || [];
        const savedHooks = [...theirs, ...mine]
          .filter((h, k, all) => all.findIndex((x) => hookKey(ideaText(x)) === hookKey(ideaText(h))) === k)
          .sort((x, y) => (y.savedAt || 0) - (x.savedAt || 0));
        state.accounts[i] = { ...state.accounts[i], ...a, savedHooks };
      }
    }
    // Codes from before accounts existed carry a single app.
    if (prefs.myApp) for (const a of state.accounts) if (!a.myApp) Object.assign(a, { myApp: prefs.myApp, myAppSlot: prefs.myAppSlot || 3 });
    for (const a of state.accounts) {
    delete a.channelId;
    delete a.channelName;
  }
    $("#import-code").value = "";
    document.querySelectorAll("[data-f]").forEach((input) => (input.value = state.filter[input.dataset.f]));
    save();
    renderSettings();
    renderAll();
    syncProfiles();
    toast("Settings imported");
  } catch (e) {
    toast(`Couldn't import the settings: ${e}`, true);
  }
}

function bindSettings() {
  $("#settings-form").addEventListener("submit", (e) => {
    e.preventDefault();
    saveSettings();
  });
  const cr = $("#check-r2");
  cr.addEventListener("click", () =>
    runCheck(cr, "Check R2", async () => `R2 works. Uploaded a test file and loaded it from ${await invoke("check_r2")}`),
  );
  const cm = $("#check-metrics");
  cm.addEventListener("click", () =>
    runCheck(cm, "Check analytics", async () => {
      await syncNow();
      const st = await api("GET", "/status");
      return `Analytics works. The Worker is tracking ${st.profiles} account${st.profiles === 1 ? "" : "s"} and ${fmtCount(st.videos)} post${st.videos === 1 ? "" : "s"}.`;
    }),
  );
  $("#copy-settings").addEventListener("click", copySettingsCode);
  $("#import-settings").addEventListener("click", importSettingsCode);
}

/* ---------- wiring ---------- */
function renderWriter() {
  document.querySelectorAll("[data-writer]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.writer === state.writer)));
  document.querySelectorAll("[data-artist]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.artist === state.artist)));
}

function renderAll() {
  renderRail();
  renderWriter();
  renderMine();
  renderSlides();
  renderResults();
  renderTray();
  renderPrepared();
  renderWrite();
  if (ui.view === "board") renderBoard();
  renderAnalytics();
}

function bind() {
  document.querySelectorAll(".nav-item[data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  $("#search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    search();
  });
  $("#suggest-btn").addEventListener("click", suggest);
  $("#add-links").addEventListener("click", addByLinks);
  document.querySelectorAll("[data-f]").forEach((input) => {
    const key = input.dataset.f;
    input.value = state.filter[key];
    input.addEventListener("change", () => {
      state.filter[key] = input.type === "number" ? Number(input.value) : input.value.trim().toLowerCase();
      save();
    });
  });
  $("#results").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pick]");
    if (b) togglePick(Number(b.dataset.pick));
  });
  bindSlotMenu();
  $("#prepare-btn").addEventListener("click", () => (isDrawn() ? drawAll() : prepareAll()));
  document.querySelectorAll("[data-artist]").forEach((b) =>
    b.addEventListener("click", () => {
      state.artist = b.dataset.artist;
      renderWriter();
      renderTray();
      renderWrite();
      save();
    }),
  );
  document.querySelectorAll("[data-writer]").forEach((b) =>
    b.addEventListener("click", () => {
      state.writer = b.dataset.writer;
      renderWriter();
      renderResults();
      renderHookIdeas();
      save();
    }),
  );

  const prepared = $("#prepared");
  prepared.addEventListener("click", (e) => {
    const rw = e.target.closest("[data-rewrite]");
    if (rw) return rewrite(Number(rw.dataset.rewrite));
    const rm = e.target.closest("[data-remove]");
    if (rm) togglePick(Number(rm.dataset.remove));
  });
  prepared.addEventListener("input", (e) => {
    const id = Number(e.target.dataset.overview);
    if (!id) return;
    const p = preparedFor(id);
    p.overview = e.target.value;
    const counter = prepared.querySelector(`[data-count="${id}"]`);
    counter.textContent = `${p.overview.length} / ${OVERVIEW_LIMIT}`;
    counter.classList.toggle("is-over", p.overview.length > OVERVIEW_LIMIT);
    save();
  });
}

/** Turns the single-slideshow layout from before accounts into one account with one post. */
function migrate(saved) {
  if (!saved || saved.version >= 2) return saved;
  const s = { ...saved, version: 2, accounts: [], posts: [], currentPostId: null };
  const hasWork = (saved.picked || []).length || saved.lastSlides || saved.myApp || (saved.posts || []).length;
  if (hasWork) {
    const accountId = uid();
    s.accounts.push({
      id: accountId,
      username: "",
      myApp: saved.myApp || null,
      myAppSlot: saved.myAppSlot || 3,
      createdAt: Date.now(),
    });
    const old = (saved.posts || []).at(-1);
    const postId = uid();
    s.posts.push({
      id: postId,
      accountId,
      name: "Post 1",
      createdAt: Date.now(),
      niche: saved.niche || "",
      picked: saved.picked || [],
      slideOptions: { ...DEFAULT_SLIDE_OPTIONS, ...(saved.slideOptions || {}) },
      slides: saved.lastSlides || null,
      caption: { title: "", caption: "", hashtags: [], ...(saved.post || {}) },
      buffer: old ? { id: old.id, status: old.status, dueAt: old.dueAt, channelId: old.channelId, imageUrls: old.imageUrls } : null,
    });
    s.currentPostId = postId;
  }
  s.resultsNiche = saved.niche || "";
  for (const k of ["niche", "picked", "slideOptions", "lastSlides", "myApp", "myAppSlot", "post", "channelId"]) delete s[k];
  return s;
}

async function init() {
  try {
    const saved = migrate(await invoke("load_state"));
    if (saved) Object.assign(state, saved, { filter: { ...state.filter, ...(saved.filter || {}) } });
    stateLoaded = true;
  } catch (e) {
    toast(`Couldn't load saved work: ${e}`, true);
  }
  for (const p of state.posts) {
    p.slideOptions = { ...DEFAULT_SLIDE_OPTIONS, ...(p.slideOptions || {}) };
    p.caption = { title: "", caption: "", hashtags: [], ...(p.caption || {}) };
    p.picked = p.picked || [];
    // Buffer is gone: keep when a post went out (and its TikTok link) for analytics, drop the rest.
    if (p.buffer) {
      if (p.buffer.status === "sent" && !p.posted) p.posted = { at: Date.parse(p.buffer.sentAt || p.buffer.dueAt) || Date.now(), link: p.buffer.externalLink || undefined };
      delete p.buffer;
    }
    p.phone = p.phone || null;
    p.posted = p.posted || null;
    if (p.format === "drawn") {
      const d = p.drawn || {};
      p.drawn = {
        topic: d.topic || "",
        points: d.points || DEFAULT_POINTS,
        accent: d.accent || "",
        slides: (d.slides || []).map((s) => ({ ...newDrawnSlide(s), id: s.id || uid() })),
        plug: d.plug ? { ...newDrawnSlide(d.plug), id: d.plug.id || uid() } : null,
        style: { ...DEFAULT_DRAWN_STYLE, ...(d.style || {}) },
      };
    }
    if (p.format === "spotlight") {
      const s = p.spotlight || {};
      p.spotlight = {
        ...newSpotlight(s),
        hook: s.hook || "",
        accent: s.accent || "",
        cta: s.cta || "",
        lines: (s.lines || []).map(newSpotLine),
        desk: s.desk || null,
      };
    }
  }
  for (const a of state.accounts) {
    delete a.channelId;
    delete a.channelName;
  }
  if (!WRITER_NAMES[state.artist]) state.artist = "codex";
  if (!post()) state.currentPostId = null;
  try {
    ui.settings = await invoke("get_settings");
  } catch (e) {
    toast(`Couldn't load settings: ${e}`, true);
  }
  bind();
  bindBoard();
  bindSlides();
  bindWrite();
  bindSpot();
  bindMine();
  bindPost();
  bindSettings();
  bindAnalytics();
  renderSlideSettings();
  renderAll();
  setView("board");
  // Nudge an account carried over from before accounts existed to get a username.
  const unnamed = state.accounts.find((a) => !a.username);
  if (unnamed) startAccountForm(unnamed.id);
  syncProfiles();
  save();
}

init();
