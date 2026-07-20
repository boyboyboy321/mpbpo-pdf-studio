import type { PdfDocument, PdfPage } from "../domain/pdf";

const PAGE_MARKS_STORAGE_KEY = "splitpdf.pageMarks.v1";

type StoredPageMarks = Record<string, string[]>;

export function applyStoredPageMarks(document: PdfDocument): PdfDocument {
  const documentKey = getDocumentMarkKey(document);
  if (!documentKey) {
    return document;
  }

  const markedPages = new Set(readStoredPageMarks()[documentKey] ?? []);
  if (markedPages.size === 0) {
    return document;
  }

  return {
    ...document,
    pages: document.pages.map((page) => ({
      ...page,
      tinted: markedPages.has(getPageMarkKey(page)),
    })),
  };
}

export function saveDocumentPageMarks(document: PdfDocument): void {
  const documentKey = getDocumentMarkKey(document);
  if (!documentKey) {
    return;
  }

  const stored = readStoredPageMarks();
  const markedPageKeys = document.pages.filter((page) => page.tinted).map(getPageMarkKey);

  if (markedPageKeys.length === 0) {
    delete stored[documentKey];
  } else {
    stored[documentKey] = markedPageKeys;
  }

  writeStoredPageMarks(stored);
}

function getDocumentMarkKey(document: PdfDocument): string | null {
  return document.filePath ? normalizePathKey(document.filePath) : null;
}

function getPageMarkKey(page: PdfPage): string {
  const source = page.source;

  if (source.type === "image") {
    return `image:${normalizePathKey(source.filePath)}:${source.width}x${source.height}`;
  }

  return `pdf:${normalizePathKey(source.filePath)}:${source.pageNumber}`;
}

function readStoredPageMarks(): StoredPageMarks {
  try {
    const rawValue = window.localStorage.getItem(PAGE_MARKS_STORAGE_KEY);
    if (!rawValue) {
      return {};
    }

    const parsed = JSON.parse(rawValue);
    if (!isRecord(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string[]] => {
        const [key, value] = entry;
        return typeof key === "string" && Array.isArray(value) && value.every((item) => typeof item === "string");
      }),
    );
  } catch {
    return {};
  }
}

function writeStoredPageMarks(marks: StoredPageMarks) {
  try {
    window.localStorage.setItem(PAGE_MARKS_STORAGE_KEY, JSON.stringify(marks));
  } catch {
    // Marking pages is a convenience feature, so storage failures should not block editing.
  }
}

function normalizePathKey(path: string): string {
  return path.trim().replaceAll("\\", "/").toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
