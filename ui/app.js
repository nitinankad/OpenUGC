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

/*
 * Saved state. Accounts are TikTok usernames; each post belongs to one account and holds
 * everything for one slideshow. Prepared apps are a shared cache so a gem used in two posts
 * is only downloaded once.
 */
const state = {
  version: 2,
  writer: "claude",
  filter: { country: "us", minRating: 4.5, minRatings: 30, maxRatings: 5000, maxDaysSinceUpdate: 365 },
  /** Latest search results, shared by all posts. */
  results: [],
  resultsNiche: "",
  /** Shown above the results, e.g. which suggestions weren't on the App Store. */
  resultsNote: "",
  prepared: [],
  /** { id, username, channelId, channelName, myApp, myAppSlot, createdAt } */
  accounts: [],
  /** { id, accountId, name, createdAt, niche, picked, slideOptions, slides, caption, buffer } */
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
  justAdded: null,
  mine: { editing: false, searching: false, results: [] },
  settings: null,
  post: { writing: false, scheduling: false, refreshing: false, channels: null, loadingChannels: false },
  /** Account form open on the board: null, "new", or an account id. */
  editingAccount: null,
  /** Delete button waiting for a second click, e.g. "post:<id>". */
  confirm: null,
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
const myApp = () => acct()?.myApp || null;
const mySlot = () => acct()?.myAppSlot || 3;
const isPicked = (id) => picked().some((a) => a.trackId === id);
const preparedFor = (id) => state.prepared.find((p) => p.app.trackId === id);
const isMine = (id) => myApp()?.trackId === id;
/** How many gems fit next to the account's own app. */
const gemCapacity = () => MAX_APPS - (myApp() ? 1 : 0);

/** Every app in a post, in slide order: the gems with the account's app at its chosen position. */
function lineupFor(p) {
  if (!p) return [];
  const a = accountOf(p);
  const apps = [...p.picked];
  if (a?.myApp) apps.splice(Math.min((a.myAppSlot || 3) - 1, apps.length), 0, a.myApp);
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
const POST_VIEWS = ["find", "prepare", "slides"];

function setView(view) {
  if (POST_VIEWS.includes(view) && !post()) view = "board";
  ui.view = view;
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("is-active", b.dataset.view === view));
  for (const v of ["board", ...POST_VIEWS, "analytics", "settings"]) $(`#view-${v}`).hidden = v !== view;
  // The hook preview has nothing to do with analytics, so its charts get the room.
  $(".shell").classList.toggle("no-tray", view === "analytics");
  if (view === "board") renderBoard();
  if (view === "analytics") loadAnalytics();
  else clearTimeout(pollTimer);
  if (view === "slides") renderSlides();
  if (view === "settings") renderSettings();
  if (view === "find") {
    $("#niche").value = post()?.niche || "";
    renderHookIdeas();
  }
}

function renderRail() {
  const p = post();
  $("#rail-post").hidden = !p;
  document.querySelectorAll(".nav-step").forEach((b) => (b.disabled = !p));
  if (!p) return;
  $("#rail-account").textContent = handle(acct());
  const name = $("#post-name");
  if (document.activeElement !== name) name.value = p.name;
  $("#nav-prepared").textContent = slideApps().length || "";
}

/* ---------- Posts board ---------- */
function postStatus(p) {
  if (p.buffer) {
    const s = p.buffer.status || "scheduled";
    const label = { scheduled: "Reminder set", sent: "Posted", sending: "Sending", error: "Error", draft: "Draft in Buffer", needs_approval: "Needs approval" }[s] || s;
    return { cls: `status-${s}`, label, detail: fmtWhen(p.buffer.dueAt) };
  }
  if (p.slides) return { cls: "status-ready", label: "Slides ready", detail: "" };
  const n = lineupFor(p).length;
  return { cls: "", label: "Draft", detail: n ? `${n} of ${MAX_APPS} apps` : "No apps yet" };
}

function accountForm(a) {
  const id = a ? a.id : "new";
  const chans = ui.post.channels || [];
  const channelField = bufferReady()
    ? `<label class="field">Buffer account
        <select name="channel" ${ui.post.loadingChannels ? "disabled" : ""}>
          <option value="">${ui.post.loadingChannels ? "Loading accounts" : "Not linked"}</option>
          ${chans
            .map((c) => `<option value="${esc(c.id)}" ${a?.channelId === c.id ? "selected" : ""}>${esc(channelLabel(c))}</option>`)
            .join("")}
        </select>
      </label>`
    : `<p class="hint">Add your Buffer key in Settings to link this account to Buffer.</p>`;
  return `<form class="acct-form" data-acct-form="${id}" autocomplete="off">
    <label class="field">TikTok username <input name="username" type="text" spellcheck="false" placeholder="@yourhandle" value="${esc(a ? handle(a).replace("Unnamed account", "") : "")}" /></label>
    ${channelField}
    <div class="inline">
      <button type="submit" class="btn btn-primary btn-sm">${a ? "Save" : "Add account"}</button>
      <button type="button" class="btn btn-quiet" data-acct-cancel>Cancel</button>
    </div>
  </form>`;
}

function postCard(p) {
  const st = postStatus(p);
  const lu = lineupFor(p);
  const thumb = p.slides?.slides?.[0]
    ? `<img class="card-slide" src="${esc(fileSrc(p.slides.slides[0]))}?v=${p.slides.renderedAt || 0}" alt="" />`
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
  const hasScheduled = state.posts.some((p) => p.buffer && p.buffer.status !== "sent");
  $("#refresh-posts").hidden = !hasScheduled;
  $("#refresh-posts").disabled = ui.post.refreshing;
  $("#refresh-posts").textContent = ui.post.refreshing ? "Refreshing" : "Refresh status";
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
              <p class="acct-sub">${a.channelId ? `Buffer: ${esc(a.channelName || "linked")}` : "Not linked to Buffer"}${a.myApp ? `. Promotes ${esc(a.myApp.trackName)}` : ""}</p>
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
  const prev = postsOf(a).at(-1);
  // Carry the account's look over from its latest post, and bump the part number.
  const slideOptions = prev ? { ...prev.slideOptions } : { ...DEFAULT_SLIDE_OPTIONS };
  if (prev && Number(slideOptions.part) > 0) slideOptions.part = Number(slideOptions.part) + 1;
  const p = {
    id: uid(),
    accountId,
    name: `Post ${postsOf(a).length + 1}`,
    createdAt: Date.now(),
    niche: prev?.niche || "",
    picked: [],
    slideOptions,
    slides: null,
    caption: { title: "", caption: "", hashtags: [] },
    buffer: null,
  };
  state.posts.push(p);
  openPost(p.id, "find");
  save();
}

function openPost(id, view) {
  const p = state.posts.find((x) => x.id === id);
  if (!p) return;
  state.currentPostId = id;
  ui.mine = { editing: false, searching: false, results: [] };
  $("#post-when").value = "";
  renderSlideSettings();
  renderAll();
  setView(view || (p.slides ? "slides" : lineupFor(p).length ? "prepare" : "find"));
  save();
}

function saveAccountForm(form) {
  const id = form.dataset.acctForm;
  const username = cleanUsername(form.username.value);
  if (!username) return toast("Enter the TikTok username for this account.", true);
  let channelId = form.channel ? form.channel.value : undefined;
  const chans = ui.post.channels || [];
  // Link the Buffer account with the same name if none was picked.
  if (form.channel && !channelId) channelId = chans.find((c) => (c.name || "").toLowerCase() === username.toLowerCase())?.id || "";
  const ch = chans.find((c) => c.id === channelId);
  if (id === "new") {
    const first = state.accounts[0];
    state.accounts.push({
      id: uid(),
      username,
      channelId: channelId || "",
      channelName: ch ? ch.displayName || ch.name : "",
      // New accounts start out promoting the same app as the first one; change it per account.
      myApp: first?.myApp || null,
      myAppSlot: first?.myAppSlot || 3,
      createdAt: Date.now(),
    });
  } else {
    const a = state.accounts.find((x) => x.id === id);
    if (!a) return;
    a.username = username;
    if (channelId !== undefined) {
      a.channelId = channelId;
      a.channelName = ch ? ch.displayName || ch.name : "";
    }
  }
  ui.editingAccount = null;
  renderAll();
  save();
  syncProfiles();
}

function startAccountForm(id) {
  ui.editingAccount = id;
  if (bufferReady() && ui.post.channels === null && !ui.post.loadingChannels) loadChannels();
  renderBoard();
  $(`[data-acct-form="${id}"] input[name="username"]`)?.focus();
}

function bindBoard() {
  $("#add-account").addEventListener("click", () => startAccountForm("new"));
  $("#refresh-posts").addEventListener("click", refreshPosts);
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
const isMade = (p) => !!(p.slides || p.buffer);
/** When a post goes (or went) out: its Buffer time, else when its slides were made, else when it was created. */
const postTime = (p) => (p.buffer?.dueAt ? Date.parse(p.buffer.dueAt) : p.slides?.renderedAt || p.createdAt);
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
    .filter((q) => q.id !== p?.id && isMade(q) && hookKey(hookText(q.slideOptions)) === key)
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
    if (skipped.length) parts.push(`${skipped.length} didn't fit (six apps max), so they're in the list to swap in`);
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

/* ---------- Tray ---------- */
function renderTray() {
  const p = post();
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
        <button ${own ? `data-mine` : `data-unpick="${a.trackId}"`} title="${own ? "Your app. Change it below." : `Remove ${esc(a.trackName)}`}">
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
  document.querySelectorAll("#home-grid [data-unpick]").forEach((b) => {
    b.parentElement.classList.toggle("is-repeat", recent.some((r) => String(r.a.trackId) === b.dataset.unpick));
  });

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
}

function renderSlides() {
  const p = post();
  const apps = slideApps();
  $("#slides-lede").textContent = apps.length
    ? `Uses this post's ${apps.length} prepared app${apps.length > 1 ? "s" : ""}, in the order shown on the phone. Slides are 2160 × 2700 JPEGs.`
    : "Prepare this post's apps first. Slides use the apps on the phone, in that order.";
  const btn = $("#make-slides");
  btn.disabled = ui.rendering || !apps.length;
  btn.textContent = ui.rendering ? "Making slides" : p?.slides ? "Make slides again" : "Make slides";

  const last = p?.slides;
  $("#show-folder").hidden = !last;
  $("#slides-empty").hidden = !!last;
  $("#thumbs").innerHTML = last
    ? last.slides
        .map((s, i) => {
          const label = i === 0 ? "Hook" : i === last.slides.length - 1 ? "Last slide" : `App ${i}`;
          return `<li><figure><img src="${esc(fileSrc(s))}?v=${last.renderedAt}" alt="${label}" /><figcaption>${i + 1}. ${label}</figcaption></figure></li>`;
        })
        .join("")
    : "";
  renderHookIdeas();
  renderPost();
}

/* ---------- Hook ideas ---------- */
const hookText = (o) => [o.hookAccent, o.hookLine2, o.hookLine3].map((x) => String(x || "").trim()).filter(Boolean).join(" ");
const ideaText = (h) => [h.accent, h.line2, h.line3].map((x) => String(x || "").trim()).filter(Boolean).join(" ");

/** Hook ideas appear in Find apps (to start a post from a hook) and in Slides; both stay in sync. */
function renderHookIdeas() {
  const p = post();
  const o = opts();
  const writer = WRITER_NAMES[state.writer];
  const has = !!p?.hookIdeas?.length;
  document.querySelectorAll("[data-hook-suggest]").forEach((btn) => {
    btn.disabled = !p || ui.hooking;
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
  $("#find-hook-text").innerHTML = p
    ? `This post's hook: <b style="color:${esc(o.accent)}">${esc(o.hookAccent)}</b> ${rest}. Pick a new one, then Ask ${esc(writer)} for apps that fit it.`
    : "";
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
  for (const q of a ? postsOf(a) : []) if (q.id !== p.id && q.slides) used.add(hookText(q.slideOptions));
  for (const h of p.hookIdeas || []) used.add(ideaText(h));
  for (const t of p.seenHooks || []) used.add(t);
  for (const h of a?.savedHooks || []) used.add(ideaText(h));
  return [...used].filter(Boolean);
}

async function suggestHooks() {
  const p = post();
  if (!p || ui.hooking) return;
  ui.hooking = true;
  renderHookIdeas();
  try {
    const ideas = await invoke("suggest_hooks", {
      niche: p.niche || "",
      ownApp: accountOf(p)?.myApp || null,
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
  const apps = slideApps();
  if (!p || !apps.length || ui.rendering) return;
  ui.rendering = true;
  renderSlides();
  try {
    const out = await invoke("render_slides", { apps, options: p.slideOptions });
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
  document.addEventListener("click", (e) => {
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
  $("#mine-slot").addEventListener("change", (e) => {
    const a = acct();
    if (!a) return;
    a.myAppSlot = Number(e.target.value);
    renderAll();
    save();
  });
}

/* ---------- Caption + Buffer ---------- */
const hookTitle = () => {
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
const bufferReady = () => {
  const s = ui.settings;
  return !!(s && s.hasBufferKey && s.hasR2Secret && s.r2AccountId && s.r2AccessKeyId && s.r2Bucket && s.r2PublicUrl);
};
const channelLabel = (c) => `${c.displayName || c.name} (${c.service})${c.isDisconnected ? ", disconnected" : ""}`;

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
  write.disabled = ui.post.writing || !slideApps().length;
  write.textContent = ui.post.writing ? `${WRITER_NAMES[state.writer]} is writing` : c.caption ? "Rewrite caption" : "Write caption";
  $("#copy-caption").disabled = !postText();

  // Already scheduled: show where it stands instead of the form, so it isn't sent to Buffer twice.
  const sched = p.buffer;
  $("#post-scheduled").hidden = !sched;
  if (sched) {
    const st = postStatus(p);
    $("#post-scheduled-text").innerHTML = `<span class="status ${st.cls}">${esc(st.label)}</span> Reminder for ${esc(fmtWhen(sched.dueAt))} on ${esc(handle(acct()))}.`;
  }

  const ready = bufferReady();
  $("#schedule-form").hidden = !ready || !!sched;
  $("#schedule-needs").hidden = ready || !!sched;
  if (!ready || sched) return;
  if (ui.post.channels === null && !ui.post.loadingChannels) loadChannels();

  const a = acct();
  const sel = $("#post-channel");
  const chans = ui.post.channels || [];
  if (a && !a.channelId && chans.length) {
    // Suggest the Buffer account whose name matches the username.
    const match = chans.find((ch) => (ch.name || "").toLowerCase() === a.username.toLowerCase());
    if (match) Object.assign(a, { channelId: match.id, channelName: match.displayName || match.name });
  }
  sel.innerHTML = ui.post.loadingChannels
    ? `<option>Loading accounts</option>`
    : `<option value="">Choose the Buffer account</option>` +
      chans.map((ch) => `<option value="${esc(ch.id)}" ${ch.id === a?.channelId ? "selected" : ""}>${esc(channelLabel(ch))}</option>`).join("");
  sel.disabled = ui.post.loadingChannels || !chans.length;
  $("#load-channels").disabled = ui.post.loadingChannels;
  $("#channel-hint").textContent = chans.length || ui.post.loadingChannels ? `Saved for ${handle(a)}, so later posts use it too.` : "No accounts found in Buffer. Connect TikTok there first.";

  const btn = $("#schedule-btn");
  btn.disabled = ui.post.scheduling || !a?.channelId || !$("#post-when").value;
  btn.textContent = ui.post.scheduling ? "Uploading slides and scheduling" : "Schedule reminder";
}

async function writeCaption() {
  const p = post();
  const apps = slideApps();
  if (!p || !apps.length || ui.post.writing) return;
  ui.post.writing = true;
  renderPost();
  try {
    const c = await invoke("generate_caption", { niche: p.niche, apps, writer: state.writer });
    p.caption.caption = c.caption;
    p.caption.hashtags = c.hashtags;
    save();
  } catch (e) {
    toast(`Couldn't write the caption: ${e}`, true);
  } finally {
    ui.post.writing = false;
    renderPost();
  }
}

async function loadChannels() {
  ui.post.loadingChannels = true;
  renderPost();
  if (ui.view === "board") renderBoard();
  try {
    const list = await invoke("buffer_channels");
    // TikTok accounts first.
    ui.post.channels = list.sort((a, b) => (b.service === "tiktok") - (a.service === "tiktok"));
  } catch (e) {
    ui.post.channels = [];
    toast(`Couldn't load your Buffer accounts: ${e}`, true);
  } finally {
    ui.post.loadingChannels = false;
    renderPost();
    if (ui.view === "board") renderBoard();
  }
}

async function schedulePost() {
  const p = post();
  const a = acct();
  const when = $("#post-when").value;
  if (!p?.slides || !a?.channelId || !when || ui.post.scheduling) return;
  const due = new Date(when);
  if (!(due > new Date())) return toast("Pick a reminder time in the future.", true);
  if (p.caption.hashtags.length > MAX_HASHTAGS) return toast(`TikTok allows ${MAX_HASHTAGS} hashtags. Remove a few first.`, true);
  ui.post.scheduling = true;
  renderPost();
  try {
    const out = await invoke("schedule_post", {
      slides: p.slides.slides,
      channelId: a.channelId,
      caption: { caption: p.caption.caption, hashtags: p.caption.hashtags },
      title: p.caption.title.trim() || hookTitle(),
      dueAt: due.toISOString(),
    });
    p.buffer = {
      id: out.post.id,
      status: out.post.status || "scheduled",
      dueAt: out.post.dueAt || due.toISOString(),
      channelId: a.channelId,
      imageUrls: out.imageUrls,
    };
    save();
    toast(`Scheduled a reminder for ${fmtWhen(p.buffer.dueAt)} on ${handle(a)}`);
  } catch (e) {
    toast(`Couldn't schedule on Buffer: ${e}`, true);
  } finally {
    ui.post.scheduling = false;
    renderAll();
  }
}

async function refreshPosts() {
  if (ui.post.refreshing) return;
  ui.post.refreshing = true;
  renderBoard();
  let failed = 0;
  for (const p of state.posts.filter((p) => p.buffer && p.buffer.status !== "sent")) {
    try {
      const fresh = await invoke("refresh_post", { id: p.buffer.id });
      Object.assign(p.buffer, { status: fresh.status, dueAt: fresh.dueAt || p.buffer.dueAt, sentAt: fresh.sentAt, externalLink: fresh.externalLink || p.buffer.externalLink });
    } catch {
      failed++;
    }
  }
  ui.post.refreshing = false;
  save();
  renderAll();
  if (failed) toast(`Couldn't refresh ${failed} post${failed > 1 ? "s" : ""}. Check your Buffer key in Settings.`, true);
}

function bindPost() {
  const edit = (fn) => (e) => {
    const p = post();
    if (!p) return;
    fn(p, e.target.value);
    save();
  };
  $("#post-title").addEventListener("input", edit((p, v) => (p.caption.title = v)));
  $("#post-caption").addEventListener("input", edit((p, v) => {
    p.caption.caption = v;
    $("#copy-caption").disabled = !postText();
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
  $("#post-channel").addEventListener("change", (e) => {
    const a = acct();
    if (!a) return;
    const ch = (ui.post.channels || []).find((c) => c.id === e.target.value);
    a.channelId = e.target.value;
    a.channelName = ch ? ch.displayName || ch.name : "";
    renderPost();
    save();
  });
  $("#post-when").addEventListener("input", renderPost);
  $("#load-channels").addEventListener("click", loadChannels);
  $("#schedule-btn").addEventListener("click", schedulePost);
  $("#refresh-post").addEventListener("click", refreshPosts);
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
    hook: hookText(p.slideOptions),
    apps: lineupFor(p).map((x) => x.trackName),
    myApp: a?.myApp?.trackName || null,
    myAppSlot: a?.myApp ? a.myAppSlot || 3 : null,
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
 * Links scheduled posts to the TikTok posts they became. Buffer's link to the published post is
 * used when it has one; otherwise the TikTok post closest to the reminder time, if its caption
 * matches or it went out within 12 hours. Posts you unlinked by hand are left alone.
 */
async function autoLink(a, videos) {
  const taken = new Set(videos.filter((v) => v.link).map((v) => v.link.postId));
  const free = () => videos.filter((v) => !v.link);
  const candidates = postsOf(a).filter((p) => p.buffer && !p.noAutoLink && !taken.has(p.id));
  const links = [];
  const claim = (p, v) => {
    links.push(linkFor(p, v.id, "auto"));
    v.link = { postId: p.id, postName: p.name, linkedBy: "auto" };
    taken.add(p.id);
  };
  for (const p of candidates) {
    const id = videoIdFromUrl(p.buffer.externalLink);
    const v = id && free().find((x) => x.id === id);
    if (v) claim(p, v);
  }
  const pairs = [];
  for (const p of candidates.filter((p) => !taken.has(p.id))) {
    const due = Date.parse(p.buffer.sentAt || p.buffer.dueAt);
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
              ${posts.map((p) => `<option value="${esc(p.id)}" ${link?.id === p.id ? "selected" : ""}>${esc(p.name)}${p.buffer?.dueAt ? `, ${esc(fmtDay(Date.parse(p.buffer.dueAt)))}` : ""}</option>`).join("")}
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
  $("#set-buffer-key").placeholder = s.hasBufferKey ? SAVED_HINT : "";
  $("#set-r2-secret").placeholder = s.hasR2Secret ? SAVED_HINT : "";
  $("#set-metrics-token").placeholder = s.hasMetricsToken ? SAVED_HINT : "";
}

async function saveSettings({ quiet = false } = {}) {
  const settings = {};
  document.querySelectorAll("[data-s]").forEach((el) => (settings[el.dataset.s] = el.value.trim()));
  const bufferKey = $("#set-buffer-key").value.trim() || null;
  const r2Secret = $("#set-r2-secret").value.trim() || null;
  const metricsToken = $("#set-metrics-token").value.trim() || null;
  try {
    ui.settings = await invoke("save_settings", { settings, bufferKey, r2Secret, metricsToken });
    $("#set-buffer-key").value = "";
    $("#set-r2-secret").value = "";
    $("#set-metrics-token").value = "";
    syncProfiles();
    if (bufferKey) ui.post.channels = null;
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
    // Accounts come along (usernames, Buffer links, the app each promotes); posts stay, since their files are local.
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
      bufferKey: b.bufferKey || null,
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
    ui.post.channels = null;
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
  const cb = $("#check-buffer");
  cb.addEventListener("click", () =>
    runCheck(cb, "Check Buffer", async () => {
      const list = await invoke("buffer_channels");
      ui.post.channels = list.sort((a, b) => (b.service === "tiktok") - (a.service === "tiktok"));
      const tiktok = list.filter((c) => c.service === "tiktok").length;
      return `Buffer works. Found ${list.length} account${list.length === 1 ? "" : "s"}, ${tiktok} on TikTok.`;
    }),
  );
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
}

function renderAll() {
  renderRail();
  renderWriter();
  renderMine();
  renderSlides();
  renderResults();
  renderTray();
  renderPrepared();
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
  $("#home-grid").addEventListener("click", (e) => {
    const b = e.target.closest("[data-unpick]");
    if (b) togglePick(Number(b.dataset.unpick));
  });
  $("#prepare-btn").addEventListener("click", prepareAll);
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
      channelId: saved.channelId || "",
      channelName: "",
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
  }
  if (!post()) state.currentPostId = null;
  try {
    ui.settings = await invoke("get_settings");
  } catch (e) {
    toast(`Couldn't load settings: ${e}`, true);
  }
  bind();
  bindBoard();
  bindSlides();
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
