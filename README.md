# OpenUGC

Desktop app for finding hidden-gem iPhone apps and turning them into TikTok slideshows.
Built with [Tauri 2](https://tauri.app): a Rust backend with an HTML/CSS/JS front end. Runs on Windows and macOS.

## Requirements

- Rust (stable) and Node.js 20+
- [Claude Code](https://claude.com/claude-code) installed and logged in. Overviews are written by running
  `claude -p` locally, so no API key is needed.
- macOS only: Xcode command line tools (`xcode-select --install`)

## Running

```sh
npm install
npm run dev        # opens the app; reloads the UI when files in ui/ change
```

## Building installers

```sh
npm run build
```

- Windows: `src-tauri/target/release/bundle/msi/*.msi` and `nsis/*.exe`
- macOS: `src-tauri/target/release/bundle/dmg/*.dmg` and `macos/OpenUGC.app`

You can't build the macOS version from Windows. Build it on a Mac.

## Layout

- `ui/` – the front end (`index.html`, `styles.css`, `app.js`); no bundler
- `src-tauri/src/main.rs` – Tauri commands the UI calls
- `src-tauri/src/appstore.rs` – App Store search and gem scoring (Apple's iTunes Search API)
- `src-tauri/src/prepare.rs` – downloads icons/screenshots, writes overviews with the Claude CLI
- App data (downloaded assets, `state.json`) is stored in the OS app-data folder under `com.openugc.app`

## Tests

```sh
cd src-tauri && cargo test -- --ignored --nocapture   # live App Store + Claude CLI test
```
