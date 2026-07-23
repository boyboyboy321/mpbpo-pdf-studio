import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CheckCircle2, Download, FileText, Home, Minus, Plus, RefreshCw, ShieldAlert, Square, X } from "lucide-react";
import { exit, relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import type { PointerEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { EditorView } from "./components/EditorView";
import { HomeView } from "./components/HomeView";
import type { PdfDocument, PdfLoadState } from "./domain/pdf";
import { APP_VERSION, getPolicyBlockMessage, loadAppPolicy } from "./services/appPolicy";
import { saveEditorPreferences } from "./services/editorPreferences";
import {
  findPdfPaths,
  getFriendlyLoadError,
  loadPdfDocumentFromPath,
  pickPdfFilePaths,
  readStartupPdfPaths,
  savePdfEdits,
} from "./services/pdfLoader";
import { loadRecentFiles, rememberRecentDocument } from "./services/recentFiles";
import { documentReducer, type DocumentAction } from "./state/documentReducer";
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
  | { status: "locked"; message: string; reason: "connection" | "policy"; title: string };

type FileWriteJobKind = "save" | "split";

interface FileWriteJob {
  fileName: string;
  id: string;
  kind: FileWriteJobKind;
  tabId: string;
}

interface PdfDocumentTab {
  document: PdfDocument;
  id: string;
}

interface PendingTabClose {
  tabId: string;
}

interface OpenPdfPathsPayload {
  paths: string[];
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

async function invokeWindowCommand(command: WindowCommand) {
  if (!isTauri()) {
    return;
  }

  await invoke(command);
}

export function App() {
  const startupOpenAttemptedRef = useRef(false);
  const closeBypassRef = useRef(false);
  const [tabs, setTabs] = useState<PdfDocumentTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [pendingTabClose, setPendingTabClose] = useState<PendingTabClose | null>(null);
  const [appCloseConfirmationOpen, setAppCloseConfirmationOpen] = useState(false);
  const [fileWriteJob, setFileWriteJob] = useState<FileWriteJob | null>(null);
  const [loadState, setLoadState] = useState<PdfLoadState>({ status: "idle" });
  const [isFileDragging, setIsFileDragging] = useState(false);
  const [recentFiles, setRecentFiles] = useState(loadRecentFiles);
  const releaseChecksEnabled = isTauri() && import.meta.env.PROD;
  const [appAccessState, setAppAccessState] = useState<AppAccessState>(() => (releaseChecksEnabled ? { status: "checking" } : { status: "ready" }));
  const [updateState, setUpdateState] = useState<AppUpdateState>({ status: "idle" });

  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeTabId) ?? null, [activeTabId, tabs]);
  const document = activeTab?.document ?? null;
  const dirtyTabs = useMemo(() => tabs.filter((tab) => tab.document.isDirty), [tabs]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") {
        return;
      }

      event.preventDefault();

      if (!isEditableTarget(event.target) && window.document.activeElement instanceof HTMLElement) {
        window.document.activeElement.blur();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  useEffect(() => {
    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };

    window.addEventListener("contextmenu", handleContextMenu, true);
    return () => window.removeEventListener("contextmenu", handleContextMenu, true);
  }, []);

  useEffect(() => {
    if (!releaseChecksEnabled) {
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
          setAppAccessState({
            status: "locked",
            message: blockMessage,
            reason: "policy",
            title: "Không thể mở ứng dụng",
          });
        } else if (isActive) {
          setAppAccessState({ status: "ready" });
        }
      } catch (error: unknown) {
        console.info("Could not load app policy.", error);
        if (isActive) {
          setAppAccessState({
            status: "locked",
            reason: "connection",
            message: "Không thể kiểm tra cập nhật. Vui lòng kiểm tra kết nối mạng rồi mở lại.",
            title: "Lỗi kết nối",
          });
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
  }, [releaseChecksEnabled]);

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

  const dispatchToActiveDocument = useCallback(
    (action: DocumentAction) => {
      if (!activeTabId) {
        return;
      }

      setTabs((currentTabs) =>
        currentTabs.map((tab) => {
          if (tab.id !== activeTabId) {
            return tab;
          }

          const nextDocument = documentReducer(tab.document, action);
          return nextDocument ? { ...tab, document: nextDocument } : tab;
        }),
      );
    },
    [activeTabId],
  );

  const beginFileWriteJob = useCallback(
    (job: FileWriteJob) => {
      if (fileWriteJob && fileWriteJob.id !== job.id) {
        return false;
      }

      setFileWriteJob(job);
      return true;
    },
    [fileWriteJob],
  );

  const endFileWriteJob = useCallback((jobId: string) => {
    setFileWriteJob((currentJob) => (currentJob?.id === jobId ? null : currentJob));
  }, []);

  const removeTab = useCallback((tabId: string) => {
    setTabs((currentTabs) => {
      const tabIndex = currentTabs.findIndex((tab) => tab.id === tabId);
      const nextTabs = currentTabs.filter((tab) => tab.id !== tabId);

      setActiveTabId((currentActiveTabId) => {
        if (currentActiveTabId !== tabId) {
          return currentActiveTabId;
        }

        return nextTabs[Math.min(tabIndex, nextTabs.length - 1)]?.id ?? null;
      });

      return nextTabs;
    });
  }, []);

  const requestCloseTab = useCallback(
    (tabId: string) => {
      if (fileWriteJob?.tabId === tabId) {
        setLoadState({
          status: "error",
          message: `${fileWriteJob.fileName} is ${fileWriteJob.kind === "split" ? "splitting" : "saving"}. Please wait before closing it.`,
        });
        return;
      }

      const tab = tabs.find((candidate) => candidate.id === tabId);
      if (!tab) {
        return;
      }

      if (tab.document.isDirty) {
        setPendingTabClose({ tabId });
        return;
      }

      removeTab(tabId);
    },
    [fileWriteJob, removeTab, tabs],
  );

  const saveDocumentTab = useCallback(
    async (tabId: string) => {
      const tab = tabs.find((candidate) => candidate.id === tabId);
      if (!tab) {
        return false;
      }

      if (!tab.document.filePath) {
        setLoadState({ status: "error", message: "Open a real PDF before saving. Demo files cannot be saved." });
        return false;
      }

      if (!tab.document.isDirty) {
        return true;
      }

      if (fileWriteJob) {
        setLoadState({
          status: "error",
          message: `${fileWriteJob.fileName} is ${fileWriteJob.kind === "split" ? "splitting" : "saving"}. Please wait before saving another file.`,
        });
        return false;
      }

      const jobId = createAppJobId("save");
      setFileWriteJob({ fileName: tab.document.fileName, id: jobId, kind: "save", tabId });
      setLoadState({ status: "loading", message: `Saving ${tab.document.fileName}...` });

      try {
        const metadata = await savePdfEdits(tab.document);
        setTabs((currentTabs) =>
          currentTabs.map((candidate) => {
            if (candidate.id !== tabId) {
              return candidate;
            }

            const nextDocument = documentReducer(candidate.document, { type: "save-complete", metadata });
            return nextDocument ? { ...candidate, document: nextDocument } : candidate;
          }),
        );
        setRecentFiles(rememberRecentDocument({ ...tab.document, ...metadata }));
        setLoadState({ status: "idle" });
        return true;
      } catch (error: unknown) {
        setLoadState({ status: "error", message: getFriendlyLoadError(error) });
        return false;
      } finally {
        setFileWriteJob((currentJob) => (currentJob?.id === jobId ? null : currentJob));
      }
    },
    [fileWriteJob, tabs],
  );

  const closeTabWithoutSaving = useCallback(() => {
    if (!pendingTabClose) {
      return;
    }

    removeTab(pendingTabClose.tabId);
    setPendingTabClose(null);
  }, [pendingTabClose, removeTab]);

  const saveAndCloseTab = useCallback(async () => {
    if (!pendingTabClose) {
      return;
    }

    const saved = await saveDocumentTab(pendingTabClose.tabId);
    if (saved) {
      removeTab(pendingTabClose.tabId);
      setPendingTabClose(null);
    }
  }, [pendingTabClose, removeTab, saveDocumentTab]);

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
      thumbnailLayout: document.thumbnailLayout,
      thumbnailScale: document.thumbnailScale,
    });
  }, [
    document?.customRenderQuality,
    document?.detailPanelVisible,
    document?.renderQualityPreset,
    document?.splitCustomOutputFolder,
    document?.splitOutputMode,
    document?.thumbnailLayout,
    document?.thumbnailScale,
  ]);

  const openPdfPaths = useCallback(
    async (paths: string[]) => {
      if (appAccessState.status !== "ready") {
        return;
      }

      const pdfPaths = uniquePdfPaths(paths);
      if (pdfPaths.length === 0) {
        setLoadState({ status: "error", message: "Choose a PDF file to open." });
        return;
      }

      const existingTabsByPath = new Map(tabs.filter((tab) => tab.document.filePath).map((tab) => [normalizePath(tab.document.filePath ?? ""), tab]));
      const pathsToLoad = pdfPaths.filter((path) => !existingTabsByPath.has(normalizePath(path)));

      if (pathsToLoad.length === 0) {
        const firstPdfPath = pdfPaths[0];
        const existingTab = firstPdfPath ? existingTabsByPath.get(normalizePath(firstPdfPath)) : null;
        if (existingTab) {
          setActiveTabId(existingTab.id);
        }
        setLoadState({ status: "idle" });
        return;
      }

      setLoadState({
        status: "loading",
        message: pathsToLoad.length === 1 ? "Reading PDF structure..." : `Opening ${pathsToLoad.length} PDFs...`,
      });

      const openedTabs: PdfDocumentTab[] = [];

      try {
        for (const path of pathsToLoad) {
          const nextDocument = await loadPdfDocumentFromPath(path);
          openedTabs.push({ document: nextDocument, id: createTabId() });
          setRecentFiles(rememberRecentDocument(nextDocument));
        }

        setTabs((currentTabs) => [...currentTabs, ...openedTabs]);
        setActiveTabId(openedTabs[0]?.id ?? activeTabId);
        setLoadState({ status: "idle" });
      } catch (error) {
        if (openedTabs.length > 0) {
          setTabs((currentTabs) => [...currentTabs, ...openedTabs]);
          setActiveTabId(openedTabs[0]?.id ?? activeTabId);
        }

        setLoadState({ status: "error", message: getFriendlyLoadError(error) });
      }
    },
    [activeTabId, appAccessState.status, tabs],
  );

  const openPdfPath = useCallback(
    async (path: string) => {
      await openPdfPaths([path]);
    },
    [openPdfPaths],
  );

  const pickAndOpenPdf = useCallback(async () => {
    if (!isTauri()) {
      setLoadState({ status: "error", message: "Open file works in the desktop app. Use Try demo in the browser preview." });
      return;
    }

    try {
      const paths = await pickPdfFilePaths();
      if (paths.length > 0) {
        await openPdfPaths(paths);
      }
    } catch (error) {
      setLoadState({ status: "error", message: getFriendlyLoadError(error) });
    }
  }, [openPdfPaths]);

  const openDemo = useCallback(() => {
    setLoadState({ status: "idle" });
    const demoDocument = createDemoDocument();
    const tabId = createTabId();
    setTabs((currentTabs) => [...currentTabs, { document: demoDocument, id: tabId }]);
    setActiveTabId(tabId);
  }, []);

  const openRecentPdf = useCallback(
    async (path: string) => {
      await openPdfPath(path);
    },
    [openPdfPath],
  );

  useEffect(() => {
    if (!isTauri() || startupOpenAttemptedRef.current || appAccessState.status !== "ready") {
      return;
    }

    let isActive = true;
    startupOpenAttemptedRef.current = true;

    void readStartupPdfPaths()
      .then((paths) => {
        if (isActive && paths.length > 0) {
          void openPdfPaths(paths);
        }
      })
      .catch((error: unknown) => {
        if (isActive) {
          setLoadState({ status: "error", message: getFriendlyLoadError(error) });
        }
      });

    return () => {
      isActive = false;
    };
  }, [appAccessState.status, openPdfPaths]);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }

    let isActive = true;
    let unlisten: (() => void) | null = null;

    void listen<OpenPdfPathsPayload>("open-pdf-paths", (event) => {
      void openPdfPaths(event.payload.paths);
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
  }, [openPdfPaths]);

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
        const paths = findPdfPaths(payload.paths);

        if (paths.length === 0) {
          setLoadState({ status: "error", message: "Drop a PDF file to open it." });
          return;
        }

        void openPdfPaths(paths);
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
  }, [openPdfPaths]);

  const requestCloseApp = useCallback(() => {
    if (fileWriteJob) {
      setLoadState({
        status: "error",
        message: `${fileWriteJob.fileName} is ${fileWriteJob.kind === "split" ? "splitting" : "saving"}. Please wait before closing the app.`,
      });
      return;
    }

    if (dirtyTabs.length > 0) {
      setAppCloseConfirmationOpen(true);
      return;
    }

    void closeAppImmediately(closeBypassRef);
  }, [dirtyTabs.length, fileWriteJob]);

  const closeAppWithoutSaving = useCallback(() => {
    setAppCloseConfirmationOpen(false);
    void closeAppImmediately(closeBypassRef);
  }, []);

  const saveAllAndCloseApp = useCallback(async () => {
    if (fileWriteJob) {
      setLoadState({
        status: "error",
        message: `${fileWriteJob.fileName} is ${fileWriteJob.kind === "split" ? "splitting" : "saving"}. Please wait before saving changes.`,
      });
      return;
    }

    for (const tab of dirtyTabs) {
      const saved = await saveDocumentTab(tab.id);
      if (!saved) {
        return;
      }
    }

    setAppCloseConfirmationOpen(false);
    void closeAppImmediately(closeBypassRef);
  }, [dirtyTabs, fileWriteJob, saveDocumentTab]);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }

    let isDisposed = false;
    let unlistenClose: (() => void) | null = null;

    void getCurrentWindow()
      .onCloseRequested((event) => {
        if (closeBypassRef.current) {
          return;
        }

        if (fileWriteJob || dirtyTabs.length > 0) {
          event.preventDefault();
          requestCloseApp();
        }
      })
      .then((unlisten) => {
        if (isDisposed) {
          unlisten();
          return;
        }

        unlistenClose = unlisten;
      })
      .catch(() => {
        // Browser preview does not expose the desktop close hook.
      });

    return () => {
      isDisposed = true;
      unlistenClose?.();
    };
  }, [dirtyTabs.length, fileWriteJob, requestCloseApp]);

  return (
    <div className="desktop-frame">
      <AppTitleBar onRequestClose={requestCloseApp} />
      <DocumentTabBar
        activeTabId={activeTabId}
        tabs={tabs}
        onActivateHome={() => setActiveTabId(null)}
        onActivateTab={setActiveTabId}
        onCloseTab={requestCloseTab}
        onOpenPdf={() => void pickAndOpenPdf()}
      />
      {document && activeTab ? (
        <EditorView
          busyJob={fileWriteJob}
          dispatch={dispatchToActiveDocument}
          document={document}
          guardWindowClose={false}
          isFileDragging={isFileDragging}
          loadState={loadState}
          tabId={activeTab.id}
          onBeginBusyJob={beginFileWriteJob}
          onEndBusyJob={endFileWriteJob}
          onPickPdf={pickAndOpenPdf}
        />
      ) : (
        <HomeView
          isFileDragging={isFileDragging}
          loadState={loadState}
          recentFiles={recentFiles}
          onOpenDemo={openDemo}
          onOpenRecent={openRecentPdf}
          onPickPdf={pickAndOpenPdf}
        />
      )}
      <UpdateToast state={updateState} onClose={() => setUpdateState({ status: "idle" })} onInstall={installUpdate} onSkip={dismissUpdate} />
      <AppAccessGate accessState={appAccessState} updateState={updateState} onInstall={installUpdate} />
      {pendingTabClose ? (
        <TabCloseConfirmDialog
          fileName={tabs.find((tab) => tab.id === pendingTabClose.tabId)?.document.fileName ?? "this PDF"}
          isSaving={fileWriteJob?.kind === "save" && fileWriteJob.tabId === pendingTabClose.tabId}
          onCancel={() => setPendingTabClose(null)}
          onCloseWithoutSaving={closeTabWithoutSaving}
          onSaveAndClose={() => void saveAndCloseTab()}
        />
      ) : null}
      {appCloseConfirmationOpen ? (
        <AppCloseConfirmDialog
          dirtyCount={dirtyTabs.length}
          isSaving={fileWriteJob?.kind === "save"}
          onCancel={() => setAppCloseConfirmationOpen(false)}
          onCloseWithoutSaving={closeAppWithoutSaving}
          onSaveAndClose={() => void saveAllAndCloseApp()}
        />
      ) : null}
    </div>
  );
}

function DocumentTabBar({
  activeTabId,
  onActivateHome,
  onActivateTab,
  onCloseTab,
  onOpenPdf,
  tabs,
}: {
  activeTabId: string | null;
  onActivateHome: () => void;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onOpenPdf: () => void;
  tabs: PdfDocumentTab[];
}) {
  return (
    <nav className="document-tabbar" aria-label="Open documents">
      <button className={`document-tab is-home ${activeTabId ? "" : "is-active"}`} type="button" onClick={onActivateHome}>
        <Home size={18} />
        Home
      </button>
      {tabs.map((tab) => (
        <button
          className={`document-tab ${tab.id === activeTabId ? "is-active" : ""} ${tab.document.isDirty ? "is-dirty" : ""}`}
          type="button"
          key={tab.id}
          title={tab.document.filePath ?? tab.document.fileName}
          onClick={() => onActivateTab(tab.id)}
        >
          <FileText size={17} />
          <span>{tab.document.isDirty ? `*${tab.document.fileName}` : tab.document.fileName}</span>
          <span
            className="document-tab-close"
            role="button"
            tabIndex={-1}
            aria-label={`Close ${tab.document.fileName}`}
            title={`Close ${tab.document.fileName}`}
            onClick={(event) => {
              event.stopPropagation();
              onCloseTab(tab.id);
            }}
          >
            <X size={16} />
          </span>
        </button>
      ))}
      <button className="document-tab-add" type="button" onClick={onOpenPdf} aria-label="Open PDF">
        <Plus size={18} />
      </button>
    </nav>
  );
}

function TabCloseConfirmDialog({
  fileName,
  isSaving,
  onCancel,
  onCloseWithoutSaving,
  onSaveAndClose,
}: {
  fileName: string;
  isSaving: boolean;
  onCancel: () => void;
  onCloseWithoutSaving: () => void;
  onSaveAndClose: () => void;
}) {
  return (
    <div className="confirm-backdrop" role="presentation" onMouseDown={onCancel}>
      <section className="confirm-dialog is-neutral" role="alertdialog" aria-modal="true" aria-labelledby="tab-close-confirm-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="confirm-icon">
          <ShieldAlert size={24} />
        </div>
        <div className="confirm-copy">
          <h2 id="tab-close-confirm-title">Save changes before closing?</h2>
          <p>{fileName} has unsaved changes.</p>
        </div>
        <div className="confirm-actions">
          <button className="secondary-action" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button className="danger-action" type="button" onClick={onCloseWithoutSaving}>
            Close without saving
          </button>
          <button className="primary-action" type="button" disabled={isSaving} onClick={onSaveAndClose}>
            {isSaving ? "Saving..." : "Save and close"}
          </button>
        </div>
      </section>
    </div>
  );
}

function AppCloseConfirmDialog({
  dirtyCount,
  isSaving,
  onCancel,
  onCloseWithoutSaving,
  onSaveAndClose,
}: {
  dirtyCount: number;
  isSaving: boolean;
  onCancel: () => void;
  onCloseWithoutSaving: () => void;
  onSaveAndClose: () => void;
}) {
  return (
    <div className="confirm-backdrop" role="presentation" onMouseDown={onCancel}>
      <section className="confirm-dialog is-neutral" role="alertdialog" aria-modal="true" aria-labelledby="app-close-confirm-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="confirm-icon">
          <ShieldAlert size={24} />
        </div>
        <div className="confirm-copy">
          <h2 id="app-close-confirm-title">Save changes before exiting?</h2>
          <p>
            {dirtyCount} {dirtyCount === 1 ? "PDF has" : "PDFs have"} unsaved changes.
          </p>
        </div>
        <div className="confirm-actions">
          <button className="secondary-action" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button className="danger-action" type="button" onClick={onCloseWithoutSaving}>
            Exit without saving
          </button>
          <button className="primary-action" type="button" disabled={isSaving} onClick={onSaveAndClose}>
            {isSaving ? "Saving..." : "Save all and exit"}
          </button>
        </div>
      </section>
    </div>
  );
}

function createTabId() {
  return `tab-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createAppJobId(kind: FileWriteJobKind) {
  return `${kind}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizePath(path: string) {
  return path.replace(/\\/g, "/").toLowerCase();
}

function uniquePdfPaths(paths: string[]) {
  const seen = new Set<string>();
  const pdfPaths: string[] = [];

  for (const path of findPdfPaths(paths)) {
    const normalized = normalizePath(path);
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    pdfPaths.push(path);
  }

  return pdfPaths;
}

async function closeAppImmediately(closeBypassRef: { current: boolean }) {
  closeBypassRef.current = true;

  try {
    if (isTauri()) {
      await getCurrentWindow().close();
      window.setTimeout(() => {
        void exit(0);
      }, 160);
      return;
    }

    await invokeWindowCommand("close_main_window");
  } catch {
    if (isTauri()) {
      await exit(0).catch((error: unknown) => {
        console.error("Could not force close the window.", error);
      });
    }
  }
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

  const policyLocked = accessState.status === "locked" && accessState.reason === "policy";

  if (accessState.status === "locked") {
    title = accessState.title;
    message = accessState.message;
  }

  if (!policyLocked && updateState.status === "available" && updateState.mandatory) {
    title = "Required update";
    message = `Version ${updateState.version} is ready. Update is required before using the app.`;
    action = (
      <button className="app-access-primary" type="button" onClick={onInstall}>
        Update now
      </button>
    );
  }

  if (!policyLocked && updateState.status === "available" && updateState.errorMessage) {
    message = updateState.errorMessage;
  }

  if (!policyLocked && updateState.status === "downloading") {
    title = "Updating MpBPO PDF Studio";
    message = updateState.totalBytes ? `Downloading version ${updateState.version} (${updateState.percent}%).` : `Downloading version ${updateState.version}.`;
    progress = (
      <div className={`split-toast-progress ${updateState.totalBytes ? "" : "is-indeterminate"}`} aria-label="Downloading required update">
        <span style={{ width: updateState.totalBytes ? `${updateState.percent}%` : "42%" }} />
      </div>
    );
  }

  if (!policyLocked && updateState.status === "installing") {
    title = "Installing update";
    message = "The app will restart automatically when the update is ready.";
    progress = (
      <div className="split-toast-progress is-indeterminate" aria-label="Installing required update">
        <span />
      </div>
    );
  }

  if (!policyLocked && updateState.status === "error" && updateState.mandatory) {
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

function AppTitleBar({ forceClose = false, onRequestClose }: { forceClose?: boolean; onRequestClose?: () => void }) {
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
    if (onRequestClose) {
      onRequestClose();
      return;
    }

    try {
      if (forceClose && isTauri()) {
        await getCurrentWindow().close();
        window.setTimeout(() => {
          void exit(0);
        }, 160);
        return;
      }

      await invokeWindowCommand("close_main_window");
    } catch {
      if (forceClose && isTauri()) {
        await exit(0).catch((error: unknown) => {
          console.error("Could not force close the window.", error);
        });
      }
      // A dirty document can prevent closing so the editor can show its save warning.
    }
  }, [forceClose, onRequestClose]);

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
      <div
        className="app-titlebar-drag"
        onDoubleClick={(event) => {
          event.preventDefault();
          void handleToggleMaximize();
        }}
        onPointerDown={handleTitleBarPointerDown}
      >
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

