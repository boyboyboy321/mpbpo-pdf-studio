# Bundled WebView2

Both editions use the Microsoft Fixed Version Runtime pinned in
`scripts/webview2-runtime.json`. They no longer depend on the Windows Evergreen
runtime for their WebView. The app IDs, activation records and PDF engines are
unchanged.

## Why It Is Pinned

On September 7, 2026, WebView2 152.0.4191.66 exposed `window.EyeDropper` but
`open()` immediately rejected with `AbortError`, even with a real click, focus
and a clean profile. The same executable opened EyeDropper using Microsoft
WebView2 151.0.4129.107. The Edge 152 browser itself also opened it. This isolates
the observed regression to the WebView2 runtime, not an HTTP API or PDF data.

EyeDropper remains the native WebView2 implementation. It does not require an
internet connection. No screen-sampling replacement or experimental browser
flags are shipped.

## Prepare And Test

On a connected Windows x64 development computer:

```powershell
node scripts/prepare-webview2.mjs
node scripts/prepare-webview2.mjs --check
```

An already downloaded official archive may be passed as `--archive C:/path/runtime.cab`.
The archive SHA-256, executable's Microsoft signature, version, and required
files are checked before packaging. The runtime binaries are ignored by Git.
`--check` does not download anything. Tauri's `fixedRuntime` configuration copies
the complete runtime into both development output and the eventual installer.
Do not distribute the application EXE without its runtime directory.
The NSIS post-install hook grants the runtime read/execute permissions required
by the Windows 10 AppContainer sandbox. It does not disable the sandbox or
change the system WebView2 installation. Install to a local disk, not a UNC path.

Run `Chay-Online-Test.bat` in Online or `Chay-Offline-Test.bat` in Offline. These
launch development builds, not installers. Each worktree has its own runtime
copy, output, and app data.

The browser interaction regression suite is `node scripts/test-editor-interactions.mjs`.
It requires Playwright (`PLAYWRIGHT_MODULE` may point to an existing installation).
It tests drag cancellation, edge/wheel scrolling, reorder, and native picker
lifecycle using mocks for deterministic failures. A real WebView2 smoke test is
also required when changing the pinned runtime; browser mocks cannot certify it.

## Runtime Maintenance

Fixed Runtime does not automatically receive Microsoft's security updates.
Before each release, review current Microsoft WebView2/security releases and
test a newer supported runtime. Update the manifest and verified runtime copies
together once EyeDropper, rendering, save/split, and offline activation pass.
Do not freeze this version indefinitely. Windows 10/11 x64 are the target systems.

Microsoft sources: [Fixed Version distribution](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution#the-fixed-version-runtime-distribution-mode),
[official downloads](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).
