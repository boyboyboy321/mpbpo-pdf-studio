import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { CheckCircle2, Download, Minus, RefreshCw, ShieldAlert, Square, X } from "lucide-react";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import type { PointerEvent, ReactNode } from "react";
import { useCallback, useEffect, useReducer, useState } from "react";

import { EditorView } from "./components/EditorView";
import { HomeView } from "./components/HomeView";
import type { PdfLoadState } from "./domain/pdf";
import { APP_VERSION, getPolicyBlockMessage, loadAppPolicy } from "./services/appPolicy";
import { saveEditorPreferences } from "./services/editorPreferences";
import { findFirstPdfPath, getFriendlyLoadError, loadPdfDocumentFromPath, pickPdfFilePath } from "./services/pdfLoader";
import { loadRecentFiles, rememberRecentDocument } from "./services/recentFiles";
import { documentReducer } from "./state/documentReducer";
import { createDemoDocument } from "./utils/demoPages";

import "./styles/app.css";

type WindowCommand = "close_main_window" | "minimize_main_window" | "start_main_window_drag" | "toggle_main_window_maximize";

type AppUpdateState =
  | { status: "idle" }
  | {
      status: "available";
      body: string | undefined;
      currentVersion: string;
      errorMessage?: string;
      mandatory: boolean;
      update: Update;
      version: string;
    }
  | { status: "downloading"; downloadedBytes: number; percent: number; totalBytes: number | undefined; version: string }
  | { status: "installing"; version: string }
  | { status: "error"; mandatory?: boolean; message: string };

type AppAccessState =
  | { status: "checking" }
  | { status: "ready" }
  | { status: "locked"; message: string };

async function invokeWindowCommand(command: WindowCommand) {
  if (!isTauri()) {
    return;
  }

  await invoke(command);
}

export function App() {
  const [document, dispatch] = useReducer(documentReducer, null);
  const [loadState, setLoadState] = useState<PdfLoadState>({ status: "idle" });
  const [isFileDragging, setIsFileDragging] = useState(false);
  const [recentFiles, setRecentFiles] = useState(loadRecentFiles);
  const [appAccessState, setAppAccessState] = useState<AppAccessState>(() => (isTauri() ? { status: "checking" } : { status: "ready" }));
  const [updateState, setUpdateState] = useState<AppUpdateState>({ status: "idle" });

  useEffect(() => {
    if (!isTauri()) {
      return;
    }

    let isActive = true;

    void (async () => {
      let mandatoryUpdate = true;

      try {
        const policy = await loadAppPolicy();
        const blockMessage = getPolicyBlockMessage(policy, APP_VERSION);
        mandatoryUpdate = policy.mandatoryUpdate ?? true;

        if (isActive && blockMessage) {
          setAppAccessState({ status: "locked", message: blockMessage });
        } else if (isActive) {
          setAppAccessState({ status: "ready" });
        }
      } catch (error: unknown) {
        console.info("Could not load app policy.", error);
        if (isActive) {
          setAppAccessState({ status: "ready" });
        }
      }

      try {
        const update = await check({ timeout: 25_000 });

        if (!isActive || !update) {
          return;
        }

        setUpdateState({
          status: "available",
          body: update.body,
          currentVersion: update.currentVersion,
          mandatory: mandatoryUpdate,
          update,
          version: update.version,
        });
      } catch (error: unknown) {
        console.info("Could not check for updates.", error);
      }
    })();

    return () => {
      isActive = false;
    };
  }, []);

  const dismissUpdate = useCallback(() => {
    if (updateState.status === "available") {
      if (updateState.mandatory) {
        return;
      }

      void updateState.update.close().catch((error: unknown) => {
        console.info("Could not close updater resource.", error);
      });
    }

    setUpdateState({ status: "idle" });
  }, [updateState]);

  const installUpdate = useCallback(async () => {
    if (updateState.status !== "available") {
      return;
    }

    const { body, currentVersion, mandatory, update, version } = updateState;
    let downloadedBytes = 0;
    let totalBytes: number | undefined;

    const handleDownloadEvent = (event: DownloadEvent) => {
      if (event.event === "Started") {
        downloadedBytes = 0;
        totalBytes = event.data.contentLength;
        setUpdateState({
          status: "downloading",
          downloadedBytes,
          percent: 0,
          totalBytes,
          version,
        });
        return;
      }

      if (event.event === "Progress") {
        downloadedBytes += event.data.chunkLength;
        const percent = totalBytes ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : 0;
        setUpdateState({
          status: "downloading",
          downloadedBytes,
          percent,
          totalBytes,
          version,
        });
        return;
      }

      setUpdateState({ status: "installing", version });
    };

    try {
      setUpdateState({
        status: "downloading",
        downloadedBytes: 0,
        percent: 0,
        totalBytes: undefined,
        version,
      });
      await update.downloadAndInstall(handleDownloadEvent, { timeout: 180_000 });
      setUpdateState({ status: "installing", version });
      await relaunch();
    } catch (error) {
      setUpdateState({
        status: "available",
        body,
        currentVersion,
        errorMessage: getFriendlyLoadError(error),
        mandatory,
        update,
        version,
      });
    }
  }, [updateState]);

  useEffect(() => {
    if (!document) {
      return;
    }

    saveEditorPreferences({
      customRenderQuality: document.customRenderQuality,
      detailPanelVisible: document.detailPanelVisible,
      renderQualityPreset: document.renderQualityPreset,
      splitCustomOutputFolder: document.splitCustomOutputFolder,
      splitOutputMode: document.splitOutputMode,
      thumbnailScale: document.thumbnailScale,
    });
  }, [
    document?.customRenderQuality,
    document?.detailPanelVisible,
    document?.renderQualityPreset,
    document?.splitCustomOutputFolder,
    document?.splitOutputMode,
    document?.thumbnailScale,
  ]);

  const openPdfPath = useCallback(async (path: string) => {
    if (document?.isDirty) {
      const shouldDiscard = window.confirm("This file has unsaved changes. Discard them and open another file?");
      if (!shouldDiscard) {
        return;
      }
    }

    setLoadState({ status: "loading", message: "Reading PDF structure..." });

    try {
      const nextDocument = await loadPdfDocumentFromPath(path);
      dispatch({ type: "open", document: nextDocument });
      setRecentFiles(rememberRecentDocument(nextDocument));
      setLoadState({ status: "idle" });
    } catch (error) {
      setLoadState({ status: "error", message: getFriendlyLoadError(error) });
    }
  }, [document?.isDirty]);

  const pickAndOpenPdf = useCallback(async () => {
    if (!isTauri()) {
      setLoadState({ status: "error", message: "Open file works in the desktop app. Use Try demo in the browser preview." });
      return;
    }

    try {
      const path = await pickPdfFilePath();
      if (path) {
        await openPdfPath(path);
      }
    } catch (error) {
      setLoadState({ status: "error", message: getFriendlyLoadError(error) });
    }
  }, [openPdfPath]);

  const openDemo = useCallback(() => {
    setLoadState({ status: "idle" });
    dispatch({ type: "open", document: createDemoDocument() });
  }, []);

  const openRecentPdf = useCallback(
    async (path: string) => {
      await openPdfPath(path);
    },
    [openPdfPath],
  );

  useEffect(() => {
    if (!isTauri()) {
      return;
    }

    let isActive = true;
    let unlisten: (() => void) | null = null;

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const { payload } = event;

        if (payload.type === "enter" || payload.type === "over") {
          setIsFileDragging(true);
          return;
        }

        if (payload.type === "leave") {
          setIsFileDragging(false);
          return;
        }

        setIsFileDragging(false);
        const path = findFirstPdfPath(payload.paths);

        if (!path) {
          setLoadState({ status: "error", message: "Drop a PDF file to open it." });
          return;
        }

        void openPdfPath(path);
      })
      .then((nextUnlisten) => {
        if (isActive) {
          unlisten = nextUnlisten;
        } else {
          nextUnlisten();
        }
      })
      .catch((error: unknown) => {
        setLoadState({ status: "error", message: getFriendlyLoadError(error) });
      });

    return () => {
      isActive = false;
      unlisten?.();
    };
  }, [openPdfPath]);

  if (!document) {
    return (
      <div className="desktop-frame">
        <AppTitleBar />
        <HomeView
          isFileDragging={isFileDragging}
          loadState={loadState}
          recentFiles={recentFiles}
          onOpenDemo={openDemo}
          onOpenRecent={openRecentPdf}
          onPickPdf={pickAndOpenPdf}
        />
        <UpdateToast state={updateState} onClose={() => setUpdateState({ status: "idle" })} onInstall={installUpdate} onSkip={dismissUpdate} />
        <AppAccessGate accessState={appAccessState} updateState={updateState} onInstall={installUpdate} />
      </div>
    );
  }

  return (
    <div className="desktop-frame">
      <AppTitleBar />
      <EditorView
        dispatch={dispatch}
        document={document}
        isFileDragging={isFileDragging}
        loadState={loadState}
        onPickPdf={pickAndOpenPdf}
      />
      <UpdateToast state={updateState} onClose={() => setUpdateState({ status: "idle" })} onInstall={installUpdate} onSkip={dismissUpdate} />
      <AppAccessGate accessState={appAccessState} updateState={updateState} onInstall={installUpdate} />
    </div>
  );
}

function shouldBlockForUpdate(state: AppUpdateState) {
  return (
    (state.status === "available" && state.mandatory) ||
    state.status === "downloading" ||
    state.status === "installing" ||
    (state.status === "error" && state.mandatory)
  );
}

function AppAccessGate({
  accessState,
  onInstall,
  updateState,
}: {
  accessState: AppAccessState;
  onInstall: () => void;
  updateState: AppUpdateState;
}) {
  if (accessState.status === "ready" && !shouldBlockForUpdate(updateState)) {
    return null;
  }

  let title = "Checking MpBPO PDF Studio";
  let message = "Verifying this release before opening the app.";
  let action: ReactNode = null;
  let progress: ReactNode = null;

  if (accessState.status === "locked") {
    title = "This version is locked";
    message = accessState.message;
  }

  if (updateState.status === "available" && updateState.mandatory) {
    title = "Required update";
    message = `Version ${updateState.version} is ready. Update is required before using the app.`;
    action = (
      <button className="app-access-primary" type="button" onClick={onInstall}>
        Update now
      </button>
    );
  }

  if (updateState.status === "available" && updateState.errorMessage) {
    message = updateState.errorMessage;
  }

  if (updateState.status === "downloading") {
    title = "Updating MpBPO PDF Studio";
    message = updateState.totalBytes ? `Downloading version ${updateState.version} (${updateState.percent}%).` : `Downloading version ${updateState.version}.`;
    progress = (
      <div className={`split-toast-progress ${updateState.totalBytes ? "" : "is-indeterminate"}`} aria-label="Downloading required update">
        <span style={{ width: updateState.totalBytes ? `${updateState.percent}%` : "42%" }} />
      </div>
    );
  }

  if (updateState.status === "installing") {
    title = "Installing update";
    message = "The app will restart automatically when the update is ready.";
    progress = (
      <div className="split-toast-progress is-indeterminate" aria-label="Installing required update">
        <span />
      </div>
    );
  }

  if (updateState.status === "error" && updateState.mandatory) {
    title = "Update failed";
    message = updateState.message;
  }

  return (
    <div className="app-access-overlay" role="alertdialog" aria-modal="true" aria-labelledby="app-access-title">
      <section className="app-access-card">
        <div className="app-access-icon">
          {updateState.status === "installing" ? <CheckCircle2 size={34} /> : <ShieldAlert size={34} />}
        </div>
        <div className="app-access-copy">
          <strong id="app-access-title">{title}</strong>
          <span>{message}</span>
          {progress}
          {action}
        </div>
      </section>
    </div>
  );
}

function UpdateToast({
  onClose,
  onInstall,
  onSkip,
  state,
}: {
  onClose: () => void;
  onInstall: () => void;
  onSkip: () => void;
  state: AppUpdateState;
}) {
  if (state.status === "idle") {
    return null;
  }

  if (shouldBlockForUpdate(state)) {
    return null;
  }

  if (state.status === "available") {
    return (
      <aside className="split-toast update-toast is-available" role="status" aria-live="polite">
        <div className="split-toast-rail">
          <Download size={26} />
        </div>
        <div className="split-toast-body">
          <strong>Update available</strong>
          <span>
            Version {state.version} is ready. Current version: {state.currentVersion}.
          </span>
          {state.errorMessage ? <small>{state.errorMessage}</small> : null}
          {state.body ? <small>{state.body}</small> : null}
          <div className="update-toast-actions">
            <button className="toast-link" type="button" onClick={onInstall}>
              Update now
            </button>
            <button className="toast-link is-muted" type="button" onClick={onSkip}>
              Skip
            </button>
          </div>
        </div>
        <button className="split-toast-close" type="button" aria-label="Close update notice" onClick={onSkip}>
          <X size={20} />
        </button>
      </aside>
    );
  }

  if (state.status === "downloading") {
    const progressText = state.totalBytes ? `${state.percent}%` : "Downloading";

    return (
      <aside className="split-toast update-toast is-running" role="status" aria-live="polite">
        <div className="split-toast-rail">
          <RefreshCw size={28} />
        </div>
        <div className="split-toast-body">
          <strong>Updating MpBPO PDF Studio...</strong>
          <span>
            Downloading version {state.version} {state.totalBytes ? `(${progressText})` : ""}
          </span>
          <div className={`split-toast-progress ${state.totalBytes ? "" : "is-indeterminate"}`} aria-label={`Downloading update ${progressText}`}>
            <span style={{ width: state.totalBytes ? `${state.percent}%` : "42%" }} />
          </div>
        </div>
      </aside>
    );
  }

  if (state.status === "installing") {
    return (
      <aside className="split-toast update-toast is-success" role="status" aria-live="polite">
        <div className="split-toast-rail">
          <CheckCircle2 size={28} />
        </div>
        <div className="split-toast-body">
          <strong>Update installed</strong>
          <span>Restarting MpBPO PDF Studio...</span>
        </div>
      </aside>
    );
  }

  return (
    <aside className="split-toast update-toast is-error" role="alert">
      <div className="split-toast-rail">
        <X size={26} />
      </div>
      <div className="split-toast-body">
        <strong>Update failed</strong>
        <span>{state.message}</span>
      </div>
      <button className="split-toast-close" type="button" aria-label="Close update error" onClick={onClose}>
        <X size={20} />
      </button>
    </aside>
  );
}

function AppTitleBar() {
  const handleMinimize = useCallback(async () => {
    try {
      await invokeWindowCommand("minimize_main_window");
    } catch (error) {
      console.error("Could not minimize the window.", error);
    }
  }, []);

  const handleToggleMaximize = useCallback(async () => {
    try {
      await invokeWindowCommand("toggle_main_window_maximize");
    } catch (error) {
      console.error("Could not toggle the window size.", error);
    }
  }, []);

  const handleClose = useCallback(async () => {
    try {
      await invokeWindowCommand("close_main_window");
    } catch {
      // A dirty document can prevent closing so the editor can show its save warning.
    }
  }, []);

  const handleTitleBarPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!isTauri() || event.button !== 0) {
        return;
      }

      if (event.detail === 2) {
        void handleToggleMaximize();
        return;
      }

      void invokeWindowCommand("start_main_window_drag").catch((error) => {
        console.error("Could not drag the window.", error);
      });
    },
    [handleToggleMaximize],
  );

  return (
    <header className="app-titlebar">
      <div className="app-titlebar-drag" onPointerDown={handleTitleBarPointerDown}>
        <div className="brand-lockup" aria-label="MpBPO PDF Studio">
          <span className="brand-grid" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </span>
          <strong>MpBPO PDF Studio</strong>
        </div>
      </div>
      <div className="app-titlebar-actions">
        <span
          className="window-control-group"
          aria-label="Window controls"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button type="button" aria-label="Minimize window" onClick={() => void handleMinimize()}>
            <Minus size={17} />
          </button>
          <button type="button" aria-label="Maximize window" onClick={() => void handleToggleMaximize()}>
            <Square size={13} />
          </button>
          <button className="is-close" type="button" aria-label="Close window" onClick={() => void handleClose()}>
            <X size={18} />
          </button>
        </span>
      </div>
    </header>
  );
}
