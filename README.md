# SplitPDF Studio

SplitPDF Studio is moving to a desktop-first architecture:

- Frontend: React + TypeScript + Vite
- Desktop shell: Tauri v2
- Backend core: Rust
- Future storage/cache: SQLite
- Future PDF engines: MuPDF/PDFium/qpdf sidecar or Rust bindings

The current build focuses on a smooth SmallPDF-style UI for opening a PDF, previewing pages, and toggling split points between pages.

## Run Frontend UI

```powershell
C:\Users\buiqu\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd install
C:\Users\buiqu\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd dev
```

Open http://127.0.0.1:5173 after the dev server starts.

## Run Desktop App

Install Node.js and Rust/Cargo first, then run:

```powershell
node scripts/prepare-webview2.mjs
pnpm desktop
```

For the prepared local workspace, use `Chay-Online-Test.bat`. See [WEBVIEW2.md](WEBVIEW2.md) for the bundled Microsoft runtime, offline operation, and runtime security updates.

The `src-tauri` shell is already present. It includes the Tauri v2 config, a main window, base capabilities, and one sample IPC command so the PDF backend can be connected cleanly. During desktop development, Tauri reuses the existing Vite server on port `5173` when it is already running.
