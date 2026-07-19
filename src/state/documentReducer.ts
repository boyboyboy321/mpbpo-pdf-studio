import type { InsertPageMetadata, PdfDocument, PdfMetadata, PdfPage, PdfPagePaintEdit } from "../domain/pdf";
import type { RenderQualityPreset, RenderQualitySettings } from "../domain/pdfSettings";
import { clampRenderQualitySettings, THUMBNAIL_SCALE_MAX, THUMBNAIL_SCALE_MIN } from "../domain/pdfSettings";

export type DocumentAction =
  | { type: "open"; document: PdfDocument }
  | { type: "close" }
  | { type: "save-complete"; metadata: PdfMetadata }
  | { type: "select-page"; pageNumber: number; selectionMode: "add" | "range" | "single" }
  | { type: "toggle-cut"; beforePage: number }
  | { type: "toggle-each-page-split" }
  | { type: "insert-pages-after-selection"; pages: InsertPageMetadata[] }
  | { type: "move-pages"; draggedPageNumber: number; beforePageNumber: number }
  | { type: "add-page-paint-edit"; edit: PdfPagePaintEdit; pageNumber: number }
  | { type: "remove-page-paint-edit"; editId: string; pageNumber: number }
  | { type: "undo-page-paint-edit"; pageNumber: number }
  | { type: "update-page-paint-edit"; edit: PdfPagePaintEdit; pageNumber: number }
  | { type: "rotate-page"; pageNumber: number; degrees: 90 | 180 | 270 }
  | { type: "rotate-selected"; degrees: 90 | 180 | 270 }
  | { type: "delete-pages"; pageNumbers: number[] }
  | { type: "delete-selected" }
  | { type: "toggle-tint-selected" }
  | { type: "toggle-hover-zoom" }
  | { type: "toggle-detail-panel" }
  | { type: "set-render-quality-preset"; preset: RenderQualityPreset }
  | { type: "set-custom-render-quality"; settings: RenderQualitySettings }
  | { type: "set-thumbnail-scale"; scale: number };

export function documentReducer(state: PdfDocument | null, action: DocumentAction): PdfDocument | null {
  switch (action.type) {
    case "open":
      return action.document;
    case "close":
      return null;
    case "save-complete":
      return state ? rebaseSavedDocument(state, action.metadata) : state;
    case "select-page":
      return state ? selectPage(state, action.pageNumber, action.selectionMode) : state;
    case "toggle-cut":
      return state ? toggleCut(state, action.beforePage) : state;
    case "toggle-each-page-split":
      return state ? toggleEachPageSplit(state) : state;
    case "insert-pages-after-selection":
      return state ? insertPagesAfterSelection(state, action.pages) : state;
    case "move-pages":
      return state ? movePagesBefore(state, action.draggedPageNumber, action.beforePageNumber) : state;
    case "add-page-paint-edit":
      return state ? addPagePaintEdit(state, action.pageNumber, action.edit) : state;
    case "remove-page-paint-edit":
      return state ? removePagePaintEdit(state, action.pageNumber, action.editId) : state;
    case "undo-page-paint-edit":
      return state ? undoPagePaintEdit(state, action.pageNumber) : state;
    case "update-page-paint-edit":
      return state ? updatePagePaintEdit(state, action.pageNumber, action.edit) : state;
    case "rotate-page":
      return state
        ? markDirty(updatePage(state, action.pageNumber, (page) => ({ ...page, rotation: rotate(page.rotation, action.degrees) })))
        : state;
    case "rotate-selected":
      return state ? markDirty(updateSelectedPages(state, (page) => ({ ...page, rotation: rotate(page.rotation, action.degrees) }))) : state;
    case "delete-pages":
      return state ? deletePages(state, new Set(action.pageNumbers)) : state;
    case "delete-selected":
      return state ? deleteSelectedPages(state) : state;
    case "toggle-tint-selected":
      return state ? markDirty(updateSelectedPages(state, (page) => ({ ...page, tinted: !page.tinted }))) : state;
    case "toggle-hover-zoom":
      return state ? { ...state, hoverZoomEnabled: !state.hoverZoomEnabled } : state;
    case "toggle-detail-panel":
      return state ? { ...state, detailPanelVisible: !state.detailPanelVisible } : state;
    case "set-render-quality-preset":
      return state ? { ...state, renderQualityPreset: action.preset } : state;
    case "set-custom-render-quality":
      return state ? { ...state, customRenderQuality: clampRenderQualitySettings(action.settings), renderQualityPreset: "custom" } : state;
    case "set-thumbnail-scale":
      return state ? { ...state, thumbnailScale: clampThumbnailScale(action.scale) } : state;
    default:
      return state;
  }
}

function selectPage(document: PdfDocument, pageNumber: number, selectionMode: "add" | "range" | "single"): PdfDocument {
  if (selectionMode === "range") {
    const start = Math.min(document.lastSelectedPageNumber, pageNumber);
    const end = Math.max(document.lastSelectedPageNumber, pageNumber);
    const nextSelected = new Set<number>();

    for (let selectedPageNumber = start; selectedPageNumber <= end; selectedPageNumber += 1) {
      nextSelected.add(selectedPageNumber);
    }

    return { ...document, lastSelectedPageNumber: pageNumber, selectedPages: nextSelected };
  }

  const nextSelected = selectionMode === "add" ? new Set(document.selectedPages) : new Set<number>();

  if (selectionMode === "add" && nextSelected.has(pageNumber)) {
    nextSelected.delete(pageNumber);
  } else {
    nextSelected.add(pageNumber);
  }

  if (nextSelected.size === 0) {
    nextSelected.add(pageNumber);
  }

  return { ...document, lastSelectedPageNumber: pageNumber, selectedPages: nextSelected };
}

function toggleCut(document: PdfDocument, beforePage: number): PdfDocument {
  if (beforePage <= 1 || beforePage > document.pages.length) {
    return document;
  }

  const nextCuts = new Set(document.cutBeforePages);
  if (nextCuts.has(beforePage)) {
    nextCuts.delete(beforePage);
  } else {
    nextCuts.add(beforePage);
  }

  return { ...document, cutBeforePages: nextCuts };
}

function toggleEachPageSplit(document: PdfDocument): PdfDocument {
  const totalPossibleCuts = document.pages.length - 1;

  if (totalPossibleCuts <= 0) {
    return document;
  }

  const hasEveryCut =
    document.cutBeforePages.size === totalPossibleCuts &&
    Array.from({ length: totalPossibleCuts }, (_, index) => index + 2).every((pageNumber) =>
      document.cutBeforePages.has(pageNumber),
    );

  if (hasEveryCut) {
    return { ...document, cutBeforePages: new Set() };
  }

  const nextCuts = new Set<number>();
  for (let pageNumber = 2; pageNumber <= document.pages.length; pageNumber += 1) {
    nextCuts.add(pageNumber);
  }

  return { ...document, cutBeforePages: nextCuts };
}

function updateSelectedPages(
  document: PdfDocument,
  updater: (page: PdfDocument["pages"][number]) => PdfDocument["pages"][number],
): PdfDocument {
  const pages = document.pages.map((page) => (document.selectedPages.has(page.pageNumber) ? updater(page) : page));
  return { ...document, pages };
}

function insertPagesAfterSelection(document: PdfDocument, pages: InsertPageMetadata[]): PdfDocument {
  if (pages.length === 0) {
    return document;
  }

  const insertAfter = clampPageNumber(document.lastSelectedPageNumber, document.pages.length);
  const insertIndex = document.pages.findIndex((page) => page.pageNumber === insertAfter);
  const safeInsertIndex = insertIndex < 0 ? document.pages.length - 1 : insertIndex;
  const firstInsertedPageNumber = safeInsertIndex + 2;
  const insertedPages = pages.map((page, index) => ({
    deleted: false,
    id: crypto.randomUUID(),
    paintEdits: [],
    pageNumber: document.pages.length + index + 1,
    previewVariant: (document.pages.length + index + 1) % 6,
    rotation: 0 as const,
    source: page.source,
    tinted: false,
  }));
  const nextPages = [...document.pages.slice(0, safeInsertIndex + 1), ...insertedPages, ...document.pages.slice(safeInsertIndex + 1)];
  const selectedPages = new Set<number>();
  for (let offset = 0; offset < insertedPages.length; offset += 1) {
    selectedPages.add(firstInsertedPageNumber + offset);
  }

  return markDirty(
    {
      ...normalizePageStructure({
        ...document,
        lastSelectedPageNumber: firstInsertedPageNumber,
        pages: nextPages,
        selectedPages,
      }),
      lastSelectedPageNumber: firstInsertedPageNumber,
      selectedPages,
    },
  );
}

function addPagePaintEdit(document: PdfDocument, pageNumber: number, edit: PdfPagePaintEdit): PdfDocument {
  const nextDocument = updatePage(document, pageNumber, (page) => ({
    ...page,
    paintEdits: [...page.paintEdits, edit],
  }));

  return isMeaningfulPaintEdit(edit) ? markDirty(nextDocument) : nextDocument;
}

function removePagePaintEdit(document: PdfDocument, pageNumber: number, editId: string): PdfDocument {
  const removedEdit = document.pages.find((page) => page.pageNumber === pageNumber)?.paintEdits.find((paintEdit) => paintEdit.id === editId);
  const nextDocument = updatePage(document, pageNumber, (page) => ({
      ...page,
      paintEdits: page.paintEdits.filter((paintEdit) => paintEdit.id !== editId),
    }));

  return removedEdit && isMeaningfulPaintEdit(removedEdit) ? markDirty(nextDocument) : nextDocument;
}

function undoPagePaintEdit(document: PdfDocument, pageNumber: number): PdfDocument {
  const page = document.pages.find((candidate) => candidate.pageNumber === pageNumber);
  if (!page || page.paintEdits.length === 0) {
    return document;
  }

  return markDirty(
    updatePage(document, pageNumber, (pageToUpdate) => ({
      ...pageToUpdate,
      paintEdits: pageToUpdate.paintEdits.slice(0, -1),
    })),
  );
}

function updatePagePaintEdit(document: PdfDocument, pageNumber: number, edit: PdfPagePaintEdit): PdfDocument {
  const previousEdit = document.pages.find((page) => page.pageNumber === pageNumber)?.paintEdits.find((paintEdit) => paintEdit.id === edit.id);
  const nextDocument = updatePage(document, pageNumber, (page) => {
      const paintEdits = page.paintEdits.map((paintEdit) => (paintEdit.id === edit.id ? edit : paintEdit));
      return { ...page, paintEdits };
    });

  return isMeaningfulPaintEdit(edit) || (previousEdit ? isMeaningfulPaintEdit(previousEdit) : false) ? markDirty(nextDocument) : nextDocument;
}

function isMeaningfulPaintEdit(edit: PdfPagePaintEdit): boolean {
  if (edit.type === "text") {
    return edit.text.trim().length > 0;
  }

  return edit.type === "cover" || edit.type === "crop" || (edit.type === "straighten" && Math.abs(edit.degrees) > 0.001);
}

function deleteSelectedPages(document: PdfDocument): PdfDocument {
  return deletePages(document, document.selectedPages);
}

function deletePages(document: PdfDocument, pageNumbersToDelete: Set<number>): PdfDocument {
  if (pageNumbersToDelete.size === 0 || document.pages.length <= pageNumbersToDelete.size) {
    return document;
  }

  const firstDeletedPageNumber = Math.min(...pageNumbersToDelete);
  const nextPages = document.pages.filter((page) => !pageNumbersToDelete.has(page.pageNumber));
  const nextSelectedPageNumber = Math.min(Math.max(1, firstDeletedPageNumber), nextPages.length);

  return markDirty(
    {
      ...normalizePageStructure({
        ...document,
        lastSelectedPageNumber: nextSelectedPageNumber,
        pages: nextPages,
        selectedPages: new Set([nextSelectedPageNumber]),
      }),
      lastSelectedPageNumber: nextSelectedPageNumber,
      selectedPages: new Set([nextSelectedPageNumber]),
    },
  );
}

function movePagesBefore(document: PdfDocument, draggedPageNumber: number, beforePageNumber: number): PdfDocument {
  const draggedPage = document.pages.find((page) => page.pageNumber === draggedPageNumber);
  if (!draggedPage) {
    return document;
  }

  const movingPageNumbers = document.selectedPages.has(draggedPageNumber) ? document.selectedPages : new Set([draggedPageNumber]);
  const movingPages = document.pages.filter((page) => movingPageNumbers.has(page.pageNumber));
  if (movingPages.length === 0 || movingPages.length >= document.pages.length) {
    return document;
  }

  const remainingPages = document.pages.filter((page) => !movingPageNumbers.has(page.pageNumber));
  const clampedBeforePage = Math.min(Math.max(1, beforePageNumber), document.pages.length + 1);
  const insertIndex =
    clampedBeforePage > document.pages.length
      ? remainingPages.length
      : remainingPages.findIndex((page) => page.pageNumber >= clampedBeforePage);
  const safeInsertIndex = insertIndex < 0 ? remainingPages.length : insertIndex;
  const nextPages = [...remainingPages.slice(0, safeInsertIndex), ...movingPages, ...remainingPages.slice(safeInsertIndex)];

  if (nextPages.every((page, index) => page.id === document.pages[index]?.id)) {
    return document;
  }

  const movedPageIds = new Set(movingPages.map((page) => page.id));
  const selectedPages = new Set<number>();
  let nextLastSelectedPageNumber = 1;
  const pages = nextPages.map((page, index) => {
    const pageNumber = index + 1;
    if (movedPageIds.has(page.id)) {
      selectedPages.add(pageNumber);
      if (page.id === draggedPage.id) {
        nextLastSelectedPageNumber = pageNumber;
      }
    }

    return {
      ...page,
      pageNumber,
      previewVariant: pageNumber % 6,
    };
  });

  const cutBeforePages = new Set<number>();
  for (const cutBeforePage of document.cutBeforePages) {
    if (cutBeforePage > 1 && cutBeforePage <= pages.length) {
      cutBeforePages.add(cutBeforePage);
    }
  }

  return markDirty({
    ...document,
    cutBeforePages,
    lastSelectedPageNumber: nextLastSelectedPageNumber,
    pages,
    selectedPages,
  });
}

function normalizePageStructure(document: PdfDocument): PdfDocument {
  const oldToNewPageNumber = new Map<number, number>();
  const pages = document.pages.map((page, index) => {
    const pageNumber = index + 1;
    oldToNewPageNumber.set(page.pageNumber, pageNumber);
    return {
      ...page,
      pageNumber,
      previewVariant: pageNumber % 6,
    };
  });
  const selectedPages = new Set<number>();

  for (const selectedPageNumber of document.selectedPages) {
    const nextSelectedPageNumber = oldToNewPageNumber.get(selectedPageNumber);
    if (nextSelectedPageNumber) {
      selectedPages.add(nextSelectedPageNumber);
    }
  }

  if (selectedPages.size === 0 && pages.length > 0) {
    selectedPages.add(Math.min(document.lastSelectedPageNumber, pages.length));
  }

  const cutBeforePages = new Set<number>();
  for (const cutBeforePage of document.cutBeforePages) {
    const nextCut = oldToNewPageNumber.get(cutBeforePage);
    if (nextCut && nextCut > 1) {
      cutBeforePages.add(nextCut);
    }
  }

  return {
    ...document,
    cutBeforePages,
    lastSelectedPageNumber: Math.min(document.lastSelectedPageNumber, Math.max(1, pages.length)),
    pages,
    selectedPages,
  };
}

function rebaseSavedDocument(document: PdfDocument, metadata: PdfMetadata): PdfDocument {
  const pages = document.pages.map((page, index): PdfPage => {
    const pageNumber = index + 1;

    return {
      ...page,
      id: `page-${pageNumber}-${crypto.randomUUID()}`,
      paintEdits: [],
      pageNumber,
      previewVariant: pageNumber % 6,
      rotation: 0,
      source: {
        fileName: metadata.fileName,
        filePath: metadata.filePath,
        pageNumber,
        type: "pdf",
      },
    };
  });
  const selectedPages = new Set([...document.selectedPages].filter((pageNumber) => pageNumber <= pages.length));
  if (selectedPages.size === 0 && pages.length > 0) {
    selectedPages.add(Math.min(document.lastSelectedPageNumber, pages.length));
  }

  return {
    ...document,
    fileName: metadata.fileName,
    filePath: metadata.filePath,
    id: crypto.randomUUID(),
    isDirty: false,
    lastSelectedPageNumber: Math.min(document.lastSelectedPageNumber, Math.max(1, pages.length)),
    pages,
    selectedPages,
    sizeBytes: metadata.sizeBytes,
  };
}

function markDirty(document: PdfDocument): PdfDocument {
  return { ...document, isDirty: true };
}

function clampPageNumber(pageNumber: number, pageCount: number): number {
  return Math.min(Math.max(1, pageNumber), Math.max(1, pageCount));
}

function updatePage(
  document: PdfDocument,
  pageNumber: number,
  updater: (page: PdfDocument["pages"][number]) => PdfDocument["pages"][number],
): PdfDocument {
  const pages = document.pages.map((page) => (page.pageNumber === pageNumber ? updater(page) : page));
  return { ...document, pages };
}

function rotate(current: 0 | 90 | 180 | 270, degrees: 90 | 180 | 270): 0 | 90 | 180 | 270 {
  return ((current + degrees) % 360) as 0 | 90 | 180 | 270;
}

function clampThumbnailScale(scale: number): number {
  return Math.min(THUMBNAIL_SCALE_MAX, Math.max(THUMBNAIL_SCALE_MIN, scale));
}
