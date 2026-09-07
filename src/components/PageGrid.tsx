import {
  DndContext,
  DragOverlay,
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
import { Bookmark, Maximize2, RotateCw, Scissors, Trash2 } from "lucide-react";
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

import type { PdfDocument, PdfPage, PdfPagePreview, ThumbnailLayoutMode } from "../domain/pdf";
import type { RenderQualitySettings } from "../domain/pdfSettings";
import { getFriendlyLoadError, renderDocumentPages } from "../services/pdfLoader";
import type { DocumentAction } from "../state/documentReducer";

import { MockPaper } from "./EditorView";
import { PagePointerSensor } from "./PagePointerSensor";

type PreviewEntry =
  | { status: "loading" }
  | { status: "ready"; preview: PdfPagePreview }
  | { status: "error"; message: string };

interface DragState {
  draggedPageNumber: number;
  dropBeforePageNumber: number | null;
}

type DropPosition = "after" | "before";

interface PreviewRect {
  height: number;
  width: number;
  x: number;
  y: number;
}

const MAX_PREVIEW_BATCH_SIZE = 2;
const PREVIEW_ROW_OVERSCAN = 2;
const SCROLL_IDLE_PREVIEW_COMMIT_DELAY = 260;
const PREVIEW_PRIORITY_PAUSE_POLL_MS = 30;
const BACKGROUND_BATCH_DELAY = 4;
const ACTIVE_SCROLL_BATCH_DELAY = 55;
const DRAG_AUTO_SCROLL_EDGE_PX = 136;
const DRAG_AUTO_SCROLL_MAX_SPEED = 34;
const DRAG_AUTO_SCROLL_MIN_SPEED = 4;
const PAGE_SLOT_BASE_WIDTH = 244;

interface PageGridProps {
  document: PdfDocument;
  dispatch: Dispatch<DocumentAction>;
  onSmallPreviewComplete: () => void;
  onHover: (page: PdfPage, point: { x: number; y: number }, preview: PdfPagePreview | null) => void;
  onHoverEnd: () => void;
  onOpenFullPreview: (page: PdfPage) => void;
  onPageEdited: () => void;
  onRequestDeletePage: (pageNumber: number) => void;
  pausePreviewLoading: boolean;
  renderQuality: RenderQualitySettings;
  scrollToPageNumber: number | null;
  onScrolledToPage: () => void;
}

export const PageGrid = memo(function PageGrid({
  document,
  dispatch,
  onHover,
  onHoverEnd,
  onOpenFullPreview,
  onPageEdited,
  onRequestDeletePage,
  onScrolledToPage,
  onSmallPreviewComplete,
  pausePreviewLoading,
  renderQuality,
  scrollToPageNumber,
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
  const dragAutoScrollFrameRef = useRef<number | null>(null);
  const dragPointerYRef = useRef<number | null>(null);
  const [width, setWidth] = useState(0);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [previewVersion, setPreviewVersion] = useState(0);
  const isDraggingPages = dragState !== null;
  const sensors = useSensors(
    useSensor(PagePointerSensor, {
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
      if (dragAutoScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(dragAutoScrollFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isDraggingPages) {
      dragPointerYRef.current = null;
      if (dragAutoScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(dragAutoScrollFrameRef.current);
        dragAutoScrollFrameRef.current = null;
      }
      return;
    }

    const scheduleAutoScroll = () => {
      if (dragAutoScrollFrameRef.current !== null) {
        return;
      }

      dragAutoScrollFrameRef.current = window.requestAnimationFrame(runAutoScroll);
    };

    const runAutoScroll = () => {
      dragAutoScrollFrameRef.current = null;

      const scrollElement = scrollRef.current;
      const pointerY = dragPointerYRef.current;
      if (!scrollElement || pointerY === null) {
        return;
      }

      const speed = getDragAutoScrollSpeed(pointerY, scrollElement.getBoundingClientRect());
      if (speed === 0) {
        return;
      }

      scrollElement.scrollTop += speed;
      scheduleAutoScroll();
    };

    const handlePointerMove = (event: PointerEvent) => {
      if ((event.buttons & 1) === 0) {
        dragPointerYRef.current = null;
        return;
      }
      dragPointerYRef.current = event.clientY;
      scheduleAutoScroll();
    };

    const handleWheel = (event: WheelEvent) => {
      const scrollElement = scrollRef.current;
      if (!scrollElement) {
        return;
      }

      const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (delta === 0) {
        return;
      }

      event.preventDefault();
      scrollElement.scrollTop += delta;
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    window.addEventListener("wheel", handleWheel, { capture: true, passive: false });

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("wheel", handleWheel, { capture: true });
      if (dragAutoScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(dragAutoScrollFrameRef.current);
        dragAutoScrollFrameRef.current = null;
      }
    };
  }, [isDraggingPages]);

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

  const largeColumns = getLargeLayoutColumns(document.thumbnailLayout);
  const columns = useMemo(() => {
    if (largeColumns) {
      return largeColumns;
    }

    const cellWidth = PAGE_SLOT_BASE_WIDTH * document.thumbnailScale;
    return Math.max(1, Math.floor(Math.max(width, cellWidth) / cellWidth));
  }, [document.thumbnailScale, largeColumns, width]);

  const rowCount = Math.ceil(document.pages.length / columns);
  const largePageWidth = useMemo(() => {
    if (!largeColumns) {
      return null;
    }

    const viewportFitWidth =
      typeof window === "undefined" ? 620 : Math.max(170, Math.floor((window.innerHeight - 210) / 1.44));
    const maxLargeWidth =
      largeColumns === 1
        ? Math.min(640, viewportFitWidth)
        : largeColumns === 2
          ? Math.min(500, viewportFitWidth)
          : Math.min(350, viewportFitWidth);
    const availableWidth = Math.max(240, width - 34 * largeColumns - 30 * Math.max(0, largeColumns - 1) - 42);
    return Math.round(Math.max(160, Math.min(maxLargeWidth, availableWidth / largeColumns)));
  }, [largeColumns, width]);
  const rowHeight = largePageWidth ? Math.round(largePageWidth * 1.44 + 104) : Math.round(226 * document.thumbnailScale + 42);
  const targetPreviewWidth = useMemo(() => {
    return largePageWidth
      ? Math.round(Math.max(renderQuality.smallWidth, Math.min(renderQuality.detailWidth, largePageWidth * 1.5)))
      : Math.round(renderQuality.smallWidth * document.thumbnailScale);
  }, [document.thumbnailScale, largePageWidth, renderQuality.detailWidth, renderQuality.smallWidth]);
  const previewRenderLane = largePageWidth ? "full" : "thumbnail";
  const previewJpegQuality = largePageWidth ? renderQuality.detailJpegQuality : renderQuality.smallJpegQuality;

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    isScrollingResetDelay: SCROLL_IDLE_PREVIEW_COMMIT_DELAY,
    overscan: PREVIEW_ROW_OVERSCAN,
  });
  const isScrolling = rowVirtualizer.isScrolling;
  const virtualRows = rowVirtualizer.getVirtualItems();

  useEffect(() => {
    rowVirtualizer.measure();
  }, [columns, document.thumbnailLayout, largePageWidth, rowHeight, rowVirtualizer, width]);

  useEffect(() => {
    if (!scrollToPageNumber || document.pages.length === 0) {
      return;
    }

    const targetIndex = document.pages.findIndex((page) => page.pageNumber === scrollToPageNumber);
    if (targetIndex < 0) {
      onScrolledToPage();
      return;
    }

    rowVirtualizer.scrollToIndex(Math.floor(targetIndex / columns), { align: "start" });
    window.setTimeout(onScrolledToPage, 80);
  }, [columns, document.pages, onScrolledToPage, rowVirtualizer, scrollToPageNumber]);

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
  }, [document.id, previewJpegQuality, previewRenderLane, targetPreviewWidth]);

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
            jpegQuality: previewJpegQuality,
            renderLane: previewRenderLane,
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
    previewJpegQuality,
    previewRenderLane,
    queuePreviewEntries,
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
      dragPointerYRef.current = null;
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
    dragPointerYRef.current = null;
    setDragState(null);
    onHoverEnd();
  }, [onHoverEnd]);

  return (
    <DndContext
      autoScroll={false}
      collisionDetection={pointerWithin}
      modifiers={[restrictToWindowEdges]}
      sensors={sensors}
      onDragCancel={handleDragCancel}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      onDragStart={handleDragStart}
    >
      <div className={`page-grid-scroll ${isScrolling ? "is-scrolling" : ""} ${isDraggingPages ? "is-dragging-pages" : ""}`} ref={scrollRef}>
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
                      beforePage={page.pageNumber}
                      canCutBefore={page.pageNumber > 1}
                      dispatch={dispatch}
                      hoverEnabled={document.hoverZoomEnabled && !isScrolling && !isDraggingPages}
                      isCut={document.cutBeforePages.has(page.pageNumber)}
                      isDragMoving={movingPageNumbers.has(page.pageNumber)}
                      isDropAfter={dragState?.dropBeforePageNumber === document.pages.length + 1 && page.pageNumber === document.pages.length}
                      isDropBefore={dragState?.dropBeforePageNumber === page.pageNumber}
                      isSelected={document.selectedPages.has(page.pageNumber)}
                      key={page.id}
                      onHover={onHover}
                      onHoverEnd={onHoverEnd}
                      onOpenFullPreview={onOpenFullPreview}
                      onPageEdited={onPageEdited}
                      onRequestDeletePage={onRequestDeletePage}
                      page={page}
                      pageDisplayWidth={largePageWidth}
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
          <PageDragOverlay movingCount={movingPageNumbers.size} />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
});

interface PageSlotProps {
  beforePage: number;
  canCutBefore: boolean;
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
  onPageEdited: () => void;
  onRequestDeletePage: (pageNumber: number) => void;
  page: PdfPage;
  pageDisplayWidth: number | null;
  previewEntry: PreviewEntry | undefined;
  thumbnailScale: number;
}

const PageSlot = memo(function PageSlot({
  beforePage,
  canCutBefore,
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
  onPageEdited,
  onRequestDeletePage,
  previewEntry,
  pageDisplayWidth,
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
    if (canCutBefore) {
      dispatch({ type: "toggle-cut", beforePage });
    }
  }

  function handleOpenFullPreviewClick(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    onOpenFullPreview(page);
  }

  function handleToggleMarkClick(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    dispatch({ type: "toggle-page-mark", pageNumber: page.pageNumber });
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
      style={
        {
          "--scale": thumbnailScale,
          ...(pageDisplayWidth ? { "--thumb-width": `${pageDisplayWidth}px` } : null),
        } as CSSProperties
      }
    >
      <PageDropZone pageNumber={page.pageNumber} position="before" />
      <PageDropZone pageNumber={page.pageNumber} position="after" />
      <span className="page-drop-indicator is-before" aria-hidden="true" />
      <span className="page-drop-indicator is-after" aria-hidden="true" />
      {canCutBefore ? (
        <button
          className={`cut-separator is-enabled ${isCut ? "is-cut" : ""}`}
          type="button"
          aria-label={`Toggle split before page ${beforePage}`}
          onClick={handleCutClick}
        >
          <span className="cut-line" />
          {isCut ? (
            <span className="cut-badge" aria-hidden="true">
              <Scissors size={13} strokeWidth={2.6} />
            </span>
          ) : null}
        </button>
      ) : (
        <span className="cut-separator-placeholder" aria-hidden="true" />
      )}
      <div
        ref={setDraggableNodeRef}
        className={`page-card ${isSelected ? "is-selected" : ""} ${page.tinted ? "is-marked" : ""} ${isDragMoving ? "is-drag-moving" : ""}`}
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
            title="Preview (Space)"
            onClick={handleOpenFullPreviewClick}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Maximize2 size={17} />
          </button>
          <button
            type="button"
            aria-label={`Rotate page ${page.pageNumber} right`}
            title="Rotate right (Ctrl+R)"
            onClick={handleRotateRightClick}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <RotateCw size={17} />
          </button>
          <button
            className={page.tinted ? "is-marked" : ""}
            type="button"
            aria-label={page.tinted ? `Unmark page ${page.pageNumber}` : `Mark page ${page.pageNumber}`}
            title={page.tinted ? "Unmark (Ctrl+M)" : "Mark (Ctrl+M)"}
            onClick={handleToggleMarkClick}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Bookmark size={17} />
          </button>
          <button
            className="is-danger"
            type="button"
            aria-label={`Delete page ${page.pageNumber}`}
            title="Delete (Delete)"
            onClick={handleDeletePageClick}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Trash2 size={17} />
          </button>
        </div>
      </div>
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

function PageDragOverlay({ movingCount }: { movingCount: number }) {
  return (
    <div className="page-drag-overlay">
      <strong>Move here</strong>
      <span>{movingCount > 1 ? `${movingCount} pages` : "1 page"}</span>
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
  const sourceRatio = preview.width / Math.max(1, preview.height);
  const displayRatio = isSideways ? 1 / Math.max(0.001, sourceRatio) : sourceRatio;
  const contentPlacement = getPreviewContentPlacement(displayRatio);
  const crop = getActiveThumbnailCrop(page);
  const visualCrop = rectToVisualRect(crop, page.rotation);
  const straightenDegrees = getThumbnailStraightenDegrees(page);
  const straightenScale = getThumbnailStraightenScale(straightenDegrees);

  return (
    <div
      className={`page-preview-paper ${isSideways ? "is-sideways" : ""} ${page.deleted ? "is-deleted" : ""} ${page.tinted ? "is-tinted" : ""}`}
      style={
        {
          "--crop-bottom": `${(1 - visualCrop.y - visualCrop.height) * 100}%`,
          "--crop-left": `${visualCrop.x * 100}%`,
          "--crop-right": `${(1 - visualCrop.x - visualCrop.width) * 100}%`,
          "--crop-top": `${visualCrop.y * 100}%`,
          "--content-height": `${contentPlacement.height}%`,
          "--content-left": `${contentPlacement.left}%`,
          "--content-top": `${contentPlacement.top}%`,
          "--content-width": `${contentPlacement.width}%`,
          "--page-ratio": `${preview.width} / ${preview.height}`,
          "--source-ratio-value": sourceRatio,
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
          const rect = rectToVisualRect(edit, page.rotation);
          return (
            <span
              className="page-preview-cover-edit"
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

        const rect = rectToVisualRect(edit, page.rotation);
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
              height: `${rect.height * 100}%`,
              left: `${rect.x * 100}%`,
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
    </div>
  );
}

function normalizedRect(start: { x: number; y: number }, end: { x: number; y: number }): PreviewRect {
  return {
    height: Math.abs(end.y - start.y),
    width: Math.abs(end.x - start.x),
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
  };
}

function normalizePageRotation(rotation: number): 0 | 90 | 180 | 270 {
  const normalizedRotation = ((rotation % 360) + 360) % 360;

  if (normalizedRotation === 90 || normalizedRotation === 180 || normalizedRotation === 270) {
    return normalizedRotation;
  }

  return 0;
}

function pagePointToVisualPoint(point: { x: number; y: number }, rotation: number): { x: number; y: number } {
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

function rectToVisualRect(rect: PreviewRect, rotation: number): PreviewRect {
  const start = pagePointToVisualPoint({ x: rect.x, y: rect.y }, rotation);
  const end = pagePointToVisualPoint({ x: rect.x + rect.width, y: rect.y + rect.height }, rotation);
  return normalizedRect(start, end);
}

function getPreviewContentPlacement(displayRatio: number): { height: number; left: number; top: number; width: number } {
  const frameRatio = 0.72;
  const safeRatio = Math.max(0.001, displayRatio);

  if (safeRatio > frameRatio) {
    const height = (frameRatio / safeRatio) * 100;
    return {
      height,
      left: 0,
      top: (100 - height) / 2,
      width: 100,
    };
  }

  const width = (safeRatio / frameRatio) * 100;
  return {
    height: 100,
    left: (100 - width) / 2,
    top: 0,
    width,
  };
}

function rectStyle(rect: PreviewRect): CSSProperties {
  return {
    height: `${rect.height * 100}%`,
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.width * 100}%`,
  };
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

function getLargeLayoutColumns(layout: ThumbnailLayoutMode): number | null {
  switch (layout) {
    case "large1":
      return 1;
    case "large2":
      return 2;
    case "large3":
      return 3;
    default:
      return null;
  }
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

function getDragAutoScrollSpeed(pointerY: number, scrollRect: DOMRect): number {
  const viewportHeight = window.innerHeight;
  const topEdge = Math.max(0, Math.min(scrollRect.top, viewportHeight));
  const bottomEdge = Math.max(0, Math.min(scrollRect.bottom, viewportHeight));
  const topDistance = Math.min(DRAG_AUTO_SCROLL_EDGE_PX, Math.max(0, pointerY - topEdge));
  const bottomDistance = Math.min(DRAG_AUTO_SCROLL_EDGE_PX, Math.max(0, bottomEdge - pointerY));

  if (pointerY <= topEdge || topDistance < DRAG_AUTO_SCROLL_EDGE_PX) {
    const pressure = pointerY <= topEdge ? 1 : 1 - topDistance / DRAG_AUTO_SCROLL_EDGE_PX;
    return -getDragAutoScrollVelocity(pressure);
  }

  if (pointerY >= bottomEdge || bottomDistance < DRAG_AUTO_SCROLL_EDGE_PX) {
    const pressure = pointerY >= bottomEdge ? 1 : 1 - bottomDistance / DRAG_AUTO_SCROLL_EDGE_PX;
    return getDragAutoScrollVelocity(pressure);
  }

  return 0;
}

function getDragAutoScrollVelocity(pressure: number): number {
  const normalizedPressure = Math.min(1, Math.max(0, pressure));
  if (normalizedPressure <= 0) {
    return 0;
  }

  return Math.round(DRAG_AUTO_SCROLL_MIN_SPEED + DRAG_AUTO_SCROLL_MAX_SPEED * normalizedPressure * normalizedPressure);
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
