import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bookmark,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  Crop,
  FilePlus2,
  FolderOpen,
  Hand,
  Menu,
  MousePointer2,
  PaintBucket,
  Pipette,
  RotateCcw,
  RotateCw,
  RotateCwSquare,
  Save,
  Scissors,
  Search,
  Settings,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { exit } from "@tauri-apps/plugin-process";
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type WheelEvent as ReactWheelEvent,
} from "react";

import type {
  PdfDocument,
  PdfLoadState,
  PdfPage,
  PdfPagePaintEdit,
  PdfPagePreview,
  PdfTextAlign,
  SplitOutputMode,
  SplitProgressEvent,
  SplitResult,
  ThumbnailLayoutMode,
} from "../domain/pdf";
import type { RenderQualityPreset, RenderQualitySettings } from "../domain/pdfSettings";
import {
  getRenderQualitySettings,
  RENDER_QUALITY_LIMITS,
  RENDER_QUALITY_PRESETS,
  THUMBNAIL_SCALE_MAX,
  THUMBNAIL_SCALE_MIN,
  THUMBNAIL_SCALE_STEP,
} from "../domain/pdfSettings";
import {
  getFriendlyLoadError,
  openOutputFolder,
  pickInsertFilePaths,
  pickSplitOutputFolderPath,
  readInsertPages,
  renderDocumentPages,
  savePdfEdits,
  splitPdfDocument,
} from "../services/pdfLoader";
import { saveDocumentPageMarks } from "../services/pageMarks";
import type { DocumentAction } from "../state/documentReducer";
import { formatBytes } from "../utils/format";

import { PageGrid } from "./PageGrid";

interface EditorViewProps {
  busyJob: EditorFileWriteJob | null;
  document: PdfDocument;
  dispatch: Dispatch<DocumentAction>;
  guardWindowClose?: boolean;
  isFileDragging: boolean;
  loadState: PdfLoadState;
  tabId: string;
  onBeginBusyJob: (job: EditorFileWriteJob) => boolean;
  onEndBusyJob: (jobId: string) => void;
  onPickPdf: () => void;
}

interface EditorFileWriteJob {
  fileName: string;
  id: string;
  kind: "save" | "split";
  tabId: string;
}

interface HoverState {
  page: PdfPage;
  preview: PdfPagePreview | null;
  x: number;
  y: number;
}

type SplitState =
  | { status: "idle" }
  | { status: "running"; completedFiles: number; runId: string; totalFiles: number }
  | { status: "success"; result: SplitResult }
  | { status: "error"; message: string };

type SaveState = { status: "idle" } | { status: "running" } | { status: "success" } | { status: "error"; message: string };

interface FullPreviewState {
  initialTool?: DetailTool;
  page: PdfPage;
  preview: PdfPagePreview | null;
  status: "loading" | "ready" | "error";
}

type DetailTool = "cover" | "crop" | "hand" | "straighten" | "text";

interface DraftCoverRect {
  height: number;
  width: number;
  x: number;
  y: number;
}

interface NormalizedPoint {
  x: number;
  y: number;
}

interface DetailTextStyle {
  bold: boolean;
  color: string;
  fontFamily: string;
  fontSize: number;
  italic: boolean;
  textAlign: PdfTextAlign;
  underline: boolean;
}

interface FloatingPanelPosition {
  x: number;
  y: number;
}

type TextResizeHandle = "east" | "south" | "southEast";

type CropResizeHandle = "east" | "move" | "north" | "northEast" | "northWest" | "south" | "southEast" | "southWest" | "west";

type EyeDropperWindow = Window & {
  EyeDropper?: new () => {
    open: () => Promise<{ sRGBHex: string }>;
  };
};

const DETAIL_ZOOM_MIN = 1;
const DETAIL_ZOOM_MAX = 5;
const DETAIL_ZOOM_STEP = 0.18;
const DETAIL_MIN_COVER_SIZE = 0.004;
const DETAIL_MIN_CROP_SIZE = 0.035;
const DETAIL_STRAIGHTEN_MAX_DEGREES = 15;
const DETAIL_STRAIGHTEN_EPSILON = 0.001;
const TEXT_PANEL_POSITION_STORAGE_KEY = "splitpdf.detailTextPanelPosition";
const DEFAULT_TEXT_PANEL_POSITION: FloatingPanelPosition = { x: 92, y: 128 };
const STRAIGHTEN_PANEL_POSITION_STORAGE_KEY = "splitpdf.detailStraightenPanelPosition";
const DEFAULT_STRAIGHTEN_PANEL_POSITION: FloatingPanelPosition = { x: 156, y: 144 };
const FULL_CROP_RECT: DraftCoverRect = { height: 1, width: 1, x: 0, y: 0 };

const MAGNIFIER_HEIGHT = 580;
const MAGNIFIER_WIDTH = 430;
const MAGNIFIER_OFFSET = 22;
const MAGNIFIER_VIEWPORT_PADDING = 16;
const DETAIL_BACKGROUND_BATCH_SIZE = 1;
const DETAIL_IDLE_DELAY_MS = 35;
const RENDER_QUALITY_OPTIONS = Object.entries(RENDER_QUALITY_PRESETS) as Array<[RenderQualityPreset, (typeof RENDER_QUALITY_PRESETS)[RenderQualityPreset]]>;
const FIXED_RENDER_QUALITY_OPTIONS = RENDER_QUALITY_OPTIONS.filter(([presetId]) => presetId !== "custom");
const SPLIT_OUTPUT_OPTIONS: Record<SplitOutputMode, { description: string; label: string; mode: SplitOutputMode }> = {
  siblingFolder: {
    description: "Create a timestamped _split folder.",
    label: "Folder beside original",
    mode: "siblingFolder",
  },
  originalFolderDeleteOriginal: {
    description: "Split beside the PDF, then remove source.",
    label: "Beside original, delete source",
    mode: "originalFolderDeleteOriginal",
  },
  customFolder: {
    description: "Pick a destination folder.",
    label: "Choose folder",
    mode: "customFolder",
  },
};
const SPLIT_OUTPUT_OPTION_LIST = Object.values(SPLIT_OUTPUT_OPTIONS);
const THUMBNAIL_LAYOUT_OPTIONS: Array<{ label: string; mode: ThumbnailLayoutMode; title: string }> = [
  { label: "Grid", mode: "grid", title: "Automatic thumbnail grid" },
  { label: "1", mode: "large1", title: "Show 1 large page per row" },
  { label: "2", mode: "large2", title: "Show 2 large pages per row" },
  { label: "3", mode: "large3", title: "Show 3 large pages per row" },
];

function getSplitOutputOption(mode: SplitOutputMode) {
  return SPLIT_OUTPUT_OPTIONS[mode];
}

interface SplitSegmentPreview {
  cutBeforePage: number | null;
  endPage: number;
  fileName: string;
  index: number;
  startPage: number;
}

function buildSplitSegments(fileName: string, pageCount: number, cuts: number[]): SplitSegmentPreview[] {
  const baseName = fileName.replace(/\.pdf$/i, "") || "document";
  const starts = [1, ...cuts];
  const ends = [...cuts.map((cut) => cut - 1), pageCount];

  return starts.map((startPage, index) => ({
    cutBeforePage: index === 0 ? null : startPage,
    endPage: ends[index] ?? pageCount,
    fileName: `${baseName}_${String(index + 1).padStart(3, "0")}.pdf`,
    index: index + 1,
    startPage,
  }));
}

export function EditorView({
  busyJob,
  document,
  dispatch,
  guardWindowClose = true,
  isFileDragging,
  loadState,
  onBeginBusyJob,
  onEndBusyJob,
  onPickPdf,
  tabId,
}: EditorViewProps) {
  const hoverFrameRef = useRef<number | null>(null);
  const eachPageSplitCheckboxRef = useRef<HTMLInputElement | null>(null);
  const cutListRef = useRef<HTMLDivElement | null>(null);
  const previousCutsRef = useRef<Set<number>>(new Set(document.cutBeforePages));
  const splitLocationMenuRef = useRef<HTMLDivElement | null>(null);
  const splitRunningRef = useRef(false);
  const pendingHoverRef = useRef<HoverState | null>(null);
  const detailFailedPagesRef = useRef<Set<string>>(new Set());
  const detailPreviewsRef = useRef<Record<string, PdfPagePreview>>({});
  const detailBackgroundCursorRef = useRef(1);
  const detailFilePathRef = useRef<string | null>(document.filePath);
  const detailPageIdsRef = useRef<string[]>(document.pages.map((page) => page.id));
  const detailPagesRef = useRef<PdfPage[]>(document.pages);
  const detailPriorityPagesRef = useRef<Set<string>>(new Set());
  const detailPriorityQueueRef = useRef<string[]>([]);
  const detailRunRef = useRef(0);
  const fileWriteRunningRef = useRef(false);
  const closeBypassRef = useRef(false);
  const smallPreviewCompleteRef = useRef(false);
  const [fullPreview, setFullPreview] = useState<FullPreviewState | null>(null);
  const [hovered, setHovered] = useState<HoverState | null>(null);
  const [detailPreviewVersion, setDetailPreviewVersion] = useState(0);
  const [detailPriorityActive, setDetailPriorityActive] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState<{ pageNumbers: number[] } | null>(null);
  const [closeConfirmationOpen, setCloseConfirmationOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [splitLocationMenuOpen, setSplitLocationMenuOpen] = useState(false);
  const [pageScrollTarget, setPageScrollTarget] = useState<number | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ status: "idle" });
  const [splitState, setSplitState] = useState<SplitState>({ status: "idle" });

  const renderQuality = useMemo(
    () => getRenderQualitySettings(document.renderQualityPreset, document.customRenderQuality),
    [document.customRenderQuality, document.renderQualityPreset],
  );
  const selectedPagesMarked = useMemo(() => {
    const selectedPages = document.pages.filter((page) => document.selectedPages.has(page.pageNumber));
    return selectedPages.length > 0 && selectedPages.every((page) => page.tinted);
  }, [document.pages, document.selectedPages]);
  const renderQualitySignature = `${renderQuality.smallWidth}:${renderQuality.smallJpegQuality}:${renderQuality.detailWidth}:${renderQuality.detailJpegQuality}`;
  const pageCacheSignature = useMemo(() => document.pages.map((page) => page.id).join("|"), [document.pages]);
  const sortedCuts = useMemo(() => [...document.cutBeforePages].sort((a, b) => a - b), [document.cutBeforePages]);
  const splitSegments = useMemo(() => buildSplitSegments(document.fileName, document.pages.length, sortedCuts), [document.fileName, document.pages.length, sortedCuts]);
  const totalPossibleCuts = Math.max(0, document.pages.length - 1);
  const isEachPageSplit = totalPossibleCuts > 0 && sortedCuts.length === totalPossibleCuts;
  const isPartialEachPageSplit = sortedCuts.length > 0 && !isEachPageSplit;
  const canSplit = Boolean(document.filePath) && sortedCuts.length > 0 && splitState.status !== "running" && !busyJob;
  const fileWriteRunning = Boolean(busyJob) || saveState.status === "running" || splitState.status === "running";
  const splitOutputOption = getSplitOutputOption(document.splitOutputMode);
  const splitOutputDescription =
    document.splitOutputMode === "customFolder" && document.splitCustomOutputFolder
      ? compactPath(document.splitCustomOutputFolder)
      : splitOutputOption.description;

  useEffect(() => {
    return () => {
      if (hoverFrameRef.current !== null) {
        window.cancelAnimationFrame(hoverFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    saveDocumentPageMarks(document);
  }, [document.filePath, document.pages]);

  useEffect(() => {
    if (eachPageSplitCheckboxRef.current) {
      eachPageSplitCheckboxRef.current.indeterminate = isPartialEachPageSplit;
    }
  }, [isPartialEachPageSplit]);

  useEffect(() => {
    const previousCuts = previousCutsRef.current;
    const addedCuts = sortedCuts.filter((cut) => !previousCuts.has(cut));
    previousCutsRef.current = new Set(sortedCuts);

    if (!cutListRef.current || addedCuts.length === 0) {
      return;
    }

    const latestCut = addedCuts.at(-1);
    window.setTimeout(() => {
      const target = cutListRef.current?.querySelector<HTMLElement>(`[data-cut-before-page="${latestCut}"]`);
      target?.scrollIntoView({ block: "nearest" });
    }, 0);
  }, [sortedCuts]);

  useEffect(() => {
    const hasDismissableToast =
      splitState.status === "success" ||
      splitState.status === "error" ||
      saveState.status === "success" ||
      saveState.status === "error";

    if (!settingsOpen && !hasDismissableToast) {
      return;
    }

    const handlePointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) {
        return;
      }

      if (target.closest(".render-settings-panel, .panel-toggle, .split-toast, .confirm-dialog, .split-location-picker")) {
        return;
      }

      if (settingsOpen) {
        setSettingsOpen(false);
      }

      if (splitState.status === "success" || splitState.status === "error") {
        setSplitState({ status: "idle" });
      }

      if (saveState.status === "success" || saveState.status === "error") {
        setSaveState({ status: "idle" });
      }
    };

    window.addEventListener("pointerdown", handlePointerDown, true);
    return () => window.removeEventListener("pointerdown", handlePointerDown, true);
  }, [saveState.status, settingsOpen, splitState.status]);

  useEffect(() => {
    splitRunningRef.current = splitState.status === "running";

    if (splitState.status === "running") {
      setSplitLocationMenuOpen(false);
    }
  }, [splitState.status]);

  useEffect(() => {
    fileWriteRunningRef.current = fileWriteRunning;
  }, [fileWriteRunning]);

  useEffect(() => {
    if (!splitLocationMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (splitLocationMenuRef.current?.contains(event.target as Node)) {
        return;
      }

      setSplitLocationMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSplitLocationMenuOpen(false);
      }
    };

    window.document.addEventListener("pointerdown", handlePointerDown);
    window.document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.document.removeEventListener("pointerdown", handlePointerDown);
      window.document.removeEventListener("keydown", handleKeyDown);
    };
  }, [splitLocationMenuOpen]);

  useEffect(() => {
    let isDisposed = false;
    let unlistenProgress: (() => void) | null = null;

    void listen<SplitProgressEvent>("split-progress", (event) => {
      const progress = event.payload;

      setSplitState((currentState) => {
        if (currentState.status !== "running" || currentState.runId !== progress.runId) {
          return currentState;
        }

        return {
          ...currentState,
          completedFiles: progress.completedFiles,
          totalFiles: progress.totalFiles,
        };
      });
    })
      .then((unlisten) => {
        if (isDisposed) {
          unlisten();
          return;
        }

        unlistenProgress = unlisten;
      })
      .catch((error: unknown) => {
        console.error("Could not listen for split progress.", error);
      });

    return () => {
      isDisposed = true;
      unlistenProgress?.();
    };
  }, []);

  useEffect(() => {
    setSplitState({ status: "idle" });
    setFullPreview(null);
    previousCutsRef.current = new Set(document.cutBeforePages);
    detailFailedPagesRef.current.clear();
    detailPreviewsRef.current = {};
    detailBackgroundCursorRef.current = 1;
    detailFilePathRef.current = document.filePath;
    detailPageIdsRef.current = document.pages.map((page) => page.id);
    detailPagesRef.current = document.pages;
    detailPriorityPagesRef.current.clear();
    detailPriorityQueueRef.current = [];
    smallPreviewCompleteRef.current = false;
    setDetailPriorityActive(false);
    setDetailPreviewVersion((version) => version + 1);
  }, [document.id, renderQualitySignature]);

  const queueDetailPriorityPage = useCallback((pageNumber: number, placement: "append" | "prepend" = "prepend") => {
    const page = detailPagesRef.current[pageNumber - 1];
    if (!page) {
      return false;
    }

    if (detailPreviewsRef.current[page.id] || detailPriorityPagesRef.current.has(page.id)) {
      return false;
    }

    detailFailedPagesRef.current.delete(page.id);
    detailPriorityPagesRef.current.add(page.id);
    const queuedPages = detailPriorityQueueRef.current.filter((queuedPageId) => queuedPageId !== page.id);
    detailPriorityQueueRef.current = placement === "append" ? [...queuedPages, page.id] : [page.id, ...queuedPages];
    setDetailPriorityActive(true);
    return true;
  }, []);

  const requestDetailPreview = useCallback(
    (pageNumber: number) => {
      queueDetailPriorityPage(pageNumber);
    },
    [queueDetailPriorityPage],
  );

  const handleSmallPreviewComplete = useCallback(() => {
    smallPreviewCompleteRef.current = true;
  }, []);

  useEffect(() => {
    smallPreviewCompleteRef.current = false;
  }, [pageCacheSignature]);

  useEffect(() => {
    const previousPageIds = detailPageIdsRef.current;
    const previousPageIdSet = new Set(previousPageIds);
    const currentPageIds = document.pages.map((page) => page.id);
    const currentPageIdSet = new Set(currentPageIds);
    let shouldRefreshPreviewVersion = false;

    detailFilePathRef.current = document.filePath;
    detailPagesRef.current = document.pages;
    detailPageIdsRef.current = currentPageIds;

    for (const pageId of Object.keys(detailPreviewsRef.current)) {
      if (!currentPageIdSet.has(pageId)) {
        delete detailPreviewsRef.current[pageId];
        shouldRefreshPreviewVersion = true;
      }
    }

    for (const pageId of [...detailFailedPagesRef.current]) {
      if (!currentPageIdSet.has(pageId)) {
        detailFailedPagesRef.current.delete(pageId);
      }
    }

    detailPriorityQueueRef.current = detailPriorityQueueRef.current.filter((pageId) => {
      const isStillValid = currentPageIdSet.has(pageId);
      if (!isStillValid) {
        detailPriorityPagesRef.current.delete(pageId);
      }

      return isStillValid;
    });

    if (detailBackgroundCursorRef.current > document.pages.length + 1) {
      detailBackgroundCursorRef.current = document.pages.length + 1;
    }

    for (const page of document.pages) {
      if (!previousPageIdSet.has(page.id) && queueDetailPriorityPage(page.pageNumber, "append")) {
        shouldRefreshPreviewVersion = true;
      }
    }

    if (detailPriorityQueueRef.current.length === 0) {
      setDetailPriorityActive(false);
    }

    if (shouldRefreshPreviewVersion) {
      startTransition(() => {
        setDetailPreviewVersion((version) => version + 1);
      });
    }
  }, [document.filePath, document.pages, queueDetailPriorityPage]);

  useEffect(() => {
    detailRunRef.current += 1;
    startTransition(() => {
      setDetailPreviewVersion((version) => version + 1);
    });

    if (!detailFilePathRef.current || detailPagesRef.current.length === 0) {
      return;
    }

    const runId = detailRunRef.current;
    let isCancelled = false;

    async function renderDetailCache() {
      while (!isCancelled && detailRunRef.current === runId) {
        if (fileWriteRunningRef.current || splitRunningRef.current) {
          setDetailPriorityActive(false);
          await sleep(DETAIL_IDLE_DELAY_MS);
          continue;
        }

        const priorityPageId = detailPriorityQueueRef.current.shift();
        const pageNumbers: number[] = [];

        if (priorityPageId !== undefined) {
          detailPriorityPagesRef.current.delete(priorityPageId);
          const priorityPage = detailPagesRef.current.find((page) => page.id === priorityPageId);

          if (priorityPage && !detailPreviewsRef.current[priorityPage.id]) {
            detailFailedPagesRef.current.delete(priorityPage.id);
            pageNumbers.push(priorityPage.pageNumber);
          }
        } else if (smallPreviewCompleteRef.current) {
          const pages = detailPagesRef.current;

          while (detailBackgroundCursorRef.current <= pages.length && pageNumbers.length < DETAIL_BACKGROUND_BATCH_SIZE) {
            const pageNumber = detailBackgroundCursorRef.current;
            detailBackgroundCursorRef.current += 1;
            const page = pages[pageNumber - 1];

            if (!page || detailPreviewsRef.current[page.id] || detailFailedPagesRef.current.has(page.id)) {
              continue;
            }

            pageNumbers.push(pageNumber);
          }
        }

        if (pageNumbers.length === 0) {
          if (detailPriorityQueueRef.current.length === 0) {
            setDetailPriorityActive(false);
          }

          await sleep(DETAIL_IDLE_DELAY_MS);
          continue;
        }

        let pagesToRender: PdfPage[] = [];

        try {
          const pages = detailPagesRef.current;
          const sourcePath = detailFilePathRef.current;
          if (!sourcePath) {
            await sleep(DETAIL_IDLE_DELAY_MS);
            continue;
          }

          pagesToRender = pageNumbers
            .map((pageNumber) => pages[pageNumber - 1])
            .filter((page): page is PdfPage => Boolean(page));
          const renderedPreviews = await renderDocumentPages(sourcePath, pagesToRender, renderQuality.detailWidth, {
            jpegQuality: renderQuality.detailJpegQuality,
            renderLane: "zoom",
          });
          if (isCancelled || detailRunRef.current !== runId) {
            return;
          }

          const pageIdsByNumber = new Map(pagesToRender.map((page) => [page.pageNumber, page.id]));
          const livePageIds = new Set(detailPagesRef.current.map((page) => page.id));
          const renderedPageIds = new Set<string>();
          for (const preview of renderedPreviews) {
            const pageId = pageIdsByNumber.get(preview.pageNumber);
            if (!pageId || !livePageIds.has(pageId)) {
              continue;
            }

            renderedPageIds.add(pageId);
            detailPreviewsRef.current[pageId] = preview;
          }

          for (const page of pagesToRender) {
            if (!renderedPageIds.has(page.id)) {
              detailFailedPagesRef.current.add(page.id);
            }
          }
        } catch (error: unknown) {
          if (isCancelled || detailRunRef.current !== runId) {
            return;
          }

          console.error("Detail preview render failed.", error);
          for (const page of pagesToRender) {
            detailFailedPagesRef.current.add(page.id);
          }
        }

        startTransition(() => {
          setDetailPreviewVersion((version) => version + 1);
        });

        if (detailPriorityQueueRef.current.length === 0) {
          setDetailPriorityActive(false);
        }
      }
    }

    void renderDetailCache();

    return () => {
      isCancelled = true;
    };
  }, [document.id, renderQuality.detailJpegQuality, renderQuality.detailWidth]);

  const hoveredPageNumber = hovered?.page.pageNumber ?? null;
  const hoveredPage = hoveredPageNumber === null ? null : (document.pages.find((page) => page.pageNumber === hoveredPageNumber) ?? null);
  const detailPreviewForHovered = hoveredPage === null ? null : (detailPreviewsRef.current[hoveredPage.id] ?? null);

  useEffect(() => {
    if (!document.filePath || !document.hoverZoomEnabled || hoveredPageNumber === null) {
      return;
    }

    requestDetailPreview(hoveredPageNumber);
  }, [document.filePath, document.hoverZoomEnabled, hoveredPageNumber, requestDetailPreview]);

  const resolvedFullPreview = useMemo(() => {
    if (!fullPreview) {
      return null;
    }

    const page =
      document.pages.find((candidate) => candidate.id === fullPreview.page.id) ??
      document.pages.find((candidate) => candidate.pageNumber === fullPreview.page.pageNumber) ??
      fullPreview.page;
    const detailPreview = detailPreviewsRef.current[page.id];
    const preview = detailPreview ?? fullPreview.preview;

    return {
      ...fullPreview,
      page,
      preview,
      status: preview ? "ready" : detailFailedPagesRef.current.has(page.id) ? "error" : fullPreview.status,
    } satisfies FullPreviewState;
  }, [detailPreviewVersion, document.pages, fullPreview]);

  const handlePageHover = useCallback((page: PdfPage, point: { x: number; y: number }, preview: PdfPagePreview | null) => {
    pendingHoverRef.current = { page, preview, x: point.x, y: point.y };

    if (hoverFrameRef.current !== null) {
      return;
    }

    hoverFrameRef.current = window.requestAnimationFrame(() => {
      hoverFrameRef.current = null;
      setHovered(pendingHoverRef.current);
    });
  }, []);

  const handlePageHoverEnd = useCallback(() => {
    pendingHoverRef.current = null;

    if (hoverFrameRef.current !== null) {
      window.cancelAnimationFrame(hoverFrameRef.current);
      hoverFrameRef.current = null;
    }

    setHovered(null);
  }, []);

  const focusPreviewPage = useCallback(
    (pageNumber: number) => {
      const safePageNumber = Math.min(Math.max(1, pageNumber), document.pages.length);
      dispatch({ type: "select-page", pageNumber: safePageNumber, selectionMode: "single" });
      setPageScrollTarget(safePageNumber);
    },
    [dispatch, document.pages.length],
  );

  const openFullPreviewPage = useCallback(
    (pageNumber: number, initialTool: DetailTool = "hand") => {
      const page = document.pages[pageNumber - 1];

      if (!page) {
        return;
      }

      focusPreviewPage(pageNumber);
      const preview = detailPreviewsRef.current[page.id] ?? null;
      setFullPreview({ initialTool, page, preview, status: preview ? "ready" : "loading" });

      if (!document.filePath) {
        setFullPreview({ initialTool, page, preview, status: preview ? "ready" : "error" });
        return;
      }

      if (!preview) {
        requestDetailPreview(pageNumber);
      }
    },
    [document.filePath, document.pages, focusPreviewPage, requestDetailPreview],
  );

  const handleOpenFullPreview = useCallback(
    (page: PdfPage) => {
      openFullPreviewPage(page.pageNumber);
    },
    [openFullPreviewPage],
  );

  const handleRotateFullPreview = useCallback(
    (pageNumber: number) => {
      dispatch({ type: "rotate-page", pageNumber, degrees: 90 });
      setSaveState({ status: "idle" });
    },
    [dispatch],
  );

  const handleToggleCutBeforePage = useCallback(
    (pageNumber: number) => {
      if (pageNumber <= 1) {
        return;
      }

      dispatch({ type: "toggle-cut", beforePage: pageNumber });
      focusPreviewPage(pageNumber);
    },
    [dispatch, focusPreviewPage],
  );

  const handleCloseFullPreview = useCallback(() => {
    setFullPreview(null);
  }, []);

  const handleAddPagePaintEdit = useCallback(
    (pageNumber: number, edit: PdfPagePaintEdit) => {
      dispatch({ type: "add-page-paint-edit", pageNumber, edit });
      setSaveState({ status: "idle" });
    },
    [dispatch],
  );

  const handleUndoPagePaintEdit = useCallback(
    (pageNumber: number) => {
      dispatch({ type: "undo-page-paint-edit", pageNumber });
      setSaveState({ status: "idle" });
    },
    [dispatch],
  );

  const handleRemovePagePaintEdit = useCallback(
    (pageNumber: number, editId: string) => {
      dispatch({ type: "remove-page-paint-edit", pageNumber, editId });
      setSaveState({ status: "idle" });
    },
    [dispatch],
  );

  const handleUpdatePagePaintEdit = useCallback(
    (pageNumber: number, edit: PdfPagePaintEdit) => {
      dispatch({ type: "update-page-paint-edit", pageNumber, edit });
      setSaveState({ status: "idle" });
    },
    [dispatch],
  );

  const handleSelectRenderQuality = useCallback(
    (preset: RenderQualityPreset) => {
      dispatch({ type: "set-render-quality-preset", preset });
    },
    [dispatch],
  );

  const handleChangeCustomRenderQuality = useCallback(
    (settings: RenderQualitySettings) => {
      dispatch({ type: "set-custom-render-quality", settings });
    },
    [dispatch],
  );

  useEffect(() => {
    if (isTauri() || !document.isDirty) {
      return;
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [document.isDirty]);

  useEffect(() => {
    if (!guardWindowClose) {
      return;
    }

    let isDisposed = false;
    let unlistenClose: (() => void) | null = null;

    void getCurrentWindow()
      .onCloseRequested((event) => {
        if (closeBypassRef.current) {
          return;
        }

        if (document.isDirty) {
          event.preventDefault();
          setCloseConfirmationOpen(true);
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
  }, [document.isDirty, guardWindowClose]);

  const handleOpenSplitOutputDir = useCallback(async (outputDir: string) => {
    try {
      await openOutputFolder(outputDir);
    } catch (error: unknown) {
      setSplitState({ status: "error", message: getFriendlyLoadError(error) });
    }
  }, []);

  async function saveCurrentDocument(): Promise<boolean> {
    if (!document.filePath) {
      setSaveState({ status: "error", message: "Open a real PDF before saving. Demo files cannot be saved." });
      return false;
    }

    if (!document.isDirty) {
      return true;
    }

    if (busyJob) {
      setSaveState({ status: "error", message: getBusyJobMessage(busyJob, "save") });
      return false;
    }

    const jobId = createSplitRunId();
    if (!onBeginBusyJob({ fileName: document.fileName, id: jobId, kind: "save", tabId })) {
      setSaveState({ status: "error", message: "Another PDF is being saved or split. Please wait." });
      return false;
    }

    setSaveState({ status: "running" });

    try {
      const metadata = await savePdfEdits(document);
      dispatch({ type: "save-complete", metadata });
      setSaveState({ status: "success" });
      return true;
    } catch (error: unknown) {
      setSaveState({ status: "error", message: getFriendlyLoadError(error) });
      return false;
    } finally {
      onEndBusyJob(jobId);
    }
  }

  async function closeCurrentWindow() {
    closeBypassRef.current = true;
    setCloseConfirmationOpen(false);

    try {
      await getCurrentWindow().close();
      if (isTauri()) {
        window.setTimeout(() => {
          void exit(0).catch(() => {
            closeBypassRef.current = false;
          });
        }, 160);
      }
    } catch (error: unknown) {
      if (isTauri()) {
        try {
          await exit(0);
          return;
        } catch {
          closeBypassRef.current = false;
          setSaveState({ status: "error", message: getFriendlyLoadError(error) });
        }
      } else {
        closeBypassRef.current = false;
        setSaveState({ status: "error", message: getFriendlyLoadError(error) });
      }
    }
  }

  async function handleSaveAndCloseWindow() {
    const saved = await saveCurrentDocument();

    if (saved) {
      await closeCurrentWindow();
    }
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveCurrentDocument();
        return;
      }

      if (isTypingTarget(event.target)) {
        return;
      }

      if (fullPreview || settingsOpen || deleteConfirmation || closeConfirmationOpen) {
        return;
      }

      if (event.code === "Space") {
        event.preventDefault();
        openFullPreviewPage(document.lastSelectedPageNumber);
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r") {
        event.preventDefault();
        handleRotateSelected(90);
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "m") {
        event.preventDefault();
        dispatch({ type: "toggle-selected-page-marks" });
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        const undoTargetPageNumber = document.previewUndoStack.at(-1)?.focusPageNumber ?? null;
        dispatch({ type: "undo-preview-edit" });
        if (undoTargetPageNumber !== null) {
          setPageScrollTarget(undoTargetPageNumber);
        }
        setSaveState({ status: "idle" });
        return;
      }

      if (event.key === "Delete") {
        event.preventDefault();
        handleDeleteSelectedPages();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  function handlePickPdf() {
    onPickPdf();
  }

  function handlePageEdited() {
    setSaveState({ status: "idle" });
  }

  function handleRotateSelected(degrees: 90 | 180 | 270) {
    dispatch({ type: "rotate-selected", degrees });
    handlePageEdited();
  }

  async function handleInsertPages() {
    if (!document.filePath) {
      setSaveState({ status: "error", message: "Open a real PDF before inserting pages." });
      return;
    }

    try {
      const paths = await pickInsertFilePaths();
      if (paths.length === 0) {
        return;
      }

      const pages = await readInsertPages(paths);
      dispatch({ type: "insert-pages-after-selection", pages });
      setSaveState({ status: "idle" });
    } catch (error: unknown) {
      setSaveState({ status: "error", message: getFriendlyLoadError(error) });
    }
  }

  function requestDeletePages(pageNumbers: number[]) {
    const uniquePageNumbers = [...new Set(pageNumbers)].filter((pageNumber) => pageNumber >= 1 && pageNumber <= document.pages.length);
    if (uniquePageNumbers.length === 0) {
      return;
    }

    if (uniquePageNumbers.length >= document.pages.length) {
      setSaveState({ status: "error", message: "Cannot delete every page in the PDF." });
      return;
    }

    setDeleteConfirmation({ pageNumbers: uniquePageNumbers });
  }

  function handleDeleteSelectedPages() {
    requestDeletePages([...document.selectedPages]);
  }

  function confirmDeletePages() {
    if (!deleteConfirmation || deleteConfirmation.pageNumbers.length === 0) {
      setDeleteConfirmation(null);
      return;
    }

    if (deleteConfirmation.pageNumbers.length >= document.pages.length) {
      setDeleteConfirmation(null);
      setSaveState({ status: "error", message: "Cannot delete every page in the PDF." });
      return;
    }

    dispatch({ type: "delete-pages", pageNumbers: deleteConfirmation.pageNumbers });
    setDeleteConfirmation(null);
    setSaveState({ status: "idle" });
  }

  function cancelDeletePages() {
    setDeleteConfirmation(null);
  }

  async function resolveSplitOutputOptions() {
    if (document.splitOutputMode !== "customFolder") {
      return {
        customFolderPath: document.splitCustomOutputFolder,
        mode: document.splitOutputMode,
      };
    }

    if (document.splitCustomOutputFolder) {
      return {
        customFolderPath: document.splitCustomOutputFolder,
        mode: document.splitOutputMode,
      };
    }

    const folder = await pickSplitOutputFolderPath();
    if (!folder) {
      return null;
    }

    dispatch({ type: "set-split-custom-output-folder", folder });
    return {
      customFolderPath: folder,
      mode: document.splitOutputMode,
    };
  }

  async function handleSelectSplitOutputMode(mode: SplitOutputMode) {
    if (mode !== "customFolder") {
      dispatch({ type: "set-split-output-mode", mode });
      setSplitLocationMenuOpen(false);
      return;
    }

    const folder = document.splitCustomOutputFolder ?? (await pickSplitOutputFolderPath());
    setSplitLocationMenuOpen(false);
    if (!folder) {
      return;
    }

    dispatch({ type: "set-split-output-mode", mode });
    dispatch({ type: "set-split-custom-output-folder", folder });
  }

  async function handleChooseSplitOutputFolder() {
    const folder = await pickSplitOutputFolderPath();
    if (!folder) {
      return;
    }

    dispatch({ type: "set-split-output-mode", mode: "customFolder" });
    dispatch({ type: "set-split-custom-output-folder", folder });
  }

  async function handleSplit() {
    if (!document.filePath) {
      setSplitState({ status: "error", message: "Open a real PDF before splitting. Demo files cannot be exported." });
      return;
    }

    if (sortedCuts.length === 0) {
      setSplitState({ status: "error", message: "Choose at least one split line between pages." });
      return;
    }

    if (busyJob) {
      setSplitState({ status: "error", message: getBusyJobMessage(busyJob, "split") });
      return;
    }

    const outputOptions = await resolveSplitOutputOptions();
    if (!outputOptions) {
      return;
    }

    const runId = createSplitRunId();
    if (!onBeginBusyJob({ fileName: document.fileName, id: runId, kind: "split", tabId })) {
      setSplitState({ status: "error", message: "Another PDF is being saved or split. Please wait." });
      return;
    }

    setSplitState({ status: "running", completedFiles: 0, runId, totalFiles: sortedCuts.length + 1 });

    try {
      const result = await splitPdfDocument(document, sortedCuts, runId, outputOptions);
      setSplitState({ status: "success", result });
    } catch (error) {
      setSplitState({ status: "error", message: getFriendlyLoadError(error) });
    } finally {
      onEndBusyJob(runId);
    }
  }

  return (
    <main className="editor-shell">
      <header className="editor-topbar">
        <div className="document-title is-compact">
          <span>
            {document.pages.length} pages - {formatBytes(document.sizeBytes)}
            {document.selectedPages.size > 1 ? ` - ${document.selectedPages.size} selected` : null}
            {saveState.status === "error" ? ` - ${saveState.message}` : null}
            {saveState.status === "success" ? " - Saved" : null}
          </span>
        </div>
        <div className="topbar-actions">
          <button className="soft-button" type="button" onClick={handlePickPdf}>
            <FolderOpen size={18} />
            Open
          </button>
          <button className="primary-action compact" type="button" disabled={!document.isDirty || saveState.status === "running" || Boolean(busyJob)} onClick={() => void saveCurrentDocument()}>
            <Save size={18} />
            {saveState.status === "running" ? "Saving..." : "Save"}
          </button>
        </div>
      </header>

      <div className={`editor-layout ${document.detailPanelVisible ? "" : "is-detail-collapsed"}`}>
        <aside className="tool-rail" aria-label="PDF tools">
          <button className="rail-tool is-active" type="button" aria-label="Select pages">
            <MousePointer2 size={19} />
          </button>
          <button
            className={`rail-tool ${document.hoverZoomEnabled ? "is-active" : ""}`}
            type="button"
            aria-label="Hover magnifier"
            onClick={() => dispatch({ type: "toggle-hover-zoom" })}
          >
            <Search size={19} />
          </button>
          <button className="rail-tool" type="button" aria-label="Rotate left" title="Rotate selected left" onClick={() => handleRotateSelected(270)}>
            <RotateCcw size={19} />
          </button>
          <button className="rail-tool" type="button" aria-label="Rotate right" title="Rotate selected right (Ctrl+R)" onClick={() => handleRotateSelected(90)}>
            <RotateCw size={19} />
          </button>
          <button className="rail-tool" type="button" aria-label="Insert pages" title="Insert pages" onClick={() => void handleInsertPages()}>
            <FilePlus2 size={19} />
          </button>
          <button
            className={`rail-tool ${selectedPagesMarked ? "is-active is-marked" : ""}`}
            type="button"
            aria-label={selectedPagesMarked ? "Unmark selected pages" : "Mark selected pages"}
            title={selectedPagesMarked ? "Unmark selected (Ctrl+M)" : "Mark selected (Ctrl+M)"}
            onClick={() => dispatch({ type: "toggle-selected-page-marks" })}
          >
            <Bookmark size={19} />
          </button>
          <button className="rail-tool danger" type="button" aria-label="Delete selected pages" title="Delete selected (Delete)" onClick={handleDeleteSelectedPages}>
            <Trash2 size={19} />
          </button>
        </aside>

        <section className="page-workspace">
          <PageGrid
            document={document}
            dispatch={dispatch}
            onSmallPreviewComplete={handleSmallPreviewComplete}
            onOpenFullPreview={handleOpenFullPreview}
            onHover={handlePageHover}
            onHoverEnd={handlePageHoverEnd}
            onPageEdited={handlePageEdited}
            onRequestDeletePage={(pageNumber) => requestDeletePages([pageNumber])}
            onScrolledToPage={() => setPageScrollTarget(null)}
            pausePreviewLoading={detailPriorityActive || fileWriteRunning}
            renderQuality={renderQuality}
            scrollToPageNumber={pageScrollTarget}
          />

          {hovered && document.hoverZoomEnabled ? <Magnifier hover={hovered} zoomPreview={detailPreviewForHovered} /> : null}
          {resolvedFullPreview ? (
            <FullPreviewOverlay
              pageCount={document.pages.length}
              state={resolvedFullPreview}
              onAddPaintEdit={handleAddPagePaintEdit}
              onClose={handleCloseFullPreview}
              onPageChange={openFullPreviewPage}
              onRemovePaintEdit={handleRemovePagePaintEdit}
              onRotateClockwise={handleRotateFullPreview}
              onToggleCutBeforePage={handleToggleCutBeforePage}
              onUndoPaintEdit={handleUndoPagePaintEdit}
              onUpdatePaintEdit={handleUpdatePagePaintEdit}
            />
          ) : null}
          {isFileDragging ? <div className="drop-overlay">Drop PDF to open</div> : null}
          {loadState.status === "error" ? <div className="editor-error">{loadState.message}</div> : null}
        </section>

        {document.detailPanelVisible ? (
          <aside className="detail-panel">
            <div className="detail-panel-header">
              <label className={`scale-control is-panel ${document.thumbnailLayout !== "grid" ? "is-disabled" : ""}`}>
                Thumbnail
                <input
                  disabled={document.thumbnailLayout !== "grid"}
                  min={THUMBNAIL_SCALE_MIN}
                  max={THUMBNAIL_SCALE_MAX}
                  step={THUMBNAIL_SCALE_STEP}
                  type="range"
                  value={document.thumbnailScale}
                  onChange={(event) => {
                    dispatch({ type: "set-thumbnail-scale", scale: Number(event.currentTarget.value) });
                    if (document.thumbnailLayout !== "grid") {
                      dispatch({ type: "set-thumbnail-layout", layout: "grid" });
                    }
                  }}
                />
              </label>
              <div className="thumbnail-layout-control" aria-label="Thumbnail layout">
                {THUMBNAIL_LAYOUT_OPTIONS.map((option) => (
                  <button
                    key={option.mode}
                    className={document.thumbnailLayout === option.mode ? "is-active" : ""}
                    type="button"
                    title={option.title}
                    onClick={() => dispatch({ type: "set-thumbnail-layout", layout: option.mode })}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <button
                className={`panel-toggle ${settingsOpen ? "is-active" : ""}`}
                type="button"
                aria-label="Preview settings"
                title="Preview settings"
                onClick={() => setSettingsOpen((isOpen) => !isOpen)}
              >
                <Settings size={18} />
              </button>
              <button
                className="panel-toggle"
                type="button"
                aria-label="Hide details panel"
                title="Hide details panel"
                onClick={() => dispatch({ type: "toggle-detail-panel" })}
              >
                <Menu size={18} />
              </button>
            </div>
            <section className="panel-block split-control-panel">
              <label className="check-row">
                <input
                  ref={eachPageSplitCheckboxRef}
                  checked={isEachPageSplit}
                  disabled={totalPossibleCuts === 0}
                  type="checkbox"
                  onChange={() => dispatch({ type: "toggle-each-page-split" })}
                />
                <span>Each page as a separate file</span>
              </label>
              <div className="cut-list" ref={cutListRef}>
                {sortedCuts.length === 0 ? (
                  <p>No split points yet.</p>
                ) : (
                  splitSegments.map((segment) => (
                    <button
                      className="cut-point-row"
                      data-cut-before-page={segment.cutBeforePage ?? undefined}
                      key={`${segment.index}:${segment.startPage}:${segment.endPage}`}
                      type="button"
                      title={`${segment.fileName} - Pages ${segment.startPage}-${segment.endPage}`}
                      onClick={() => focusPreviewPage(segment.startPage)}
                    >
                      <span className="cut-point-index">{segment.index}</span>
                      <span className="cut-point-copy">
                        <strong>{segment.fileName}</strong>
                        <small>Pages {segment.startPage}-{segment.endPage}</small>
                      </span>
                      {segment.cutBeforePage ? (
                        <span
                          className="cut-point-remove"
                          role="button"
                          tabIndex={-1}
                          title={`Remove split before page ${segment.cutBeforePage}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            dispatch({ type: "toggle-cut", beforePage: segment.cutBeforePage ?? 0 });
                          }}
                        >
                          <X size={16} />
                        </span>
                      ) : null}
                    </button>
                  ))
                )}
              </div>
              <div className="split-location-control">
                <label id="split-output-mode-label">Files location</label>
                <div
                  ref={splitLocationMenuRef}
                  className={`split-location-picker ${splitLocationMenuOpen ? "is-open" : ""}`}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setSplitLocationMenuOpen(false);
                    }
                  }}
                >
                  <button
                    className="split-location-trigger"
                    type="button"
                    aria-expanded={splitLocationMenuOpen}
                    aria-haspopup="menu"
                    aria-labelledby="split-output-mode-label"
                    disabled={splitState.status === "running"}
                    title={`${splitOutputOption.label}: ${splitOutputDescription}`}
                    onClick={() => setSplitLocationMenuOpen((isOpen) => !isOpen)}
                  >
                    <span className="split-location-icon">
                      <FolderOpen size={18} />
                    </span>
                    <span className="split-location-copy">
                      <strong>{splitOutputOption.label}</strong>
                      <small>{splitOutputDescription}</small>
                    </span>
                    <ChevronDown size={17} />
                  </button>
                  {splitLocationMenuOpen ? (
                    <div className="split-location-menu" role="menu" aria-label="Files location">
                      {SPLIT_OUTPUT_OPTION_LIST.map((option) => (
                        <button
                          key={option.mode}
                          className={option.mode === document.splitOutputMode ? "is-active" : ""}
                          type="button"
                          role="menuitemradio"
                          aria-checked={option.mode === document.splitOutputMode}
                          title={`${option.label}: ${option.description}`}
                          onClick={() => void handleSelectSplitOutputMode(option.mode)}
                        >
                          <span>
                            <strong>{option.label}</strong>
                            <small>{option.description}</small>
                          </span>
                          {option.mode === document.splitOutputMode ? <Check size={16} /> : null}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                {document.splitOutputMode === "customFolder" ? (
                  <button
                    className="split-location-folder"
                    type="button"
                    disabled={splitState.status === "running"}
                    title={document.splitCustomOutputFolder ?? "Choose output folder"}
                    onClick={() => void handleChooseSplitOutputFolder()}
                  >
                    {document.splitCustomOutputFolder ? compactPath(document.splitCustomOutputFolder) : "Choose output folder"}
                  </button>
                ) : null}
              </div>
              <button className="primary-action full" type="button" disabled={!canSplit} onClick={handleSplit}>
                <Scissors size={18} />
                {splitState.status === "running" ? "Splitting..." : "Split PDF"}
              </button>
            </section>
          </aside>
        ) : (
          <aside className="detail-panel-mini">
            <button
              className={`panel-toggle is-collapsed ${settingsOpen ? "is-active" : ""}`}
              type="button"
              aria-label="Preview settings"
              title="Preview settings"
              onClick={() => setSettingsOpen((isOpen) => !isOpen)}
            >
              <Settings size={18} />
            </button>
            <button
              className="panel-toggle is-collapsed"
              type="button"
              aria-label="Show details panel"
              title="Show details panel"
              onClick={() => dispatch({ type: "toggle-detail-panel" })}
            >
              <Menu size={18} />
            </button>
            <button className="mini-split-button" type="button" disabled={!canSplit} aria-label="Split PDF" title="Split PDF" onClick={handleSplit}>
              <Scissors size={19} />
            </button>
          </aside>
        )}

        {settingsOpen ? (
          <RenderQualityPanel
            activePreset={document.renderQualityPreset}
            customQuality={document.customRenderQuality}
            isDetailPanelVisible={document.detailPanelVisible}
            onCustomChange={handleChangeCustomRenderQuality}
            onClose={() => setSettingsOpen(false)}
            onSelect={handleSelectRenderQuality}
          />
        ) : null}

        <SplitToast
          state={splitState}
          onClose={() => setSplitState({ status: "idle" })}
          onOpenOutputDir={handleOpenSplitOutputDir}
        />
        <SaveToast state={saveState} onClose={() => setSaveState({ status: "idle" })} />
        {deleteConfirmation ? (
          <DeleteConfirmDialog count={deleteConfirmation.pageNumbers.length} onCancel={cancelDeletePages} onConfirm={confirmDeletePages} />
        ) : null}
        {closeConfirmationOpen ? (
          <CloseConfirmDialog
            isSaving={saveState.status === "running"}
            onCancel={() => setCloseConfirmationOpen(false)}
            onDiscard={() => void closeCurrentWindow()}
            onSaveAndClose={() => void handleSaveAndCloseWindow()}
          />
        ) : null}
      </div>
    </main>
  );
}

function RenderQualityPanel({
  activePreset,
  customQuality,
  isDetailPanelVisible,
  onCustomChange,
  onClose,
  onSelect,
}: {
  activePreset: RenderQualityPreset;
  customQuality: RenderQualitySettings;
  isDetailPanelVisible: boolean;
  onCustomChange: (settings: RenderQualitySettings) => void;
  onClose: () => void;
  onSelect: (preset: RenderQualityPreset) => void;
}) {
  const [customDraft, setCustomDraft] = useState(() => renderQualityToDraft(customQuality));

  useEffect(() => {
    setCustomDraft(renderQualityToDraft(customQuality));
  }, [customQuality]);

  const commitCustomField = useCallback(
    (field: keyof RenderQualityDraft) => {
      const nextValue = Number(customDraft[field]);
      if (!Number.isFinite(nextValue)) {
        setCustomDraft(renderQualityToDraft(customQuality));
        return;
      }

      onCustomChange({
        ...customQuality,
        [field]: nextValue,
        label: "Custom",
      });
    },
    [customDraft, customQuality, onCustomChange],
  );

  const updateCustomField = useCallback((field: keyof RenderQualityDraft, value: string) => {
    setCustomDraft((draft) => ({ ...draft, [field]: value }));
  }, []);

  const handleCustomKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Enter") {
        return;
      }

      event.currentTarget.blur();
    },
    [],
  );

  return (
    <div className={`render-settings-panel ${isDetailPanelVisible ? "" : "is-mini-panel"}`}>
      <div className="render-settings-header">
        <strong>Preview quality</strong>
        <button type="button" aria-label="Close preview settings" onClick={onClose}>
          <X size={17} />
        </button>
      </div>
      <div className="render-quality-options">
        {FIXED_RENDER_QUALITY_OPTIONS.map(([presetId, preset]) => (
          <button
            className={presetId === activePreset ? "is-active" : ""}
            key={presetId}
            type="button"
            onClick={() => onSelect(presetId)}
          >
            <span>{preset.label}</span>
            <small>
              Small {preset.smallWidth}px/q{preset.smallJpegQuality} - Detail {preset.detailWidth}px/q{preset.detailJpegQuality}
            </small>
          </button>
        ))}
        <button
          className={activePreset === "custom" ? "is-active" : ""}
          type="button"
          onClick={() => onSelect("custom")}
        >
          <span>Custom</span>
          <small>
            Small {customQuality.smallWidth}px/q{customQuality.smallJpegQuality} - Detail {customQuality.detailWidth}px/q
            {customQuality.detailJpegQuality}
          </small>
        </button>
        {activePreset === "custom" ? (
          <div className="render-custom-grid">
            <RenderQualityInput
              label="Small px"
              max={RENDER_QUALITY_LIMITS.smallWidthMax}
              min={RENDER_QUALITY_LIMITS.smallWidthMin}
              value={customDraft.smallWidth}
              onBlur={() => commitCustomField("smallWidth")}
              onChange={(value) => updateCustomField("smallWidth", value)}
              onFocus={() => onSelect("custom")}
              onKeyDown={handleCustomKeyDown}
            />
            <RenderQualityInput
              label="Small q"
              max={RENDER_QUALITY_LIMITS.smallJpegQualityMax}
              min={RENDER_QUALITY_LIMITS.smallJpegQualityMin}
              value={customDraft.smallJpegQuality}
              onBlur={() => commitCustomField("smallJpegQuality")}
              onChange={(value) => updateCustomField("smallJpegQuality", value)}
              onFocus={() => onSelect("custom")}
              onKeyDown={handleCustomKeyDown}
            />
            <RenderQualityInput
              label="Detail px"
              max={RENDER_QUALITY_LIMITS.detailWidthMax}
              min={RENDER_QUALITY_LIMITS.detailWidthMin}
              value={customDraft.detailWidth}
              onBlur={() => commitCustomField("detailWidth")}
              onChange={(value) => updateCustomField("detailWidth", value)}
              onFocus={() => onSelect("custom")}
              onKeyDown={handleCustomKeyDown}
            />
            <RenderQualityInput
              label="Detail q"
              max={RENDER_QUALITY_LIMITS.detailJpegQualityMax}
              min={RENDER_QUALITY_LIMITS.detailJpegQualityMin}
              value={customDraft.detailJpegQuality}
              onBlur={() => commitCustomField("detailJpegQuality")}
              onChange={(value) => updateCustomField("detailJpegQuality", value)}
              onFocus={() => onSelect("custom")}
              onKeyDown={handleCustomKeyDown}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

type RenderQualityDraft = Omit<RenderQualitySettings, "label">;

function renderQualityToDraft(settings: RenderQualitySettings): Record<keyof RenderQualityDraft, string> {
  return {
    detailJpegQuality: String(settings.detailJpegQuality),
    detailWidth: String(settings.detailWidth),
    smallJpegQuality: String(settings.smallJpegQuality),
    smallWidth: String(settings.smallWidth),
  };
}

function RenderQualityInput({
  label,
  max,
  min,
  onBlur,
  onChange,
  onFocus,
  onKeyDown,
  value,
}: {
  label: string;
  max: number;
  min: number;
  onBlur: () => void;
  onChange: (value: string) => void;
  onFocus: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  value: string;
}) {
  return (
    <label className="render-custom-field">
      <span>{label}</span>
      <input
        max={max}
        min={min}
        type="number"
        value={value}
        onBlur={onBlur}
        onChange={(event) => onChange(event.currentTarget.value)}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
      />
    </label>
  );
}

function SplitToast({
  onClose,
  onOpenOutputDir,
  state,
}: {
  onClose: () => void;
  onOpenOutputDir: (outputDir: string) => Promise<void>;
  state: SplitState;
}) {
  if (state.status === "idle") {
    return null;
  }

  if (state.status === "running") {
    const progressText = `${state.completedFiles}/${state.totalFiles}`;

    return (
      <aside className="split-toast is-running" role="status" aria-live="polite">
        <div className="split-toast-rail">
          <Clock3 size={26} />
        </div>
        <div className="split-toast-body">
          <strong>Processing document... ({progressText})</strong>
          <div className="split-toast-progress" aria-label={`Splitting ${progressText} files`}>
            <span style={{ width: `${getProgressPercent(state.completedFiles, state.totalFiles)}%` }} />
          </div>
        </div>
      </aside>
    );
  }

  if (state.status === "success") {
    const totalSize = state.result.files.reduce((sum, file) => sum + file.sizeBytes, 0);

    return (
      <aside className="split-toast is-success" role="status" aria-live="polite">
        <div className="split-toast-rail">
          <CheckCircle2 size={28} />
        </div>
        <div className="split-toast-body">
          <strong>Success!</strong>
          <span>
            {state.result.files.length} files split successfully - {formatBytes(totalSize)}
          </span>
          {state.result.sourceDeleteError ? <small className="split-toast-warning">Original was not deleted: {state.result.sourceDeleteError}</small> : null}
          <button className="toast-link" type="button" onClick={() => void onOpenOutputDir(state.result.outputDir)}>
            Open in folder
          </button>
        </div>
        <button className="split-toast-close" type="button" aria-label="Close notification" onClick={onClose}>
          <X size={20} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="split-toast is-error" role="alert">
      <div className="split-toast-rail">
        <CircleAlert size={28} />
      </div>
      <div className="split-toast-body">
        <strong>Could not split PDF</strong>
        <span>{state.message}</span>
      </div>
      <button className="split-toast-close" type="button" aria-label="Close notification" onClick={onClose}>
        <X size={20} />
      </button>
    </aside>
  );
}

function SaveToast({ onClose, state }: { onClose: () => void; state: SaveState }) {
  if (state.status === "idle") {
    return null;
  }

  if (state.status === "running") {
    return (
      <aside className="split-toast save-toast is-running" role="status" aria-live="polite">
        <div className="split-toast-rail">
          <Clock3 size={26} />
        </div>
        <div className="split-toast-body">
          <strong>Saving changes...</strong>
          <div className="split-toast-progress" aria-label="Saving PDF changes">
            <span style={{ width: "58%" }} />
          </div>
        </div>
      </aside>
    );
  }

  if (state.status === "success") {
    return (
      <aside className="split-toast save-toast is-success" role="status" aria-live="polite">
        <div className="split-toast-rail">
          <CheckCircle2 size={28} />
        </div>
        <div className="split-toast-body">
          <strong>Saved!</strong>
          <span>Changes saved to the original file</span>
        </div>
        <button className="split-toast-close" type="button" aria-label="Close notification" onClick={onClose}>
          <X size={20} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="split-toast save-toast is-error" role="alert">
      <div className="split-toast-rail">
        <CircleAlert size={28} />
      </div>
      <div className="split-toast-body">
        <strong>Could not save PDF</strong>
        <span>{state.message}</span>
      </div>
      <button className="split-toast-close" type="button" aria-label="Close notification" onClick={onClose}>
        <X size={20} />
      </button>
    </aside>
  );
}

function compactPath(path: string): string {
  const maxLength = 42;
  if (path.length <= maxLength) {
    return path;
  }

  return `...${path.slice(-maxLength)}`;
}

function DeleteConfirmDialog({ count, onCancel, onConfirm }: { count: number; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="confirm-backdrop" role="presentation" onMouseDown={onCancel}>
      <section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-confirm-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="confirm-icon">
          <CircleAlert size={24} />
        </div>
        <div className="confirm-copy">
          <h2 id="delete-confirm-title">Delete selected pages?</h2>
          <p>
            {count} page{count > 1 ? "s" : ""} will be removed from the workspace. Press Save or Ctrl+S to overwrite the original PDF.
          </p>
        </div>
        <div className="confirm-actions">
          <button className="secondary-action" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button className="danger-action" type="button" autoFocus onClick={onConfirm}>
            Delete
          </button>
        </div>
      </section>
    </div>
  );
}

function CloseConfirmDialog({
  isSaving,
  onCancel,
  onDiscard,
  onSaveAndClose,
}: {
  isSaving: boolean;
  onCancel: () => void;
  onDiscard: () => void;
  onSaveAndClose: () => void;
}) {
  return (
    <div className="confirm-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        className="confirm-dialog is-neutral"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="close-confirm-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="confirm-icon">
          <CircleAlert size={24} />
        </div>
        <div className="confirm-copy">
          <h2 id="close-confirm-title">Save changes before closing?</h2>
          <p>This PDF has unsaved edits. Save it now, or close and discard the changes.</p>
        </div>
        <div className="confirm-actions">
          <button className="secondary-action" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button className="danger-action" type="button" onClick={onDiscard}>
            Close without saving
          </button>
          <button className="primary-action" type="button" disabled={isSaving} autoFocus onClick={onSaveAndClose}>
            {isSaving ? "Saving..." : "Save and close"}
          </button>
        </div>
      </section>
    </div>
  );
}

function Magnifier({ hover, zoomPreview }: { hover: HoverState; zoomPreview: PdfPagePreview | null }) {
  const isWide = zoomPreview ? adjustedPreviewRatio(hover.page, zoomPreview) > 1 : false;
  const width = isWide ? 760 : MAGNIFIER_WIDTH;
  const height = isWide ? 560 : MAGNIFIER_HEIGHT;
  const renderedWidth = Math.min(width, Math.max(1, window.innerWidth - MAGNIFIER_VIEWPORT_PADDING * 2));
  const renderedHeight = Math.min(height, Math.max(1, window.innerHeight - MAGNIFIER_VIEWPORT_PADDING * 2));
  const left = placeMagnifierAxis(hover.x, renderedWidth, window.innerWidth);
  const top = placeMagnifierAxis(hover.y, renderedHeight, window.innerHeight);

  return (
    <div className={`magnifier ${isWide ? "is-wide" : ""}`} style={{ left, top }}>
      <div className="magnifier-paper">{zoomPreview ? <MagnifierImage page={hover.page} preview={zoomPreview} /> : <MagnifierLoading />}</div>
    </div>
  );
}

function MagnifierLoading() {
  return (
    <div className="magnifier-loading" aria-label="Loading preview">
      <span className="preview-spinner" />
    </div>
  );
}

function MagnifierImage({ page, preview }: { page: PdfPage; preview: PdfPagePreview }) {
  const isSideways = page.rotation === 90 || page.rotation === 270;
  const sourceRatio = preview.width / preview.height;
  const displayRatioValue = adjustedPreviewRatio(page, preview);
  const displayRatio = isSideways ? `${preview.height} / ${preview.width}` : `${preview.width} / ${preview.height}`;

  return (
    <div
      className={`magnifier-preview ${isSideways ? "is-sideways" : ""} ${page.deleted ? "is-deleted" : ""} ${page.tinted ? "is-tinted" : ""}`}
      style={
        {
          "--page-ratio": displayRatio,
          "--page-ratio-value": displayRatioValue,
          "--source-ratio": sourceRatio,
          "--rotation": `${page.rotation}deg`,
        } as CSSProperties
      }
    >
      <img alt={`Page ${page.pageNumber}`} decoding="async" draggable={false} src={preview.dataUrl} />
    </div>
  );
}

function adjustedPreviewRatio(page: PdfPage, preview: PdfPagePreview): number {
  const sourceRatio = preview.width / preview.height;
  return page.rotation === 90 || page.rotation === 270 ? preview.height / preview.width : sourceRatio;
}

function placeMagnifierAxis(anchor: number, size: number, viewportSize: number): number {
  const forward = anchor + MAGNIFIER_OFFSET;
  const backward = anchor - size - MAGNIFIER_OFFSET;
  const max = viewportSize - size - MAGNIFIER_VIEWPORT_PADDING;
  const hasForwardRoom = forward + size <= viewportSize - MAGNIFIER_VIEWPORT_PADDING;
  const next = hasForwardRoom ? forward : backward;

  return clamp(next, MAGNIFIER_VIEWPORT_PADDING, max);
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }

  return Math.min(max, Math.max(min, value));
}

function createSplitRunId(): string {
  return `split-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getBusyJobMessage(job: EditorFileWriteJob, requestedKind: "save" | "split"): string {
  const runningAction = job.kind === "split" ? "splitting" : "saving";
  const requestedAction = requestedKind === "split" ? "split another PDF" : "save another PDF";
  return `${job.fileName} is ${runningAction}. Please wait before you ${requestedAction}.`;
}

function getProgressPercent(completedFiles: number, totalFiles: number): number {
  if (totalFiles <= 0) {
    return 0;
  }

  return clamp((completedFiles / totalFiles) * 100, 0, 100);
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

function createPaintEditId(): string {
  return `paint-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizedRect(start: NormalizedPoint, end: NormalizedPoint): DraftCoverRect {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);

  return {
    height: Math.abs(end.y - start.y),
    width: Math.abs(end.x - start.x),
    x,
    y,
  };
}

function normalizePageRotation(rotation: number): 0 | 90 | 180 | 270 {
  const normalizedRotation = ((rotation % 360) + 360) % 360;

  if (normalizedRotation === 90 || normalizedRotation === 180 || normalizedRotation === 270) {
    return normalizedRotation;
  }

  return 0;
}

function visualPointToPagePoint(point: NormalizedPoint, rotation: number): NormalizedPoint {
  switch (normalizePageRotation(rotation)) {
    case 90:
      return { x: point.y, y: 1 - point.x };
    case 180:
      return { x: 1 - point.x, y: 1 - point.y };
    case 270:
      return { x: 1 - point.y, y: point.x };
    default:
      return point;
  }
}

function pagePointToVisualPoint(point: NormalizedPoint, rotation: number): NormalizedPoint {
  switch (normalizePageRotation(rotation)) {
    case 90:
      return { x: 1 - point.y, y: point.x };
    case 180:
      return { x: 1 - point.x, y: 1 - point.y };
    case 270:
      return { x: point.y, y: 1 - point.x };
    default:
      return point;
  }
}

function unstraightenVisualPoint(point: NormalizedPoint, degrees: number, scale: number, ratio: number): NormalizedPoint {
  if (Math.abs(degrees) <= DETAIL_STRAIGHTEN_EPSILON && Math.abs(scale - 1) <= DETAIL_STRAIGHTEN_EPSILON) {
    return point;
  }

  const radians = -degrees * (Math.PI / 180);
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const width = Math.max(0.01, ratio);
  const height = 1;
  const dx = ((point.x - 0.5) * width) / scale;
  const dy = ((point.y - 0.5) * height) / scale;

  return {
    x: 0.5 + (dx * cos - dy * sin) / width,
    y: 0.5 + (dx * sin + dy * cos) / height,
  };
}

function rectFromVisualRect(rect: DraftCoverRect, rotation: number): DraftCoverRect {
  const start = visualPointToPagePoint({ x: rect.x, y: rect.y }, rotation);
  const end = visualPointToPagePoint({ x: rect.x + rect.width, y: rect.y + rect.height }, rotation);
  return normalizedRect(start, end);
}

function rectToVisualRect(rect: DraftCoverRect, rotation: number): DraftCoverRect {
  const start = pagePointToVisualPoint({ x: rect.x, y: rect.y }, rotation);
  const end = pagePointToVisualPoint({ x: rect.x + rect.width, y: rect.y + rect.height }, rotation);
  return normalizedRect(start, end);
}

function rectStyle(rect: DraftCoverRect): CSSProperties {
  return {
    height: `${rect.height * 100}%`,
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.width * 100}%`,
  };
}

function resizeTextVisualRect(origin: DraftCoverRect, handle: TextResizeHandle, dx: number, dy: number): DraftCoverRect {
  const nextWidth = handle === "south" ? origin.width : clamp(origin.width + dx, 0.06, 1 - origin.x);
  const nextHeight = handle === "east" ? origin.height : clamp(origin.height + dy, 0.035, 1 - origin.y);

  return {
    height: nextHeight,
    width: nextWidth,
    x: origin.x,
    y: origin.y,
  };
}

function clampCropRect(rect: DraftCoverRect): DraftCoverRect {
  const width = clamp(rect.width, DETAIL_MIN_CROP_SIZE, 1);
  const height = clamp(rect.height, DETAIL_MIN_CROP_SIZE, 1);

  return {
    height,
    width,
    x: clamp(rect.x, 0, 1 - width),
    y: clamp(rect.y, 0, 1 - height),
  };
}

function getActiveCropRect(edits: PdfPagePaintEdit[]): DraftCoverRect {
  for (let index = edits.length - 1; index >= 0; index -= 1) {
    const edit = edits[index];
    if (edit?.type === "crop") {
      return clampCropRect(edit);
    }
  }

  return FULL_CROP_RECT;
}

function getStraightenDegrees(edits: PdfPagePaintEdit[]): number {
  const totalDegrees = edits.reduce((sum, edit) => sum + (edit.type === "straighten" ? edit.degrees : 0), 0);
  return clamp(totalDegrees, -DETAIL_STRAIGHTEN_MAX_DEGREES, DETAIL_STRAIGHTEN_MAX_DEGREES);
}

function resizeCropRect(origin: DraftCoverRect, handle: CropResizeHandle, dx: number, dy: number): DraftCoverRect {
  if (handle === "move") {
    return clampCropRect({
      ...origin,
      x: origin.x + dx,
      y: origin.y + dy,
    });
  }

  let left = origin.x;
  let right = origin.x + origin.width;
  let top = origin.y;
  let bottom = origin.y + origin.height;
  const normalizedHandle = handle.toLowerCase();

  if (normalizedHandle.includes("west")) {
    left = clamp(origin.x + dx, 0, right - DETAIL_MIN_CROP_SIZE);
  }

  if (normalizedHandle.includes("east")) {
    right = clamp(origin.x + origin.width + dx, left + DETAIL_MIN_CROP_SIZE, 1);
  }

  if (normalizedHandle.includes("north")) {
    top = clamp(origin.y + dy, 0, bottom - DETAIL_MIN_CROP_SIZE);
  }

  if (normalizedHandle.includes("south")) {
    bottom = clamp(origin.y + origin.height + dy, top + DETAIL_MIN_CROP_SIZE, 1);
  }

  return clampCropRect({
    height: bottom - top,
    width: right - left,
    x: left,
    y: top,
  });
}

function isSameCropRect(left: DraftCoverRect, right: DraftCoverRect): boolean {
  return (
    Math.abs(left.x - right.x) <= 0.0005 &&
    Math.abs(left.y - right.y) <= 0.0005 &&
    Math.abs(left.width - right.width) <= 0.0005 &&
    Math.abs(left.height - right.height) <= 0.0005
  );
}

function formatDegreesInput(degrees: number): string {
  return Number.isInteger(degrees) ? String(degrees) : degrees.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function sanitizeDegreesInput(value: string): string {
  const normalizedValue = value.replace(",", ".").replace(/[^\d.+-]/g, "");
  const sign = normalizedValue.startsWith("-") ? "-" : normalizedValue.startsWith("+") ? "+" : "";
  const unsignedValue = normalizedValue.replace(/[+-]/g, "");
  const [integerPart = "", ...decimalParts] = unsignedValue.split(".");
  const decimalPart = decimalParts.join("");

  if (decimalParts.length === 0) {
    return `${sign}${integerPart}`;
  }

  return `${sign}${integerPart}.${decimalPart}`;
}

function getStraightenScale(degrees: number, ratio: number): number {
  const radians = Math.abs(degrees) * (Math.PI / 180);
  if (radians <= DETAIL_STRAIGHTEN_EPSILON) {
    return 1;
  }

  const width = Math.max(0.01, ratio);
  const height = 1;
  const rotatedWidth = width * Math.cos(radians) + height * Math.sin(radians);
  const rotatedHeight = width * Math.sin(radians) + height * Math.cos(radians);
  return Math.min(width / rotatedWidth, height / rotatedHeight) * 0.985;
}

function clampFloatingPanelPosition(position: FloatingPanelPosition): FloatingPanelPosition {
  const maxX = Math.max(8, window.innerWidth - 440);
  const maxY = Math.max(8, window.innerHeight - 80);

  return {
    x: clamp(position.x, 8, maxX),
    y: clamp(position.y, 8, maxY),
  };
}

function readTextPanelPosition(): FloatingPanelPosition {
  try {
    const rawValue = window.localStorage.getItem(TEXT_PANEL_POSITION_STORAGE_KEY);
    if (!rawValue) {
      return DEFAULT_TEXT_PANEL_POSITION;
    }

    const parsedValue = JSON.parse(rawValue) as Partial<FloatingPanelPosition>;
    if (typeof parsedValue.x !== "number" || typeof parsedValue.y !== "number") {
      return DEFAULT_TEXT_PANEL_POSITION;
    }

    return clampFloatingPanelPosition({ x: parsedValue.x, y: parsedValue.y });
  } catch {
    return DEFAULT_TEXT_PANEL_POSITION;
  }
}

function saveTextPanelPosition(position: FloatingPanelPosition) {
  window.localStorage.setItem(TEXT_PANEL_POSITION_STORAGE_KEY, JSON.stringify(clampFloatingPanelPosition(position)));
}

function readStraightenPanelPosition(): FloatingPanelPosition {
  try {
    const rawValue = window.localStorage.getItem(STRAIGHTEN_PANEL_POSITION_STORAGE_KEY);
    if (!rawValue) {
      return DEFAULT_STRAIGHTEN_PANEL_POSITION;
    }

    const parsedValue = JSON.parse(rawValue) as Partial<FloatingPanelPosition>;
    if (typeof parsedValue.x !== "number" || typeof parsedValue.y !== "number") {
      return DEFAULT_STRAIGHTEN_PANEL_POSITION;
    }

    return clampFloatingPanelPosition({ x: parsedValue.x, y: parsedValue.y });
  } catch {
    return DEFAULT_STRAIGHTEN_PANEL_POSITION;
  }
}

function saveStraightenPanelPosition(position: FloatingPanelPosition) {
  window.localStorage.setItem(STRAIGHTEN_PANEL_POSITION_STORAGE_KEY, JSON.stringify(clampFloatingPanelPosition(position)));
}

function FullPreviewOverlay({
  onAddPaintEdit,
  pageCount,
  state,
  onClose,
  onPageChange,
  onRemovePaintEdit,
  onRotateClockwise,
  onToggleCutBeforePage,
  onUndoPaintEdit,
  onUpdatePaintEdit,
}: {
  onAddPaintEdit: (pageNumber: number, edit: PdfPagePaintEdit) => void;
  pageCount: number;
  state: FullPreviewState;
  onClose: () => void;
  onPageChange: (pageNumber: number) => void;
  onRemovePaintEdit: (pageNumber: number, editId: string) => void;
  onRotateClockwise: (pageNumber: number) => void;
  onToggleCutBeforePage: (pageNumber: number) => void;
  onUndoPaintEdit: (pageNumber: number) => void;
  onUpdatePaintEdit: (pageNumber: number, edit: PdfPagePaintEdit) => void;
}) {
  const canGoPrevious = state.page.pageNumber > 1;
  const canGoNext = state.page.pageNumber < pageCount;
  const currentPageText = String(state.page.pageNumber);
  const [pageInput, setPageInput] = useState(currentPageText);
  const [tool, setTool] = useState<DetailTool>(state.initialTool ?? "hand");
  const [coverColor, setCoverColor] = useState("#ffffff");
  const [textStyle, setTextStyle] = useState<DetailTextStyle>({
    bold: false,
    color: "#111827",
    fontFamily: "Arial",
    fontSize: 13,
    italic: false,
    textAlign: "left",
    underline: false,
  });
  const [textPanelPosition, setTextPanelPosition] = useState<FloatingPanelPosition>(() => readTextPanelPosition());
  const [straightenPanelPosition, setStraightenPanelPosition] = useState<FloatingPanelPosition>(() => readStraightenPanelPosition());
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [draftCover, setDraftCover] = useState<DraftCoverRect | null>(null);
  const [draftCrop, setDraftCrop] = useState<DraftCoverRect | null>(null);
  const [draftTextRect, setDraftTextRect] = useState<DraftCoverRect | null>(null);
  const [activeTextEditId, setActiveTextEditId] = useState<string | null>(null);
  const [straightenInput, setStraightenInput] = useState("");
  const hitboxRef = useRef<HTMLDivElement | null>(null);
  const pageFrameRef = useRef<HTMLDivElement | null>(null);
  const coverColorRef = useRef("#ffffff");
  const skipNextStraightenBlurRef = useRef(false);
  const pointerStateRef = useRef<
    | {
        handle: CropResizeHandle;
        kind: "crop";
        originCrop: DraftCoverRect;
        originVisualCrop: DraftCoverRect;
        pointerId: number;
        startVisual: NormalizedPoint;
      }
    | {
        kind: "crop-draw";
        pointerId: number;
        start: NormalizedPoint;
      }
    | {
        color: string;
        kind: "cover";
        pointerId: number;
        start: NormalizedPoint;
      }
    | {
        kind: "text";
        pointerId: number;
        start: NormalizedPoint;
      }
    | {
        edit: Extract<PdfPagePaintEdit, { type: "text" }>;
        kind: "text-move";
        pointerId: number;
        startPoint: NormalizedPoint;
      }
    | {
        edit: Extract<PdfPagePaintEdit, { type: "text" }>;
        handle: TextResizeHandle;
        kind: "text-resize";
        originVisualRect: DraftCoverRect;
        pointerId: number;
        startVisual: NormalizedPoint;
      }
    | {
        kind: "text-panel-move";
        originX: number;
        originY: number;
        panelX: number;
        panelY: number;
        pointerId: number;
      }
    | {
        kind: "straighten-panel-move";
        originX: number;
        originY: number;
        panelX: number;
        panelY: number;
        pointerId: number;
      }
    | {
        kind: "pan";
        originX: number;
        originY: number;
        panX: number;
        panY: number;
        pointerId: number;
      }
    | null
  >(null);
  const activeTextEdit = state.page.paintEdits.find(
    (edit): edit is Extract<PdfPagePaintEdit, { type: "text" }> => edit.type === "text" && edit.id === activeTextEditId,
  );
  const activeCrop = useMemo(() => getActiveCropRect(state.page.paintEdits), [state.page.paintEdits]);
  const workingCrop = tool === "crop" ? (draftCrop ?? activeCrop) : activeCrop;
  const contentCrop = tool === "crop" ? FULL_CROP_RECT : activeCrop;
  const straightenDegrees = useMemo(() => getStraightenDegrees(state.page.paintEdits), [state.page.paintEdits]);
  const displayRatioValue = state.preview ? adjustedPreviewRatio(state.page, state.preview) : 1;
  const straightenScale = getStraightenScale(straightenDegrees, displayRatioValue);

  useEffect(() => {
    setPageInput(currentPageText);
  }, [currentPageText]);

  useEffect(() => {
    setStraightenInput(Math.abs(straightenDegrees) <= DETAIL_STRAIGHTEN_EPSILON ? "" : formatDegreesInput(straightenDegrees));
  }, [straightenDegrees]);

  useEffect(() => {
    coverColorRef.current = coverColor;
  }, [coverColor]);

  useEffect(() => {
    if (!activeTextEdit) {
      return;
    }

    setTextStyle({
      bold: activeTextEdit.bold,
      color: activeTextEdit.color,
      fontFamily: activeTextEdit.fontFamily,
      fontSize: activeTextEdit.fontSize,
      italic: activeTextEdit.italic,
      textAlign: activeTextEdit.textAlign,
      underline: activeTextEdit.underline,
    });
  }, [activeTextEdit]);

  useEffect(() => {
    setDraftCover(null);
    setDraftCrop(null);
    setDraftTextRect(null);
    setActiveTextEditId(null);
    setPageInput(currentPageText);
    setStraightenInput("");
    setPan({ x: 0, y: 0 });
    setZoom(1);
    pointerStateRef.current = null;
  }, [currentPageText]);

  useEffect(() => {
    const handlePreviewKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const isTyping = isTypingTarget(event.target);

      if (!isTyping && event.key === "Escape") {
        event.preventDefault();
        if (activeTextEdit) {
          finishActiveTextEdit();
          return;
        }

        if (tool !== "hand") {
          chooseTool("hand");
        } else {
          closePreview();
        }
        return;
      }

      if (!isTyping && event.code === "Space") {
        event.preventDefault();
        return;
      }

      if (!isTyping && event.key === "ArrowLeft") {
        event.preventDefault();
        if (canGoPrevious) {
          goToPage(state.page.pageNumber - 1);
        }
        return;
      }

      if (!isTyping && event.key === "ArrowRight") {
        event.preventDefault();
        if (canGoNext) {
          goToPage(state.page.pageNumber + 1);
        }
        return;
      }

      if ((event.ctrlKey || event.metaKey) && key === "r") {
        event.preventDefault();
        onRotateClockwise(state.page.pageNumber);
        return;
      }

      if ((event.ctrlKey || event.metaKey) && key === "p") {
        event.preventDefault();
        chooseTool("cover");
        return;
      }

      if (!event.ctrlKey && !event.metaKey && !event.altKey && !isTyping && key === "p") {
        event.preventDefault();
        void handlePickCoverColor();
        return;
      }

      if ((event.ctrlKey || event.metaKey) && key === "t") {
        event.preventDefault();
        chooseTool("text");
        return;
      }

      if ((event.ctrlKey || event.metaKey) && key === "q") {
        event.preventDefault();
        chooseTool("straighten");
        return;
      }

      if ((event.ctrlKey || event.metaKey) && key === "l") {
        event.preventDefault();
        onToggleCutBeforePage(state.page.pageNumber);
        return;
      }

      if ((event.ctrlKey || event.metaKey) && key === "z") {
        event.preventDefault();
        onUndoPaintEdit(state.page.pageNumber);
        setActiveTextEditId(null);
        return;
      }

      if (tool === "crop" && event.key === "Enter" && !isTyping) {
        event.preventDefault();
        commitPendingCrop();
        return;
      }

      if (!event.ctrlKey && !event.metaKey && !event.altKey && !isTyping) {
        if (key === "c") {
          event.preventDefault();
          chooseTool("crop");
        }
      }
    };

    window.addEventListener("keydown", handlePreviewKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handlePreviewKeyDown, { capture: true });
  }, [
    activeCrop,
    activeTextEdit,
    canGoNext,
    canGoPrevious,
    draftCrop,
    onRotateClockwise,
    onToggleCutBeforePage,
    onUndoPaintEdit,
    state.page.pageNumber,
    tool,
  ]);

  function commitPageInput() {
    const parsedPage = Number.parseInt(pageInput, 10);

    if (!Number.isFinite(parsedPage)) {
      setPageInput(currentPageText);
      return;
    }

    const nextPage = clamp(parsedPage, 1, pageCount);
    setPageInput(String(nextPage));

    if (nextPage !== state.page.pageNumber) {
      goToPage(nextPage);
    }
  }

  function discardActiveEmptyTextEdit(): boolean {
    if (!activeTextEdit || activeTextEdit.text.trim().length > 0) {
      return false;
    }

    onRemovePaintEdit(state.page.pageNumber, activeTextEdit.id);
    setActiveTextEditId(null);
    return true;
  }

  function finishActiveTextEdit() {
    if (!discardActiveEmptyTextEdit()) {
      setActiveTextEditId(null);
    }
  }

  function chooseTool(nextTool: DetailTool) {
    discardActiveEmptyTextEdit();
    setDraftCrop(nextTool === "crop" ? activeCrop : null);
    setTool(nextTool);
  }

  function closePreview() {
    discardActiveEmptyTextEdit();
    onClose();
  }

  function updateTextStyle(patch: Partial<DetailTextStyle>) {
    if (activeTextEdit) {
      const nextStyle = {
        bold: activeTextEdit.bold,
        color: activeTextEdit.color,
        fontFamily: activeTextEdit.fontFamily,
        fontSize: activeTextEdit.fontSize,
        italic: activeTextEdit.italic,
        textAlign: activeTextEdit.textAlign,
        underline: activeTextEdit.underline,
        ...patch,
      };

      setTextStyle(nextStyle);
      onUpdatePaintEdit(state.page.pageNumber, {
        ...activeTextEdit,
        ...nextStyle,
      });
      return;
    }

    setTextStyle((currentStyle) => ({ ...currentStyle, ...patch }));
  }

  function createTextEdit(rect: DraftCoverRect): Extract<PdfPagePaintEdit, { type: "text" }> {
    return {
      ...textStyle,
      height: Math.max(0.04, rect.height),
      id: createPaintEditId(),
      text: "",
      type: "text",
      width: Math.max(0.08, rect.width),
      x: rect.x,
      y: rect.y,
    };
  }

  function updateTextEdit(edit: Extract<PdfPagePaintEdit, { type: "text" }>) {
    onUpdatePaintEdit(state.page.pageNumber, edit);
  }

  function commitCropEdit(rect: DraftCoverRect) {
    const nextCrop = clampCropRect(rect);
    const previousCrop = getActiveCropRect(state.page.paintEdits);

    if (isSameCropRect(previousCrop, nextCrop)) {
      return;
    }

    onAddPaintEdit(state.page.pageNumber, {
      ...nextCrop,
      id: createPaintEditId(),
      type: "crop",
    });
  }

  function commitPendingCrop() {
    const nextCrop = clampCropRect(draftCrop ?? activeCrop);
    commitCropEdit(nextCrop);
    setDraftCrop(null);
    setTool("hand");
  }

  function addStraightenDegrees(delta: number) {
    const safeDelta = clamp(delta, -DETAIL_STRAIGHTEN_MAX_DEGREES, DETAIL_STRAIGHTEN_MAX_DEGREES);
    if (Math.abs(safeDelta) <= DETAIL_STRAIGHTEN_EPSILON) {
      return;
    }

    onAddPaintEdit(state.page.pageNumber, {
      degrees: safeDelta,
      id: createPaintEditId(),
      type: "straighten",
    });
  }

  function commitStraightenInput() {
    const sanitizedInput = sanitizeDegreesInput(straightenInput);
    if (!sanitizedInput || sanitizedInput === "+" || sanitizedInput === "-" || sanitizedInput === "." || sanitizedInput === "+." || sanitizedInput === "-.") {
      setStraightenInput(Math.abs(straightenDegrees) <= DETAIL_STRAIGHTEN_EPSILON ? "" : formatDegreesInput(straightenDegrees));
      return;
    }

    const parsedDegrees = Number.parseFloat(sanitizedInput);
    if (!Number.isFinite(parsedDegrees)) {
      setStraightenInput(Math.abs(straightenDegrees) <= DETAIL_STRAIGHTEN_EPSILON ? "" : formatDegreesInput(straightenDegrees));
      return;
    }

    const nextDegrees = clamp(parsedDegrees, -DETAIL_STRAIGHTEN_MAX_DEGREES, DETAIL_STRAIGHTEN_MAX_DEGREES);
    setStraightenInput(formatDegreesInput(nextDegrees));
    addStraightenDegrees(nextDegrees - straightenDegrees);
  }

  function handleStraightenInputBlur() {
    if (skipNextStraightenBlurRef.current) {
      skipNextStraightenBlurRef.current = false;
      return;
    }

    commitStraightenInput();
  }

  function goToPage(pageNumber: number) {
    discardActiveEmptyTextEdit();
    setActiveTextEditId(null);
    onPageChange(pageNumber);
  }

  function getVisualPointFromClient(clientX: number, clientY: number): NormalizedPoint | null {
    const bounds = pageFrameRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      return null;
    }

    const point = {
      x: clamp((clientX - bounds.left) / bounds.width, 0, 1),
      y: clamp((clientY - bounds.top) / bounds.height, 0, 1),
    };

    const unstraightenedPoint = unstraightenVisualPoint(point, straightenDegrees, straightenScale, displayRatioValue);
    return {
      x: clamp(unstraightenedPoint.x, 0, 1),
      y: clamp(unstraightenedPoint.y, 0, 1),
    };
  }

  function getPagePointFromClient(clientX: number, clientY: number): NormalizedPoint | null {
    const point = getVisualPointFromClient(clientX, clientY);
    if (!point) {
      return null;
    }

    return visualPointToPagePoint(point, state.page.rotation);
  }

  function getPagePoint(event: ReactPointerEvent<HTMLElement>): NormalizedPoint | null {
    return getPagePointFromClient(event.clientX, event.clientY);
  }

  function getVisualPoint(event: ReactPointerEvent<HTMLElement>): NormalizedPoint | null {
    return getVisualPointFromClient(event.clientX, event.clientY);
  }

  function setCustomCoverColor(color: string) {
    coverColorRef.current = color;
    setCoverColor(color);
  }

  function handleWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (!event.ctrlKey) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const bounds = hitboxRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      return;
    }

    const cursorX = event.clientX - bounds.left;
    const cursorY = event.clientY - bounds.top;
    const direction = event.deltaY < 0 ? 1 : -1;
    const nextZoom = clamp(zoom + direction * DETAIL_ZOOM_STEP, DETAIL_ZOOM_MIN, DETAIL_ZOOM_MAX);

    if (nextZoom <= DETAIL_ZOOM_MIN) {
      setPan({ x: 0, y: 0 });
    } else {
      const contentX = (cursorX - pan.x) / zoom;
      const contentY = (cursorY - pan.y) / zoom;
      setPan({
        x: cursorX - contentX * nextZoom,
        y: cursorY - contentY * nextZoom,
      });
    }

    setZoom(nextZoom);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!state.preview) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    event.currentTarget.setPointerCapture(event.pointerId);

    if (activeTextEdit) {
      const removedEmptyText = discardActiveEmptyTextEdit();
      if (removedEmptyText) {
        return;
      }

      setActiveTextEditId(null);
    }

    if (tool === "text") {
      const start = getPagePoint(event);
      if (!start) {
        return;
      }

      pointerStateRef.current = { kind: "text", pointerId: event.pointerId, start };
      setDraftTextRect({ height: 0, width: 0, x: start.x, y: start.y });
      return;
    }

    if (tool === "cover") {
      const start = getPagePoint(event);
      if (!start) {
        return;
      }

      pointerStateRef.current = {
        color: coverColorRef.current,
        kind: "cover",
        pointerId: event.pointerId,
        start,
      };
      setDraftCover({ height: 0, width: 0, x: start.x, y: start.y });
      return;
    }

    if (tool === "crop") {
      const start = getPagePoint(event);
      if (!start) {
        return;
      }

      pointerStateRef.current = { kind: "crop-draw", pointerId: event.pointerId, start };
      setDraftCrop({ height: 0, width: 0, x: start.x, y: start.y });
      return;
    }

    if (tool === "hand" || zoom > 1) {
      pointerStateRef.current = {
        kind: "pan",
        originX: event.clientX,
        originY: event.clientY,
        panX: pan.x,
        panY: pan.y,
        pointerId: event.pointerId,
      };
    }
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const pointerState = pointerStateRef.current;
    if (!pointerState || pointerState.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (pointerState.kind === "cover") {
      const point = getPagePoint(event);
      if (point) {
        setDraftCover(normalizedRect(pointerState.start, point));
      }
      return;
    }

    if (pointerState.kind === "crop-draw") {
      const point = getPagePoint(event);
      if (point) {
        setDraftCrop(clampCropRect(normalizedRect(pointerState.start, point)));
      }
      return;
    }

    if (pointerState.kind === "crop") {
      const point = getVisualPoint(event);
      if (point) {
        const dx = point.x - pointerState.startVisual.x;
        const dy = point.y - pointerState.startVisual.y;
        const visualCrop = resizeCropRect(pointerState.originVisualCrop, pointerState.handle, dx, dy);
        setDraftCrop(clampCropRect(rectFromVisualRect(visualCrop, state.page.rotation)));
      }
      return;
    }

    if (pointerState.kind === "text") {
      const point = getPagePoint(event);
      if (point) {
        setDraftTextRect(normalizedRect(pointerState.start, point));
      }
      return;
    }

    if (pointerState.kind === "text-move") {
      const point = getPagePoint(event);
      if (point) {
        const dx = point.x - pointerState.startPoint.x;
        const dy = point.y - pointerState.startPoint.y;
        updateTextEdit({
          ...pointerState.edit,
          x: clamp(pointerState.edit.x + dx, 0, 1 - pointerState.edit.width),
          y: clamp(pointerState.edit.y + dy, 0, 1 - pointerState.edit.height),
        });
      }
      return;
    }

    if (pointerState.kind === "text-resize") {
      const point = getVisualPoint(event);
      if (point) {
        const dx = point.x - pointerState.startVisual.x;
        const dy = point.y - pointerState.startVisual.y;
        const nextVisualRect = resizeTextVisualRect(pointerState.originVisualRect, pointerState.handle, dx, dy);
        const nextPageRect = rectFromVisualRect(nextVisualRect, state.page.rotation);
        updateTextEdit({
          ...pointerState.edit,
          height: nextPageRect.height,
          width: nextPageRect.width,
          x: clamp(nextPageRect.x, 0, 1 - nextPageRect.width),
          y: clamp(nextPageRect.y, 0, 1 - nextPageRect.height),
        });
      }
      return;
    }

    if (pointerState.kind === "text-panel-move") {
      const nextPosition = clampFloatingPanelPosition({
        x: pointerState.panelX + event.clientX - pointerState.originX,
        y: pointerState.panelY + event.clientY - pointerState.originY,
      });

      setTextPanelPosition(nextPosition);
      saveTextPanelPosition(nextPosition);
      return;
    }

    if (pointerState.kind === "straighten-panel-move") {
      const nextPosition = clampFloatingPanelPosition({
        x: pointerState.panelX + event.clientX - pointerState.originX,
        y: pointerState.panelY + event.clientY - pointerState.originY,
      });

      setStraightenPanelPosition(nextPosition);
      saveStraightenPanelPosition(nextPosition);
      return;
    }

      setPan({
        x: pointerState.panX + event.clientX - pointerState.originX,
        y: pointerState.panY + event.clientY - pointerState.originY,
      });
  }

  async function finishPointerEdit(event: ReactPointerEvent<HTMLDivElement>) {
    const pointerState = pointerStateRef.current;
    if (!pointerState || pointerState.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    pointerStateRef.current = null;

    if (pointerState.kind === "cover") {
      const end = getPagePoint(event) ?? pointerState.start;
      const rect = normalizedRect(pointerState.start, end);
      setDraftCover(null);

      if (rect.width >= DETAIL_MIN_COVER_SIZE && rect.height >= DETAIL_MIN_COVER_SIZE) {
        onAddPaintEdit(state.page.pageNumber, {
          color: pointerState.color,
          height: rect.height,
          id: createPaintEditId(),
          type: "cover",
          width: rect.width,
          x: rect.x,
          y: rect.y,
        });
      }
      return;
    }

    if (pointerState.kind === "crop-draw") {
      const end = getPagePoint(event) ?? pointerState.start;
      const rect = clampCropRect(normalizedRect(pointerState.start, end));

      if (rect.width >= DETAIL_MIN_CROP_SIZE && rect.height >= DETAIL_MIN_CROP_SIZE) {
        setDraftCrop(rect);
      } else {
        setDraftCrop(activeCrop);
      }
      return;
    }

    if (pointerState.kind === "crop") {
      const point = getVisualPoint(event) ?? pointerState.startVisual;
      const dx = point.x - pointerState.startVisual.x;
      const dy = point.y - pointerState.startVisual.y;
      const visualCrop = resizeCropRect(pointerState.originVisualCrop, pointerState.handle, dx, dy);
      setDraftCrop(clampCropRect(rectFromVisualRect(visualCrop, state.page.rotation)));
      return;
    }

    if (pointerState.kind === "text") {
      const end = getPagePoint(event) ?? pointerState.start;
      const rect = normalizedRect(pointerState.start, end);
      setDraftTextRect(null);

      const fallbackRect: DraftCoverRect = {
        height: 0.07,
        width: 0.22,
        x: clamp(pointerState.start.x, 0, 0.78),
        y: clamp(pointerState.start.y, 0, 0.93),
      };
      const textRect = rect.width >= DETAIL_MIN_COVER_SIZE && rect.height >= DETAIL_MIN_COVER_SIZE ? rect : fallbackRect;
      const edit = createTextEdit(textRect);
      onAddPaintEdit(state.page.pageNumber, edit);
      setActiveTextEditId(edit.id);
    }
  }

  async function handlePickCoverColor() {
    const EyeDropper = (window as EyeDropperWindow).EyeDropper;
    if (!EyeDropper) {
      return;
    }

    try {
      const result = await new EyeDropper().open();
      if (result.sRGBHex) {
        setCustomCoverColor(result.sRGBHex);
      }
    } catch {
      // Canceling the native picker with Esc is normal.
    }

    setTool("cover");
  }

  function handleMoveTextBoxStart(event: ReactPointerEvent<HTMLButtonElement>, edit: Extract<PdfPagePaintEdit, { type: "text" }>) {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setActiveTextEditId(edit.id);
    const startPoint = getPagePoint(event) ?? { x: edit.x, y: edit.y };
    pointerStateRef.current = {
      edit,
      kind: "text-move",
      pointerId: event.pointerId,
      startPoint,
    };
  }

  function handleResizeTextBoxStart(
    event: ReactPointerEvent<HTMLButtonElement>,
    edit: Extract<PdfPagePaintEdit, { type: "text" }>,
    handle: TextResizeHandle,
  ) {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setActiveTextEditId(edit.id);
    const originVisualRect = rectToVisualRect(edit, state.page.rotation);
    const startVisual = getVisualPoint(event) ?? { x: originVisualRect.x + originVisualRect.width, y: originVisualRect.y + originVisualRect.height };
    pointerStateRef.current = {
      edit,
      handle,
      kind: "text-resize",
      originVisualRect,
      pointerId: event.pointerId,
      startVisual,
    };
  }

  function handleMoveTextPanelStart(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerStateRef.current = {
      kind: "text-panel-move",
      originX: event.clientX,
      originY: event.clientY,
      panelX: textPanelPosition.x,
      panelY: textPanelPosition.y,
      pointerId: event.pointerId,
    };
  }

  function handleMoveStraightenPanelStart(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerStateRef.current = {
      kind: "straighten-panel-move",
      originX: event.clientX,
      originY: event.clientY,
      panelX: straightenPanelPosition.x,
      panelY: straightenPanelPosition.y,
      pointerId: event.pointerId,
    };
  }

  function handleCropHandleStart(event: ReactPointerEvent<HTMLElement>, handle: CropResizeHandle) {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    discardActiveEmptyTextEdit();
    setTool("crop");
    const originCrop = draftCrop ?? activeCrop;
    const originVisualCrop = rectToVisualRect(originCrop, state.page.rotation);
    const startVisual = getVisualPoint(event) ?? { x: originVisualCrop.x, y: originVisualCrop.y };
    pointerStateRef.current = {
      handle,
      kind: "crop",
      originCrop,
      originVisualCrop,
      pointerId: event.pointerId,
      startVisual,
    };
    setDraftCrop(originCrop);
  }

  function removeTextEdit(edit: Extract<PdfPagePaintEdit, { type: "text" }>) {
    onRemovePaintEdit(state.page.pageNumber, edit.id);
    if (activeTextEditId === edit.id) {
      setActiveTextEditId(null);
    }
  }

  const canUndoPaint = state.page.paintEdits.length > 0;
  const paintToolbar = (
    <div
      className="detail-paint-toolbar"
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <button className={tool === "hand" ? "is-active" : ""} type="button" aria-label="Pan page" title="Pan page (Space)" onClick={() => chooseTool("hand")}>
        <Hand size={18} />
      </button>
      <button className={tool === "cover" ? "is-active" : ""} type="button" aria-label="Cover with color" title="Paint (Ctrl+P)" onClick={() => chooseTool("cover")}>
        <PaintBucket size={18} />
      </button>
      <input
        aria-label="Cover color"
        title="Paint color"
        type="color"
        value={coverColor}
        onChange={(event) => setCustomCoverColor(event.currentTarget.value)}
      />
      <button
        type="button"
        aria-label="Pick color from screen"
        title="Pick color (P)"
        onClick={() => void handlePickCoverColor()}
      >
        <Pipette size={18} />
      </button>
      <button className={tool === "text" ? "is-active" : ""} type="button" aria-label="Add text" title="Text (Ctrl+T)" onClick={() => chooseTool("text")}>
        <span className="paint-letter-icon">A</span>
      </button>
      <button className={tool === "crop" ? "is-active" : ""} type="button" aria-label="Crop page" title="Crop (C)" onClick={() => chooseTool("crop")}>
        <Crop size={18} />
      </button>
      {tool === "crop" ? (
        <button className="is-confirm" type="button" aria-label="Apply crop" title="Done crop (Enter)" onClick={commitPendingCrop}>
          <Check size={18} />
        </button>
      ) : null}
      <button
        className={tool === "straighten" ? "is-active" : ""}
        type="button"
        aria-label="Straighten page"
        title="Straighten by degrees (Ctrl+Q)"
        onClick={() => chooseTool("straighten")}
      >
        <RotateCwSquare size={18} />
      </button>
      <i aria-hidden="true" />
      <button
        type="button"
        aria-label="Cut before this page"
        title={state.page.pageNumber <= 1 ? "Cannot cut before page 1" : "Cut before this page (Ctrl+L)"}
        disabled={state.page.pageNumber <= 1}
        onClick={() => onToggleCutBeforePage(state.page.pageNumber)}
      >
        <Scissors size={18} />
      </button>
      <button type="button" aria-label="Undo last paint edit" title="Undo (Ctrl+Z)" disabled={!canUndoPaint} onClick={() => onUndoPaintEdit(state.page.pageNumber)}>
        <Undo2 size={18} />
      </button>
    </div>
  );

  const straightenPanel = tool === "straighten" ? (
    <div
      className="detail-straighten-panel"
      style={{ left: straightenPanelPosition.x, top: straightenPanelPosition.y }}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerCancel={finishPointerEdit}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointerEdit}
      onWheel={(event) => event.stopPropagation()}
    >
      <div className="straighten-panel-heading">
        <button className="straighten-panel-grip" type="button" aria-label="Move straighten toolbar" title="Move straighten toolbar" onPointerDown={handleMoveStraightenPanelStart}>
          Move
        </button>
        <strong>Straighten</strong>
      </div>
      <div className="straighten-button-row">
        <button type="button" onClick={() => addStraightenDegrees(-2)}>
          -2
        </button>
        <button type="button" onClick={() => addStraightenDegrees(-1)}>
          -1
        </button>
        <button type="button" onClick={() => addStraightenDegrees(-0.5)}>
          -0.5
        </button>
        <button type="button" onClick={() => addStraightenDegrees(0.5)}>
          +0.5
        </button>
        <button type="button" onClick={() => addStraightenDegrees(1)}>
          +1
        </button>
        <button type="button" onClick={() => addStraightenDegrees(2)}>
          +2
        </button>
      </div>
      <label>
        <span>Degrees</span>
        <input
          inputMode="decimal"
          placeholder="0.5"
          type="text"
          value={straightenInput}
          onBlur={handleStraightenInputBlur}
          onChange={(event) => setStraightenInput(sanitizeDegreesInput(event.currentTarget.value))}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
              event.preventDefault();
              skipNextStraightenBlurRef.current = true;
              commitStraightenInput();
              event.currentTarget.blur();
            }

            if (event.key === "Escape") {
              event.preventDefault();
              skipNextStraightenBlurRef.current = true;
              setStraightenInput(Math.abs(straightenDegrees) <= DETAIL_STRAIGHTEN_EPSILON ? "" : formatDegreesInput(straightenDegrees));
              event.currentTarget.blur();
            }
          }}
        />
      </label>
      <button className="straighten-reset" type="button" disabled={Math.abs(straightenDegrees) <= DETAIL_STRAIGHTEN_EPSILON} onClick={() => addStraightenDegrees(-straightenDegrees)}>
        Reset
      </button>
    </div>
  ) : null;

  return (
    <div className="full-preview-overlay" role="dialog" aria-modal="true" aria-label={`Page ${state.page.pageNumber} preview`} onMouseDown={closePreview}>
      <div className="full-preview-stage">
        {tool === "text" ? (
          <div
            className="detail-text-settings-panel"
            style={{ left: textPanelPosition.x, top: textPanelPosition.y }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerCancel={finishPointerEdit}
            onPointerMove={handlePointerMove}
            onPointerUp={finishPointerEdit}
            onWheel={(event) => event.stopPropagation()}
          >
            <button className="text-panel-grip" type="button" aria-label="Move text toolbar" title="Move text toolbar" onPointerDown={handleMoveTextPanelStart}>
              ⋮⋮
            </button>
            <select aria-label="Font family" value={textStyle.fontFamily} onChange={(event) => updateTextStyle({ fontFamily: event.currentTarget.value })}>
              <option value="Arial">Arial</option>
              <option value="Tahoma">Tahoma</option>
              <option value="Times New Roman">Times</option>
            </select>
            <input
              aria-label="Text size"
              className="paint-size-input"
              inputMode="numeric"
              min={6}
              max={96}
              type="number"
              value={textStyle.fontSize}
              onChange={(event) => updateTextStyle({ fontSize: clamp(Number(event.currentTarget.value) || 13, 6, 96) })}
              onKeyDown={(event) => event.stopPropagation()}
            />
            <button className={textStyle.bold ? "is-active" : ""} type="button" aria-label="Bold" onClick={() => updateTextStyle({ bold: !textStyle.bold })}>
              B
            </button>
            <button className={textStyle.italic ? "is-active" : ""} type="button" aria-label="Italic" onClick={() => updateTextStyle({ italic: !textStyle.italic })}>
              <em>I</em>
            </button>
            <button className={textStyle.underline ? "is-active" : ""} type="button" aria-label="Underline" onClick={() => updateTextStyle({ underline: !textStyle.underline })}>
              <u>U</u>
            </button>
            <i aria-hidden="true" />
            <button className={textStyle.textAlign === "left" ? "is-active" : ""} type="button" aria-label="Align left" title="Align left" onClick={() => updateTextStyle({ textAlign: "left" })}>
              <AlignLeft size={17} />
            </button>
            <button className={textStyle.textAlign === "center" ? "is-active" : ""} type="button" aria-label="Align center" title="Align center" onClick={() => updateTextStyle({ textAlign: "center" })}>
              <AlignCenter size={17} />
            </button>
            <button className={textStyle.textAlign === "right" ? "is-active" : ""} type="button" aria-label="Align right" title="Align right" onClick={() => updateTextStyle({ textAlign: "right" })}>
              <AlignRight size={17} />
            </button>
            <input aria-label="Text color" type="color" value={textStyle.color} onChange={(event) => updateTextStyle({ color: event.currentTarget.value })} />
          </div>
        ) : null}
        <div className="full-preview-paper">
          {state.preview ? (
            <div
              className={`full-preview-hitbox detail-edit-hitbox is-tool-${tool} ${zoom > 1 ? "is-zoomed" : ""}`}
              ref={hitboxRef}
              onMouseDown={(event) => event.stopPropagation()}
              onPointerCancel={finishPointerEdit}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={finishPointerEdit}
              onWheel={handleWheel}
            >
              {paintToolbar}
              {straightenPanel}
              <EditablePreviewImage
                activeCrop={contentCrop}
                committedCrop={activeCrop}
                editingCrop={workingCrop}
                draftCover={draftCover}
                draftCoverColor={coverColor}
                page={state.page}
                pageRef={pageFrameRef}
                pan={pan}
                preview={state.preview}
                activeTextEditId={activeTextEditId}
                tool={tool}
                draftTextRect={draftTextRect}
                onCropHandleStart={handleCropHandleStart}
                onFinishTextBox={finishActiveTextEdit}
                onMoveTextBoxStart={handleMoveTextBoxStart}
                onRemoveTextBox={removeTextEdit}
                onResizeTextBoxStart={handleResizeTextBoxStart}
                onTextChange={(edit, text) => updateTextEdit({ ...edit, text })}
                straightenDegrees={straightenDegrees}
                zoom={zoom}
              />
            </div>
          ) : state.status === "error" ? (
            <div className="full-preview-hitbox" onMouseDown={(event) => event.stopPropagation()}>
              <PreviewError />
            </div>
          ) : (
            <div className="full-preview-hitbox" onMouseDown={(event) => event.stopPropagation()}>
              <MagnifierLoading />
            </div>
          )}
        </div>
        <div className="full-preview-toolbar" onMouseDown={(event) => event.stopPropagation()}>
          <button type="button" aria-label="Previous page" disabled={!canGoPrevious} onClick={() => goToPage(state.page.pageNumber - 1)}>
            <ChevronLeft size={20} />
          </button>
          <input
            aria-label="Go to page"
            className="full-preview-page-input"
            inputMode="numeric"
            type="text"
            value={pageInput}
            onBlur={commitPageInput}
            onChange={(event) => setPageInput(event.currentTarget.value.replace(/\D/g, ""))}
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                commitPageInput();
              }

              if (event.key === "Escape") {
                setPageInput(currentPageText);
                event.currentTarget.blur();
              }
            }}
          />
          <button type="button" aria-label="Next page" disabled={!canGoNext} onClick={() => goToPage(state.page.pageNumber + 1)}>
            <ChevronRight size={20} />
          </button>
          <span>of {pageCount}</span>
          <i aria-hidden="true" />
          <button type="button" aria-label="Rotate page right" onClick={() => onRotateClockwise(state.page.pageNumber)}>
            <RotateCw size={18} />
          </button>
          <button type="button" aria-label="Close preview" onClick={closePreview}>
            <X size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}

function EditablePreviewImage({
  activeCrop,
  activeTextEditId,
  committedCrop,
  draftCover,
  draftCoverColor,
  draftTextRect,
  editingCrop,
  onCropHandleStart,
  onFinishTextBox,
  onMoveTextBoxStart,
  onRemoveTextBox,
  onResizeTextBoxStart,
  onTextChange,
  page,
  pageRef,
  pan,
  preview,
  straightenDegrees,
  tool,
  zoom,
}: {
  activeCrop: DraftCoverRect;
  activeTextEditId: string | null;
  committedCrop: DraftCoverRect;
  draftCover: DraftCoverRect | null;
  draftCoverColor: string;
  draftTextRect: DraftCoverRect | null;
  editingCrop: DraftCoverRect;
  onCropHandleStart: (event: ReactPointerEvent<HTMLElement>, handle: CropResizeHandle) => void;
  onFinishTextBox: () => void;
  onMoveTextBoxStart: (event: ReactPointerEvent<HTMLButtonElement>, edit: Extract<PdfPagePaintEdit, { type: "text" }>) => void;
  onRemoveTextBox: (edit: Extract<PdfPagePaintEdit, { type: "text" }>) => void;
  onResizeTextBoxStart: (
    event: ReactPointerEvent<HTMLButtonElement>,
    edit: Extract<PdfPagePaintEdit, { type: "text" }>,
    handle: TextResizeHandle,
  ) => void;
  onTextChange: (edit: Extract<PdfPagePaintEdit, { type: "text" }>, text: string) => void;
  page: PdfPage;
  pageRef: RefObject<HTMLDivElement | null>;
  pan: { x: number; y: number };
  preview: PdfPagePreview;
  straightenDegrees: number;
  tool: DetailTool;
  zoom: number;
}) {
  const isSideways = page.rotation === 90 || page.rotation === 270;
  const sourceRatio = preview.width / preview.height;
  const displayRatioValue = adjustedPreviewRatio(page, preview);
  const displayRatio = isSideways ? `${preview.height} / ${preview.width}` : `${preview.width} / ${preview.height}`;
  const straightenScale = getStraightenScale(straightenDegrees, displayRatioValue);
  const hasCommittedCrop = !isSameCropRect(committedCrop, FULL_CROP_RECT);
  const visualActiveCrop = rectToVisualRect(activeCrop, page.rotation);
  const visualCommittedCrop = rectToVisualRect(committedCrop, page.rotation);
  const visualEditingCrop = rectToVisualRect(editingCrop, page.rotation);

  return (
    <div
      className={`editable-preview-page ${isSideways ? "is-sideways" : ""} is-tool-${tool}`}
      ref={pageRef}
      style={
        {
          "--page-ratio": displayRatio,
          "--page-ratio-value": displayRatioValue,
          "--source-ratio": sourceRatio,
          "--rotation": `${page.rotation}deg`,
          "--crop-bottom": `${(1 - visualActiveCrop.y - visualActiveCrop.height) * 100}%`,
          "--crop-left": `${visualActiveCrop.x * 100}%`,
          "--crop-right": `${(1 - visualActiveCrop.x - visualActiveCrop.width) * 100}%`,
          "--crop-top": `${visualActiveCrop.y * 100}%`,
          "--straighten": `${straightenDegrees}deg`,
          "--straighten-scale": straightenScale,
          transform: `matrix(${zoom}, 0, 0, ${zoom}, ${pan.x}, ${pan.y})`,
        } as CSSProperties
      }
    >
      <div className="editable-preview-content">
        <img alt={`Page ${page.pageNumber}`} decoding="async" draggable={false} src={preview.dataUrl} />
        <PaintEditsLayer
          activeTextEditId={activeTextEditId}
          draftCover={draftCover}
          draftCoverColor={draftCoverColor}
          draftTextRect={draftTextRect}
          edits={page.paintEdits}
          onMoveTextBoxStart={onMoveTextBoxStart}
          onFinishTextBox={onFinishTextBox}
          onRemoveTextBox={onRemoveTextBox}
          onResizeTextBoxStart={onResizeTextBoxStart}
          onTextChange={onTextChange}
          rotation={page.rotation}
        />
      </div>
      {tool !== "crop" && hasCommittedCrop ? <CommittedCropShadeLayer crop={visualCommittedCrop} /> : null}
      {tool === "crop" ? <CropEditLayer crop={visualEditingCrop} onCropHandleStart={onCropHandleStart} /> : null}
    </div>
  );
}

function PaintEditsLayer({
  activeTextEditId,
  draftCover,
  draftCoverColor,
  draftTextRect,
  edits,
  onFinishTextBox,
  onMoveTextBoxStart,
  onRemoveTextBox,
  onResizeTextBoxStart,
  onTextChange,
  rotation,
}: {
  activeTextEditId: string | null;
  draftCover: DraftCoverRect | null;
  draftCoverColor: string;
  draftTextRect: DraftCoverRect | null;
  edits: PdfPagePaintEdit[];
  onFinishTextBox: () => void;
  onMoveTextBoxStart: (event: ReactPointerEvent<HTMLButtonElement>, edit: Extract<PdfPagePaintEdit, { type: "text" }>) => void;
  onRemoveTextBox: (edit: Extract<PdfPagePaintEdit, { type: "text" }>) => void;
  onResizeTextBoxStart: (
    event: ReactPointerEvent<HTMLButtonElement>,
    edit: Extract<PdfPagePaintEdit, { type: "text" }>,
    handle: TextResizeHandle,
  ) => void;
  onTextChange: (edit: Extract<PdfPagePaintEdit, { type: "text" }>, text: string) => void;
  rotation: number;
}) {
  return (
    <div className="paint-edits-layer">
      {edits.map((edit) => {
        if (edit.type === "cover") {
          const rect = rectToVisualRect(edit, rotation);
          return (
            <span
              className="paint-cover-edit"
              key={edit.id}
              style={{
                background: edit.color,
                ...rectStyle(rect),
              }}
            />
          );
        }

        if (edit.type !== "text") {
          return null;
        }

        if (edit.id === activeTextEditId) {
          const rect = rectToVisualRect(edit, rotation);
          return (
            <div
              className="paint-text-box is-active"
              key={edit.id}
              style={rectStyle(rect)}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <button className="paint-text-box-handle" type="button" aria-label="Move text box" onPointerDown={(event) => onMoveTextBoxStart(event, edit)}>
                ⋮⋮
              </button>
              <button className="paint-text-box-delete" type="button" aria-label="Delete text box" title="Delete text box" onClick={() => onRemoveTextBox(edit)}>
                <Trash2 size={13} />
              </button>
              <button className="paint-text-box-done" type="button" aria-label="Done text box" title="Done text box" onClick={onFinishTextBox}>
                <Check size={13} />
              </button>
              <textarea
                aria-label="Text box"
                autoFocus
                value={edit.text}
                spellCheck={false}
                style={{
                  color: edit.color,
                  fontFamily: edit.fontFamily,
                  fontSize: `${edit.fontSize}px`,
                  fontStyle: edit.italic ? "italic" : "normal",
                  fontWeight: edit.bold ? 850 : 500,
                  textAlign: edit.textAlign,
                  textDecoration: edit.underline ? "underline" : "none",
                }}
                onChange={(event) => onTextChange(edit, event.currentTarget.value)}
                onKeyDown={(event) => {
                  const shortcutKey = event.key.toLowerCase();
                  if ((event.ctrlKey || event.metaKey) && (shortcutKey === "z" || shortcutKey === "s")) {
                    return;
                  }

                  if (event.key === "Escape") {
                    event.preventDefault();
                    onFinishTextBox();
                    return;
                  }

                  event.stopPropagation();
                }}
              />
              <button
                className="paint-text-resize is-east"
                type="button"
                aria-label="Resize text box width"
                title="Resize width"
                onPointerDown={(event) => onResizeTextBoxStart(event, edit, "east")}
              />
              <button
                className="paint-text-resize is-south"
                type="button"
                aria-label="Resize text box height"
                title="Resize height"
                onPointerDown={(event) => onResizeTextBoxStart(event, edit, "south")}
              />
              <button
                className="paint-text-resize is-south-east"
                type="button"
                aria-label="Resize text box"
                title="Resize text box"
                onPointerDown={(event) => onResizeTextBoxStart(event, edit, "southEast")}
              />
            </div>
          );
        }

        const rect = rectToVisualRect(edit, rotation);
        return (
          <span
            className="paint-text-edit"
            key={edit.id}
            style={{
              color: edit.color,
              fontFamily: edit.fontFamily,
              fontSize: `${edit.fontSize}px`,
              fontStyle: edit.italic ? "italic" : "normal",
              fontWeight: edit.bold ? 850 : 700,
              height: `${rect.height * 100}%`,
              left: `${rect.x * 100}%`,
              overflow: "hidden",
              textAlign: edit.textAlign,
              textDecoration: edit.underline ? "underline" : "none",
              top: `${rect.y * 100}%`,
              width: `${rect.width * 100}%`,
            }}
          >
            {edit.text}
          </span>
        );
      })}
      {draftCover ? (
        (() => {
          const rect = rectToVisualRect(draftCover, rotation);
          return (
        <span
          className="paint-cover-edit is-draft"
          style={{
            background: draftCoverColor,
            ...rectStyle(rect),
          }}
        />
          );
        })()
      ) : null}
      {draftTextRect ? (
        (() => {
          const rect = rectToVisualRect(draftTextRect, rotation);
          return (
        <span
          className="paint-text-box is-draft"
          style={rectStyle(rect)}
        />
          );
        })()
      ) : null}
    </div>
  );
}

function CommittedCropShadeLayer({ crop }: { crop: DraftCoverRect }) {
  const left = crop.x * 100;
  const top = crop.y * 100;
  const right = (1 - crop.x - crop.width) * 100;
  const bottom = (1 - crop.y - crop.height) * 100;

  return (
    <div className="committed-crop-shade-layer" aria-hidden="true">
      <span className="crop-shade is-top" style={{ height: `${top}%` }} />
      <span className="crop-shade is-right" style={{ bottom: `${bottom}%`, top: `${top}%`, width: `${right}%` }} />
      <span className="crop-shade is-bottom" style={{ height: `${bottom}%` }} />
      <span className="crop-shade is-left" style={{ bottom: `${bottom}%`, top: `${top}%`, width: `${left}%` }} />
    </div>
  );
}

function CropEditLayer({
  crop,
  onCropHandleStart,
}: {
  crop: DraftCoverRect;
  onCropHandleStart: (event: ReactPointerEvent<HTMLElement>, handle: CropResizeHandle) => void;
}) {
  const left = crop.x * 100;
  const top = crop.y * 100;
  const right = (1 - crop.x - crop.width) * 100;
  const bottom = (1 - crop.y - crop.height) * 100;

  return (
    <div className="crop-edit-layer" aria-hidden="true">
      <span className="crop-shade is-top" style={{ height: `${top}%` }} />
      <span className="crop-shade is-right" style={{ bottom: `${bottom}%`, top: `${top}%`, width: `${right}%` }} />
      <span className="crop-shade is-bottom" style={{ height: `${bottom}%` }} />
      <span className="crop-shade is-left" style={{ bottom: `${bottom}%`, top: `${top}%`, width: `${left}%` }} />
      <button
        className="crop-box"
        type="button"
        style={{
          bottom: `${bottom}%`,
          left: `${left}%`,
          right: `${right}%`,
          top: `${top}%`,
        }}
        onPointerDown={(event) => onCropHandleStart(event, "move")}
      >
        {(["northWest", "north", "northEast", "east", "southEast", "south", "southWest", "west"] as const).map((handle) => (
          <i className={`crop-handle is-${handle}`} key={handle} onPointerDown={(event) => onCropHandleStart(event, handle)} />
        ))}
      </button>
    </div>
  );
}

function PreviewError() {
  return (
    <div className="preview-error-panel" role="status">
      Cannot load preview
    </div>
  );
}

export function MockPaper({ page, large = false }: { page: PdfPage; large?: boolean }) {
  const isSideways = page.rotation === 90 || page.rotation === 270;
  const lineCount = 8 + page.previewVariant;
  const lines = Array.from({ length: lineCount }, (_, index) => (
    <i className={(index + page.pageNumber) % 4 === 0 ? "short" : ""} key={`${page.id}-line-${index}`} />
  ));

  return (
    <div
      className={`mock-paper ${large ? "is-large" : ""} ${isSideways ? "is-sideways" : ""} ${page.deleted ? "is-deleted" : ""} ${page.tinted ? "is-tinted" : ""}`}
      style={{ "--rotation": `${page.rotation}deg` } as CSSProperties}
    >
      <b />
      <div className="paper-lines">{lines.slice(0, Math.ceil(lines.length / 2))}</div>
      {page.pageNumber % 3 !== 0 ? <em /> : null}
      <div className="paper-lines">{lines.slice(Math.ceil(lines.length / 2))}</div>
      {page.pageNumber % 7 === 0 ? <strong /> : null}
    </div>
  );
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
