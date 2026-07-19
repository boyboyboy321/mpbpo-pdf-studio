import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { restrictToWindowEdges } from "@dnd-kit/modifiers";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Brush, Maximize2, RotateCw, Scissors, Trash2 } from "lucide-react";
import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type MouseEvent,
} from "react";

import type { PdfDocument, PdfPage, PdfPagePreview } from "../domain/pdf";
import type { RenderQualitySettings } from "../domain/pdfSettings";
import { getFriendlyLoadError, renderDocumentPages } from "../services/pdfLoader";
import type { DocumentAction } from "../state/documentReducer";

import { MockPaper } from "./EditorView";

type PreviewEntry =
  | { status: "loading" }
  | { status: "ready"; preview: PdfPagePreview }
  | { status: "error"; message: string };

interface DragState {
  draggedPageNumber: number;
  dropBeforePageNumber: number | null;
}

type DropPosition = "after" | "before";

const MAX_PREVIEW_BATCH_SIZE = 1;
const PREVIEW_ROW_OVERSCAN = 2;
const SCROLL_IDLE_PREVIEW_COMMIT_DELAY = 260;
const PREVIEW_PRIORITY_PAUSE_POLL_MS = 30;
const BACKGROUND_BATCH_DELAY = 12;
const ACTIVE_SCROLL_BATCH_DELAY = 90;
const PAGE_SLOT_BASE_WIDTH = 244;

interface PageGridProps {
  document: PdfDocument;
  dispatch: Dispatch<DocumentAction>;
  onSmallPreviewComplete: () => void;
  onHover: (page: PdfPage, point: { x: number; y: number }, preview: PdfPagePreview | null) => void;
  onHoverEnd: () => void;
  onOpenFullPreview: (page: PdfPage) => void;
  onOpenPaintPreview: (page: PdfPage) => void;
  onPageEdited: () => void;
  onRequestDeletePage: (pageNumber: number) => void;
  pausePreviewLoading: boolean;
  renderQuality: RenderQualitySettings;
}

export const PageGrid = memo(function PageGrid({
  document,
  dispatch,
  onHover,
  onHoverEnd,
  onOpenFullPreview,
  onOpenPaintPreview,
  onPageEdited,
  onRequestDeletePage,
  onSmallPreviewComplete,
  pausePreviewLoading,
  renderQuality,
}: PageGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isMountedRef = useRef(true);
  const isScrollingRef = useRef(false);
  const loadRunIdRef = useRef(0);
  const loadTargetPreviewWidthRef = useRef(0);
  const pausePreviewLoadingRef = useRef(false);
  const previewEntriesRef = useRef<Record<string, PreviewEntry>>({});
  const previewRefreshScheduledRef = useRef(false);
  const previewRefreshTimerRef = useRef<number | null>(null);
  const [width, setWidth] = useState(0);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [previewVersion, setPreviewVersion] = useState(0);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 7,
      },
    }),
  );

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      if (previewRefreshTimerRef.current !== null) {
        window.clearTimeout(previewRefreshTimerRef.current);
      }
    };
  }, []);

  const schedulePreviewRefresh = useCallback(() => {
    if (previewRefreshScheduledRef.current) {
      return;
    }

    previewRefreshScheduledRef.current = true;

    const requestRefresh = () => {
      if (!isMountedRef.current) {
        return;
      }

      if (isScrollingRef.current) {
        previewRefreshTimerRef.current = window.setTimeout(requestRefresh, SCROLL_IDLE_PREVIEW_COMMIT_DELAY);
        return;
      }

      scheduleIdleTask(() => {
        if (!isMountedRef.current) {
          return;
        }

        if (isScrollingRef.current) {
          previewRefreshScheduledRef.current = false;
          schedulePreviewRefresh();
          return;
        }

        previewRefreshScheduledRef.current = false;
        startTransition(() => {
          setPreviewVersion((version) => version + 1);
        });
      });
    };

    requestRefresh();
  }, []);

  const queuePreviewEntries = useCallback(
    (entries: Record<string, PreviewEntry>) => {
      if (Object.keys(entries).length === 0) {
        return;
      }

      Object.assign(previewEntriesRef.current, entries);
      schedulePreviewRefresh();
    },
    [schedulePreviewRefresh],
  );

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }

    const resizeObserver = new ResizeObserver(([entry]) => {
      if (entry) {
        setWidth(entry.contentRect.width);
      }
    });
    resizeObserver.observe(element);
    return () => resizeObserver.disconnect();
  }, []);

  const columns = useMemo(() => {
    const cellWidth = PAGE_SLOT_BASE_WIDTH * document.thumbnailScale;
    return Math.max(1, Math.floor(Math.max(width, cellWidth) / cellWidth));
  }, [document.thumbnailScale, width]);

  const rowCount = Math.ceil(document.pages.length / columns);
  const rowHeight = Math.round(226 * document.thumbnailScale + 42);
  const targetPreviewWidth = useMemo(() => {
    return Math.round(renderQuality.smallWidth * document.thumbnailScale);
  }, [document.thumbnailScale, renderQuality.smallWidth]);

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    isScrollingResetDelay: SCROLL_IDLE_PREVIEW_COMMIT_DELAY,
    overscan: PREVIEW_ROW_OVERSCAN,
  });
  const isScrolling = rowVirtualizer.isScrolling;
  const virtualRows = rowVirtualizer.getVirtualItems();
  const previewEntries = useMemo(() => previewEntriesRef.current, [previewVersion]);
  const movingPageNumbers = useMemo(() => {
    if (!dragState) {
      return new Set<number>();
    }

    return document.selectedPages.has(dragState.draggedPageNumber) ? new Set(document.selectedPages) : new Set([dragState.draggedPageNumber]);
  }, [document.selectedPages, dragState]);
  const activeDragPage = useMemo(() => {
    if (!dragState) {
      return null;
    }

    return document.pages.find((page) => page.pageNumber === dragState.draggedPageNumber) ?? null;
  }, [document.pages, dragState]);

  useEffect(() => {
    setDragState(null);
  }, [document.id]);

  useEffect(() => {
    pausePreviewLoadingRef.current = pausePreviewLoading;
  }, [pausePreviewLoading]);

  useEffect(() => {
    isScrollingRef.current = isScrolling;

    if (isScrolling) {
      onHoverEnd();
      return;
    }

    schedulePreviewRefresh();
  }, [isScrolling, onHoverEnd, schedulePreviewRefresh]);
  const filePath = document.filePath;

  useEffect(() => {
    loadRunIdRef.current += 1;
    loadTargetPreviewWidthRef.current = targetPreviewWidth;
    previewEntriesRef.current = {};
    previewRefreshScheduledRef.current = false;
    if (previewRefreshTimerRef.current !== null) {
      window.clearTimeout(previewRefreshTimerRef.current);
      previewRefreshTimerRef.current = null;
    }
    setPreviewVersion((version) => version + 1);
  }, [document.id, renderQuality.smallJpegQuality, targetPreviewWidth]);

  useEffect(() => {
    if (!filePath || document.pages.length === 0) {
      return;
    }

    const sourcePath: string = filePath;
    let isCancelled = false;
    const requestRunId = loadRunIdRef.current;
    const requestTargetPreviewWidth = loadTargetPreviewWidthRef.current;

    async function loadPreviewsFromStartToEnd() {
      for (let startIndex = 0; startIndex < document.pages.length; startIndex += MAX_PREVIEW_BATCH_SIZE) {
        while (pausePreviewLoadingRef.current) {
          await sleep(PREVIEW_PRIORITY_PAUSE_POLL_MS);

          if (isCancelled || !isMountedRef.current || loadRunIdRef.current !== requestRunId) {
            return;
          }
        }

        const pageBatch = document.pages.slice(startIndex, startIndex + MAX_PREVIEW_BATCH_SIZE);
        const pagesToRenderFromDocument = pageBatch.filter((page) => previewEntriesRef.current[page.id]?.status !== "ready");

        if (pagesToRenderFromDocument.length === 0) {
          continue;
        }

        const loadingEntries: Record<string, PreviewEntry> = {};
        for (const page of pagesToRenderFromDocument) {
          loadingEntries[page.id] = { status: "loading" };
        }
        queuePreviewEntries(loadingEntries);

        try {
          const renderedPreviews = await renderDocumentPages(sourcePath, pagesToRenderFromDocument, requestTargetPreviewWidth, {
            jpegQuality: renderQuality.smallJpegQuality,
            renderLane: "thumbnail",
          });
          if (isCancelled || !isMountedRef.current || loadRunIdRef.current !== requestRunId) {
            return;
          }

          const pageIdsByNumber = new Map(pagesToRenderFromDocument.map((page) => [page.pageNumber, page.id]));
          const nextEntries: Record<string, PreviewEntry> = {};
          const renderedPageIds = new Set<string>();

          for (const preview of renderedPreviews) {
            const pageId = pageIdsByNumber.get(preview.pageNumber);
            if (!pageId) {
              continue;
            }

            renderedPageIds.add(pageId);
            nextEntries[pageId] = { status: "ready", preview };
          }

          for (const page of pagesToRenderFromDocument) {
            if (!renderedPageIds.has(page.id)) {
              nextEntries[page.id] = { status: "error", message: "Cannot preview page" };
            }
          }

          queuePreviewEntries(nextEntries);
        } catch (error: unknown) {
          if (isCancelled || !isMountedRef.current || loadRunIdRef.current !== requestRunId) {
            return;
          }

          const message = getFriendlyLoadError(error);
          const nextEntries: Record<string, PreviewEntry> = {};
          for (const page of pagesToRenderFromDocument) {
            nextEntries[page.id] = { status: "error", message };
          }
          queuePreviewEntries(nextEntries);
        }

        if (isCancelled || !isMountedRef.current || loadRunIdRef.current !== requestRunId) {
          return;
        }

        const batchDelay = isScrollingRef.current ? ACTIVE_SCROLL_BATCH_DELAY : BACKGROUND_BATCH_DELAY;
        if (batchDelay > 0) {
          await sleep(batchDelay);
        }
      }

      schedulePreviewRefresh();
      onSmallPreviewComplete();
    }

    void loadPreviewsFromStartToEnd();

    return () => {
      isCancelled = true;
    };
  }, [
    document.id,
    document.pages,
    filePath,
    onSmallPreviewComplete,
    queuePreviewEntries,
    renderQuality.smallJpegQuality,
    schedulePreviewRefresh,
    targetPreviewWidth,
  ]);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const pageNumber = getPageNumberFromDragData(event.active.data.current);
      if (!pageNumber) {
        return;
      }

      onHoverEnd();
      setDragState({ draggedPageNumber: pageNumber, dropBeforePageNumber: null });
    },
    [onHoverEnd],
  );

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const dropBeforePageNumber = getDropBeforePageNumber(event, document.pages.length);

      setDragState((current) => {
        if (!current || current.dropBeforePageNumber === dropBeforePageNumber) {
          return current;
        }

        return { ...current, dropBeforePageNumber };
      });
    },
    [document.pages.length],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const draggedPageNumber = dragState?.draggedPageNumber ?? getPageNumberFromDragData(event.active.data.current);
      const dropBeforePageNumber = getDropBeforePageNumber(event, document.pages.length) ?? dragState?.dropBeforePageNumber ?? null;

      if (draggedPageNumber && dropBeforePageNumber) {
        dispatch({ type: "move-pages", draggedPageNumber, beforePageNumber: dropBeforePageNumber });
        onPageEdited();
      }

      setDragState(null);
      onHoverEnd();
    },
    [dispatch, document.pages.length, dragState, onHoverEnd, onPageEdited],
  );

  const handleDragCancel = useCallback(() => {
    setDragState(null);
    onHoverEnd();
  }, [onHoverEnd]);

  return (
    <DndContext
      collisionDetection={pointerWithin}
      modifiers={[restrictToWindowEdges]}
      sensors={sensors}
      onDragCancel={handleDragCancel}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      onDragStart={handleDragStart}
    >
      <div className={`page-grid-scroll ${isScrolling ? "is-scrolling" : ""} ${dragState ? "is-dragging-pages" : ""}`} ref={scrollRef}>
        <div className="virtual-canvas" style={{ height: rowVirtualizer.getTotalSize() }}>
          {virtualRows.map((virtualRow) => {
            const start = virtualRow.index * columns;
            const rowPages = document.pages.slice(start, start + columns);

            return (
              <div
                className="virtual-row"
                key={virtualRow.key}
                style={{
                  height: rowHeight,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <div className="page-row" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
                  {rowPages.map((page) => (
                    <PageSlot
                      beforeNextPage={page.pageNumber + 1}
                      canCutAfter={page.pageNumber < document.pages.length}
                      dispatch={dispatch}
                      hoverEnabled={document.hoverZoomEnabled && !isScrolling && !dragState}
                      isCut={document.cutBeforePages.has(page.pageNumber + 1)}
                      isDragMoving={movingPageNumbers.has(page.pageNumber)}
                      isDropAfter={dragState?.dropBeforePageNumber === document.pages.length + 1 && page.pageNumber === document.pages.length}
                      isDropBefore={dragState?.dropBeforePageNumber === page.pageNumber}
                      isSelected={document.selectedPages.has(page.pageNumber)}
                      key={page.id}
                      onHover={onHover}
                      onHoverEnd={onHoverEnd}
                      onOpenFullPreview={onOpenFullPreview}
                      onOpenPaintPreview={onOpenPaintPreview}
                      onPageEdited={onPageEdited}
                      onRequestDeletePage={onRequestDeletePage}
                      page={page}
                      previewEntry={previewEntries[page.id]}
                      thumbnailScale={document.thumbnailScale}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <DragOverlay dropAnimation={null}>
        {activeDragPage ? (
          <PageDragOverlay
            movingCount={movingPageNumbers.size}
            page={activeDragPage}
            previewEntry={previewEntries[activeDragPage.id]}
            thumbnailScale={document.thumbnailScale}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
});

interface PageSlotProps {
  beforeNextPage: number;
  canCutAfter: boolean;
  dispatch: Dispatch<DocumentAction>;
  hoverEnabled: boolean;
  isCut: boolean;
  isDragMoving: boolean;
  isDropAfter: boolean;
  isDropBefore: boolean;
  isSelected: boolean;
  onHover: (page: PdfPage, point: { x: number; y: number }, preview: PdfPagePreview | null) => void;
  onHoverEnd: () => void;
  onOpenFullPreview: (page: PdfPage) => void;
  onOpenPaintPreview: (page: PdfPage) => void;
  onPageEdited: () => void;
  onRequestDeletePage: (pageNumber: number) => void;
  page: PdfPage;
  previewEntry: PreviewEntry | undefined;
  thumbnailScale: number;
}

const PageSlot = memo(function PageSlot({
  beforeNextPage,
  canCutAfter,
  dispatch,
  hoverEnabled,
  isCut,
  isDragMoving,
  isDropAfter,
  isDropBefore,
  isSelected,
  page,
  onHover,
  onHoverEnd,
  onOpenFullPreview,
  onOpenPaintPreview,
  onPageEdited,
  onRequestDeletePage,
  previewEntry,
  thumbnailScale,
}: PageSlotProps) {
  function handlePageClick(event: MouseEvent<HTMLButtonElement>) {
    dispatch({
      type: "select-page",
      pageNumber: page.pageNumber,
      selectionMode: event.shiftKey ? "range" : event.ctrlKey || event.metaKey ? "add" : "single",
    });
  }

  function handleCutClick() {
    if (canCutAfter) {
      dispatch({ type: "toggle-cut", beforePage: beforeNextPage });
    }
  }

  function handleOpenFullPreviewClick(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    onOpenFullPreview(page);
  }

  function handleOpenPaintPreviewClick(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    onOpenPaintPreview(page);
  }

  function handleRotateRightClick(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    dispatch({ type: "rotate-page", pageNumber: page.pageNumber, degrees: 90 });
    onPageEdited();
  }

  function handleDeletePageClick(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    onRequestDeletePage(page.pageNumber);
  }

  const { attributes, listeners, setNodeRef: setDraggableNodeRef } = useDraggable({
    data: { pageNumber: page.pageNumber },
    id: draggablePageId(page.id),
  });

  return (
    <div
      className={`page-slot ${isDropBefore ? "is-drop-before" : ""} ${isDropAfter ? "is-drop-after" : ""}`}
      style={{ "--scale": thumbnailScale } as CSSProperties}
    >
      <PageDropZone pageNumber={page.pageNumber} position="before" />
      <PageDropZone pageNumber={page.pageNumber} position="after" />
      <span className="page-drop-indicator is-before" aria-hidden="true" />
      <span className="page-drop-indicator is-after" aria-hidden="true" />
      <div
        ref={setDraggableNodeRef}
        className={`page-card ${isSelected ? "is-selected" : ""} ${isDragMoving ? "is-drag-moving" : ""}`}
        onMouseLeave={hoverEnabled ? onHoverEnd : undefined}
        onMouseMove={
          hoverEnabled
            ? (event) => onHover(page, { x: event.clientX, y: event.clientY }, previewEntry?.status === "ready" ? previewEntry.preview : null)
            : undefined
        }
        {...attributes}
        {...listeners}
      >
        <button className="page-select-button" type="button" onClick={handlePageClick}>
          <PagePreview page={page} previewEntry={previewEntry} />
          <span>{page.pageNumber}</span>
        </button>
        <div className="page-card-actions">
          <button
            type="button"
            aria-label={`Open page ${page.pageNumber} preview`}
            title="Preview"
            onClick={handleOpenFullPreviewClick}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Maximize2 size={17} />
          </button>
          <button
            type="button"
            aria-label={`Rotate page ${page.pageNumber} right`}
            title="Rotate right"
            onClick={handleRotateRightClick}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <RotateCw size={17} />
          </button>
          <button
            type="button"
            aria-label={`Paint page ${page.pageNumber}`}
            title="Paint"
            onClick={handleOpenPaintPreviewClick}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Brush size={17} />
          </button>
          <button
            className="is-danger"
            type="button"
            aria-label={`Delete page ${page.pageNumber}`}
            title="Delete"
            onClick={handleDeletePageClick}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Trash2 size={17} />
          </button>
        </div>
      </div>

      {canCutAfter ? (
        <button
          className={`cut-separator is-enabled ${isCut ? "is-cut" : ""}`}
          type="button"
          aria-label={`Toggle split before page ${beforeNextPage}`}
          onClick={handleCutClick}
        >
          <span className="cut-line" />
          {isCut ? (
            <span className="cut-badge" aria-hidden="true">
              <Scissors size={13} strokeWidth={2.6} />
            </span>
          ) : null}
        </button>
      ) : null}
    </div>
  );
});

function PageDropZone({ pageNumber, position }: { pageNumber: number; position: DropPosition }) {
  const { setNodeRef } = useDroppable({
    data: { pageNumber, position },
    id: droppablePageZoneId(pageNumber, position),
  });

  return <span ref={setNodeRef} className={`page-drop-zone is-${position}`} aria-hidden="true" />;
}

function PageDragOverlay({
  movingCount,
  page,
  previewEntry,
  thumbnailScale,
}: {
  movingCount: number;
  page: PdfPage;
  previewEntry: PreviewEntry | undefined;
  thumbnailScale: number;
}) {
  return (
    <div className="page-drag-overlay" style={{ "--scale": thumbnailScale } as CSSProperties}>
      <PagePreview page={page} previewEntry={previewEntry} />
      <span>{movingCount > 1 ? `${movingCount} pages` : `Page ${page.pageNumber}`}</span>
    </div>
  );
}

function PagePreview({ page, previewEntry }: { page: PdfPage; previewEntry: PreviewEntry | undefined }) {
  if (previewEntry?.status === "ready") {
    return <PreviewImage page={page} preview={previewEntry.preview} />;
  }

  if (previewEntry?.status === "loading") {
    return (
      <div className={`page-preview-paper is-loading ${page.deleted ? "is-deleted" : ""} ${page.tinted ? "is-tinted" : ""}`}>
        <span className="preview-spinner" />
      </div>
    );
  }

  if (previewEntry?.status === "error") {
    return (
      <div className={`page-preview-paper is-error ${page.deleted ? "is-deleted" : ""} ${page.tinted ? "is-tinted" : ""}`}>
        <small>{previewEntry.message}</small>
      </div>
    );
  }

  return <MockPaper page={page} />;
}

function PreviewImage({ page, preview }: { page: PdfPage; preview: PdfPagePreview }) {
  const isSideways = page.rotation === 90 || page.rotation === 270;
  const crop = getActiveThumbnailCrop(page);
  const straightenDegrees = getThumbnailStraightenDegrees(page);
  const straightenScale = getThumbnailStraightenScale(straightenDegrees);

  return (
    <div
      className={`page-preview-paper ${isSideways ? "is-sideways" : ""} ${page.deleted ? "is-deleted" : ""} ${page.tinted ? "is-tinted" : ""}`}
      style={
        {
          "--crop-bottom": `${(1 - crop.y - crop.height) * 100}%`,
          "--crop-left": `${crop.x * 100}%`,
          "--crop-right": `${(1 - crop.x - crop.width) * 100}%`,
          "--crop-top": `${crop.y * 100}%`,
          "--page-ratio": `${preview.width} / ${preview.height}`,
          "--rotation": `${page.rotation}deg`,
          "--straighten": `${straightenDegrees}deg`,
          "--straighten-scale": straightenScale,
        } as CSSProperties
      }
    >
      <div className="page-preview-content">
        <img alt={`Page ${page.pageNumber}`} decoding="async" draggable={false} loading="lazy" src={preview.dataUrl} />
        {page.paintEdits.length > 0 ? <ThumbnailPaintLayer page={page} /> : null}
      </div>
    </div>
  );
}

function ThumbnailPaintLayer({ page }: { page: PdfPage }) {
  return (
    <div className="page-preview-paint-layer" aria-hidden="true">
      {page.paintEdits.map((edit) => {
        if (edit.type === "cover") {
          return (
            <span
              className="page-preview-cover-edit"
              key={edit.id}
              style={{
                background: edit.color,
                height: `${edit.height * 100}%`,
                left: `${edit.x * 100}%`,
                top: `${edit.y * 100}%`,
                width: `${edit.width * 100}%`,
              }}
            />
          );
        }

        if (edit.type !== "text") {
          return null;
        }

        return (
          <span
            className="page-preview-text-edit"
            key={edit.id}
            style={{
              color: edit.color,
              fontFamily: edit.fontFamily,
              fontSize: `${Math.max(4, edit.fontSize * 0.24)}px`,
              fontWeight: edit.bold ? 800 : 700,
              fontStyle: edit.italic ? "italic" : "normal",
              height: `${edit.height * 100}%`,
              left: `${edit.x * 100}%`,
              textAlign: edit.textAlign,
              textDecoration: edit.underline ? "underline" : "none",
              top: `${edit.y * 100}%`,
              width: `${edit.width * 100}%`,
            }}
          >
            {edit.text}
          </span>
        );
      })}
    </div>
  );
}

function draggablePageId(pageId: string): string {
  return `page:${pageId}`;
}

function droppablePageZoneId(pageNumber: number, position: DropPosition): string {
  return `drop:${position}:${pageNumber}`;
}

function getDropBeforePageNumber(event: DragOverEvent | DragEndEvent, pageCount: number): number | null {
  const data = event.over?.data.current;
  if (!isDropZoneData(data)) {
    return null;
  }

  return data.position === "after" ? Math.min(data.pageNumber + 1, pageCount + 1) : data.pageNumber;
}

function getPageNumberFromDragData(data: unknown): number | null {
  if (!isRecord(data)) {
    return null;
  }

  const pageNumber = data.pageNumber;
  return typeof pageNumber === "number" && Number.isFinite(pageNumber) ? pageNumber : null;
}

function isDropZoneData(data: unknown): data is { pageNumber: number; position: DropPosition } {
  if (!isRecord(data)) {
    return false;
  }

  return (
    typeof data.pageNumber === "number" &&
    Number.isFinite(data.pageNumber) &&
    (data.position === "after" || data.position === "before")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getActiveThumbnailCrop(page: PdfPage): { height: number; width: number; x: number; y: number } {
  for (let index = page.paintEdits.length - 1; index >= 0; index -= 1) {
    const edit = page.paintEdits[index];
    if (edit?.type === "crop") {
      const width = Math.min(1, Math.max(0.035, edit.width));
      const height = Math.min(1, Math.max(0.035, edit.height));
      return {
        height,
        width,
        x: Math.min(1 - width, Math.max(0, edit.x)),
        y: Math.min(1 - height, Math.max(0, edit.y)),
      };
    }
  }

  return { height: 1, width: 1, x: 0, y: 0 };
}

function getThumbnailStraightenDegrees(page: PdfPage): number {
  const degrees = page.paintEdits.reduce((total, edit) => total + (edit.type === "straighten" ? edit.degrees : 0), 0);
  return Math.min(15, Math.max(-15, degrees));
}

function getThumbnailStraightenScale(degrees: number): number {
  const radians = Math.abs(degrees) * (Math.PI / 180);
  if (radians <= 0.001) {
    return 1;
  }

  const width = 0.72;
  const height = 1;
  const rotatedWidth = width * Math.cos(radians) + height * Math.sin(radians);
  const rotatedHeight = width * Math.sin(radians) + height * Math.cos(radians);
  return Math.min(width / rotatedWidth, height / rotatedHeight) * 0.985;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function scheduleIdleTask(callback: () => void) {
  const windowWithIdleCallback = window as Window & {
    requestIdleCallback?: (handler: () => void, options?: { timeout: number }) => number;
  };

  if (windowWithIdleCallback.requestIdleCallback) {
    windowWithIdleCallback.requestIdleCallback(callback, { timeout: 650 });
    return;
  }

  window.setTimeout(() => window.requestAnimationFrame(callback), 80);
}
