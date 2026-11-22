// Light/dark theme. Loaded before the stylesheet so the app never flashes the wrong theme.
// The choice is kept in this window's localStorage; until one is made, the system theme is used.
(function () {
  const KEY = "openugc-theme";
  const saved = () => {
    try { return localStorage.getItem(KEY); } catch { return null; }
  };
  const system = () => (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

  function apply(theme) {
    document.documentElement.dataset.theme = theme;
    // Match the native title bar too (needs core:window:allow-set-theme).
    try { window.__TAURI__?.window?.getCurrentWindow().setTheme(theme).catch(() => {}); } catch {}
    const btn = document.getElementById("theme-toggle");
    if (btn) {
      const next = theme === "dark" ? "light" : "dark";
      btn.querySelector(".theme-label").textContent = theme === "dark" ? "Light mode" : "Dark mode";
      btn.setAttribute("aria-label", `Switch to ${next} mode`);
    }
  }

  apply(saved() || system());

  // Follow the system until the person picks a theme themselves.
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (!saved()) apply(system());
  });

  document.addEventListener("DOMContentLoaded", () => {
    apply(document.documentElement.dataset.theme);
    document.getElementById("theme-toggle")?.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      try { localStorage.setItem(KEY, next); } catch {}
      apply(next);
    });
  });
})();
