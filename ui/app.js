const { invoke, convertFileSrc } = window.__TAURI__.core;

const MAX_APPS = 6;
const OVERVIEW_LIMIT = 140;
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

const state = {
  niche: "",
  writer: "claude",
  filter: { country: "us", minRating: 4.5, minRatings: 30, maxRatings: 5000, maxDaysSinceUpdate: 365 },
  results: [],
  picked: [],
  prepared: [],
  slideOptions: { ...DEFAULT_SLIDE_OPTIONS },
  lastSlides: null,
  /** The app being marketed; goes into every slideshow. */
  myApp: null,
  /** Its position among the app slides, 1 to MAX_APPS. */
  myAppSlot: 3,
};
const ui = {
  view: "find", searching: false, rendering: false, busy: new Set(), justAdded: null,
  mine: { editing: false, searching: false, results: [] },
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fileSrc = (p) => (p ? convertFileSrc(p) : "");
const fmtCount = (n) => new Intl.NumberFormat().format(n);
const fmtMonth = (iso) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", year: "numeric" }) : "Unknown";
const mixHex = (a, b, t) => {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(",")})`;
};
const isPicked = (id) => state.picked.some((a) => a.trackId === id);
const preparedFor = (id) => state.prepared.find((p) => p.app.trackId === id);
const isMine = (id) => state.myApp?.trackId === id;
/** How many gems fit next to your app. */
const gemCapacity = () => MAX_APPS - (state.myApp ? 1 : 0);
/** Every app in the slideshow, in slide order: the gems with your app at its chosen position. */
function lineup() {
  const apps = [...state.picked];
  if (state.myApp) apps.splice(Math.min(state.myAppSlot - 1, apps.length), 0, state.myApp);
  return apps;
}

/* ---------- persistence ---------- */
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    invoke("save_state", { state }).catch((e) => toast(`Couldn't save your work: ${e}`, true));
  }, 400);
}

/* ---------- toast ---------- */
let toastTimer;
function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("is-error", isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 7000 : 3000);
}

/* ---------- navigation ---------- */
function setView(view) {
  ui.view = view;
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("is-active", b.dataset.view === view));
  $("#view-find").hidden = view !== "find";
  $("#view-prepare").hidden = view !== "prepare";
  $("#view-slides").hidden = view !== "slides";
  if (view === "slides") renderSlides();
}

/* ---------- Find ---------- */
function renderResults() {
  const list = $("#results");
  const hasResults = state.results.length > 0;
  $("#results-head").hidden = !hasResults;
  $("#find-empty").hidden = hasResults || ui.searching;
  $("#search-btn").disabled = ui.searching;
  $("#search-btn").textContent = ui.searching ? "Searching" : "Search";

  if (ui.searching) {
    list.innerHTML = `<li class="loading-row"><span class="spinner"></span>Searching the App Store for "${esc(state.niche)}"</li>`;
    return;
  }
  const full = state.picked.length >= gemCapacity();
  list.innerHTML = state.results
    .map((a) => {
      const on = isPicked(a.trackId);
      const mine = isMine(a.trackId);
      const icon = a.artworkUrl100 || a.artworkUrl512 || "";
      return `<li class="row ${on ? "is-picked" : ""}">
        <div class="ident">
          <img class="icon" src="${esc(icon)}" alt="" loading="lazy" />
          <div class="ident-text">
            <span class="name" title="${esc(a.trackName)}">${esc(a.trackName)}</span>
            <span class="sub">${esc(a.artistName)}</span>
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
  state.niche = niche;
  ui.searching = true;
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

function togglePick(id) {
  if (isPicked(id)) {
    state.picked = state.picked.filter((a) => a.trackId !== id);
  } else if (state.picked.length < gemCapacity() && !isMine(id)) {
    const app = state.results.find((a) => a.trackId === id);
    if (!app) return;
    state.picked.push(app);
    ui.justAdded = id;
  }
  renderAll();
  ui.justAdded = null;
  save();
}

/* ---------- Tray ---------- */
function renderTray() {
  const apps = lineup();
  // On the phone, your app sits in its chosen slot even before the gems around it are added.
  const grid = Array(MAX_APPS).fill(null);
  if (state.myApp) grid[state.myAppSlot - 1] = state.myApp;
  let g = 0;
  for (let i = 0; i < MAX_APPS && g < state.picked.length; i++) if (!grid[i]) grid[i] = state.picked[g++];
  const slots = [];
  for (let i = 0; i < MAX_APPS; i++) {
    const a = grid[i];
    if (!a) {
      slots.push(`<li class="slot"><span class="slot-icon"></span><span class="slot-label">&nbsp;</span></li>`);
      continue;
    }
    const prepared = preparedFor(a.trackId);
    const src = prepared?.icon ? fileSrc(prepared.icon) : a.artworkUrl512 || a.artworkUrl100;
    const mine = isMine(a.trackId);
    slots.push(`<li class="slot is-filled ${ui.justAdded === a.trackId ? "is-new" : ""}">
      ${mine ? `<span class="slot-badge" title="Your app">You</span>` : ""}
      <button ${mine ? `data-mine` : `data-unpick="${a.trackId}"`} title="${mine ? "Your app. Change it below." : `Remove ${esc(a.trackName)}`}">
        <img class="slot-icon" src="${esc(src)}" alt="" />
        <span class="slot-label">${esc(a.trackName)}</span>
      </button>
    </li>`);
  }
  $("#home-grid").innerHTML = slots.join("");

  // Keep the preview in step with the chosen slide text and colours.
  const o = state.slideOptions;
  const hook = document.querySelector(".hook");
  hook.innerHTML = `<span style="color:${esc(o.accent)}">${esc(o.hookAccent)}</span> ${esc(o.hookLine2)} ${esc(o.hookLine3)}`;
  hook.style.color = o.text;
  document.querySelector(".screen").style.setProperty("--label", o.text);
  document.querySelector(".screen").style.background = `linear-gradient(180deg, ${mixHex(o.wallpaper, "#ffffff", 0.55)}, ${o.wallpaper} 45%, ${mixHex(o.wallpaper, "#000000", 0.35)})`;

  const n = apps.length;
  const todo = apps.filter((a) => !preparedFor(a.trackId) && !ui.busy.has(a.trackId)).length;
  const working = apps.filter((a) => ui.busy.has(a.trackId)).length;
  $("#tray-status").textContent =
    n === 0 ? "Add apps to fill the hook slide." : n < MAX_APPS ? `${n} of ${MAX_APPS} apps added` : "Hook slide is full";

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
  const busyPending = apps.filter((a) => ui.busy.has(a.trackId) && !preparedFor(a.trackId));
  $("#nav-prepared").textContent = state.prepared.length || "";
  $("#prepare-empty").hidden = state.prepared.length > 0 || busyPending.length > 0;

  const pending = busyPending.map(
    (a) => `<article class="prep is-busy">
      <img class="icon" src="${esc(a.artworkUrl100 || "")}" alt="" />
      <div>
        <div class="prep-top"><span class="prep-name">${esc(a.trackName)}</span></div>
        <div class="loading-row" style="padding:0"><span class="spinner"></span>Downloading screenshots and writing an overview with ${WRITER_NAMES[state.writer]}</div>
      </div>
    </article>`,
  );

  const order = (p) => {
    const i = apps.findIndex((a) => a.trackId === p.app.trackId);
    return i === -1 ? MAX_APPS : i;
  };
  const done = [...state.prepared].sort((x, y) => order(x) - order(y)).map((p) => {
    const a = p.app;
    const busy = ui.busy.has(a.trackId);
    const len = p.overview.length;
    return `<article class="prep" data-id="${a.trackId}">
      <img class="icon" src="${esc(fileSrc(p.icon))}" alt="" />
      <div>
        <div class="prep-top">
          <span class="prep-name">${esc(a.trackName)}</span>
          ${isMine(a.trackId) ? `<span class="prep-mine">Your app</span>` : ""}
          <span class="prep-meta"><span class="star">★</span>${a.averageUserRating.toFixed(1)} from ${fmtCount(a.userRatingCount)} ratings</span>
          <span class="prep-actions">
            <button class="btn btn-quiet" data-rewrite="${a.trackId}" ${busy ? "disabled" : ""}>${busy ? "Rewriting" : "Rewrite overview"}</button>
            <button class="btn btn-quiet" data-remove="${a.trackId}">Remove</button>
          </span>
        </div>
        <textarea class="overview" data-overview="${a.trackId}" ${busy ? "disabled" : ""}>${esc(p.overview)}</textarea>
        <div class="charcount ${len > OVERVIEW_LIMIT ? "is-over" : ""}" data-count="${a.trackId}">${len} / ${OVERVIEW_LIMIT}</div>
        <div class="shots">${p.screenshots.map((s) => `<img src="${esc(fileSrc(s))}" alt="" loading="lazy" />`).join("")}</div>
      </div>
    </article>`;
  });

  $("#prepared").innerHTML = pending.concat(done).join("");
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
/** Prepared apps in the order they sit on the phone; falls back to everything prepared. */
function slideApps() {
  const byPick = lineup().map((a) => preparedFor(a.trackId)).filter(Boolean);
  return byPick.length ? byPick : [...state.prepared];
}

const HEX = /^#[0-9a-f]{6}$/i;

function renderSlideSettings() {
  const o = state.slideOptions;
  document.querySelectorAll("[data-o]").forEach((el) => {
    if (document.activeElement !== el) el.value = o[el.dataset.o];
  });
  for (const key of Object.keys(DEFAULT_COLORS)) {
    document.querySelector(`[data-color="${key}"]`).value = o[key];
    const hex = document.querySelector(`[data-hex="${key}"]`);
    if (document.activeElement !== hex) hex.value = o[key];
  }
}

function renderSlides() {
  const apps = slideApps();
  $("#slides-lede").textContent = apps.length
    ? `Uses your ${apps.length} prepared app${apps.length > 1 ? "s" : ""}, in the order shown on the phone. Slides are 2160 × 2700 JPEGs.`
    : "Prepare some apps first. Slides use the apps on the phone, in that order.";
  const btn = $("#make-slides");
  btn.disabled = ui.rendering || !apps.length;
  btn.textContent = ui.rendering ? "Making slides" : state.lastSlides ? "Make slides again" : "Make slides";

  const last = state.lastSlides;
  $("#show-folder").hidden = !last;
  $("#slides-empty").hidden = !!last;
  $("#thumbs").innerHTML = last
    ? last.slides
        .map((p, i) => {
          const label = i === 0 ? "Hook" : i === last.slides.length - 1 ? "Last slide" : `App ${i}`;
          return `<li><figure><img src="${esc(fileSrc(p))}?v=${last.renderedAt}" alt="${label}" /><figcaption>${i + 1}. ${label}</figcaption></figure></li>`;
        })
        .join("")
    : "";
}

async function makeSlides() {
  const apps = slideApps();
  if (!apps.length || ui.rendering) return;
  ui.rendering = true;
  renderSlides();
  try {
    const out = await invoke("render_slides", { apps, options: state.slideOptions });
    state.lastSlides = { ...out, renderedAt: Date.now() };
    save();
    toast(`Made ${out.slides.length} slides`);
  } catch (e) {
    toast(`Couldn't make slides: ${e}`, true);
  } finally {
    ui.rendering = false;
    renderSlides();
  }
}

function bindSlides() {
  document.querySelectorAll("[data-o]").forEach((el) =>
    el.addEventListener("input", () => {
      state.slideOptions[el.dataset.o] = el.type === "number" ? Math.max(0, Number(el.value) || 0) : el.value;
      renderTray();
      save();
    }),
  );
  for (const key of Object.keys(DEFAULT_COLORS)) {
    const picker = document.querySelector(`[data-color="${key}"]`);
    const hex = document.querySelector(`[data-hex="${key}"]`);
    picker.addEventListener("input", () => {
      state.slideOptions[key] = picker.value;
      hex.value = picker.value;
      renderTray();
      save();
    });
    hex.addEventListener("input", () => {
      const v = hex.value.trim().startsWith("#") ? hex.value.trim() : `#${hex.value.trim()}`;
      if (!HEX.test(v)) return;
      state.slideOptions[key] = v.toLowerCase();
      picker.value = v;
      renderTray();
      save();
    });
    hex.addEventListener("blur", () => (hex.value = state.slideOptions[key]));
  }
  $("#reset-colors").addEventListener("click", () => {
    Object.assign(state.slideOptions, DEFAULT_COLORS);
    renderSlideSettings();
    renderTray();
    save();
  });
  $("#slide-settings").addEventListener("submit", (e) => e.preventDefault());
  $("#make-slides").addEventListener("click", makeSlides);
  $("#show-folder").addEventListener("click", () => {
    const first = state.lastSlides?.slides?.[0];
    if (first) window.__TAURI__.opener.revealItemInDir(first).catch((e) => toast(`Couldn't open the folder: ${e}`, true));
  });
}

/* ---------- Your app ---------- */
function renderMine() {
  const m = ui.mine;
  const a = state.myApp;
  const editing = !a || m.editing;
  $("#mine-set").hidden = editing;
  $("#mine-form").hidden = !editing;
  $("#mine-cancel").hidden = !a;
  $("#mine-find").disabled = m.searching;
  $("#mine-find").textContent = m.searching ? "Finding" : "Find";

  if (a) {
    const prepared = preparedFor(a.trackId);
    $("#mine-icon").src = prepared?.icon ? fileSrc(prepared.icon) : a.artworkUrl100 || a.artworkUrl512 || "";
    $("#mine-name").textContent = a.trackName;
    $("#mine-artist").textContent = a.artistName;
    const ord = ["1st", "2nd", "3rd", "4th", "5th", "6th"];
    $("#mine-slot").innerHTML = ord
      .slice(0, MAX_APPS)
      .map((o, i) => `<option value="${i + 1}" ${state.myAppSlot === i + 1 ? "selected" : ""}>${o}</option>`)
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
  state.myApp = app;
  state.picked = state.picked.filter((a) => a.trackId !== app.trackId);
  const dropped = state.picked.splice(gemCapacity());
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
    state.myAppSlot = Number(e.target.value);
    renderAll();
    save();
  });
}

/* ---------- wiring ---------- */
function renderWriter() {
  document.querySelectorAll("[data-writer]").forEach((b) =>
    b.setAttribute("aria-checked", String(b.dataset.writer === state.writer)),
  );
}

function renderAll() {
  renderWriter();
  renderMine();
  renderSlides();
  renderResults();
  renderTray();
  renderPrepared();
}

function bind() {
  document.querySelectorAll(".nav-item").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));

  $("#search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    search();
  });

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
      save();
    }),
  );

  const prepared = $("#prepared");
  prepared.addEventListener("click", (e) => {
    const rw = e.target.closest("[data-rewrite]");
    if (rw) return rewrite(Number(rw.dataset.rewrite));
    const rm = e.target.closest("[data-remove]");
    if (rm) {
      const id = Number(rm.dataset.remove);
      state.prepared = state.prepared.filter((p) => p.app.trackId !== id);
      renderAll();
      save();
    }
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

async function init() {
  try {
    const saved = await invoke("load_state");
    if (saved) Object.assign(state, saved, { filter: { ...state.filter, ...(saved.filter || {}) } });
  } catch (e) {
    toast(`Couldn't load saved work: ${e}`, true);
  }
  state.slideOptions = { ...DEFAULT_SLIDE_OPTIONS, ...(state.slideOptions || {}) };
  $("#niche").value = state.niche;
  bind();
  bindSlides();
  bindMine();
  renderSlideSettings();
  renderAll();
}

init();
