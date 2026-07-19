import type { PdfDocument, RecentFile } from "../domain/pdf";

const RECENT_FILES_STORAGE_KEY = "mpbpo-pdf-studio.recent-files";
const RECENT_FILE_LIMIT = 12;

interface StoredRecentFile {
  filePath: string;
  fileName: string;
  pageCount: number;
  sizeBytes: number;
  openedAt: number;
}

export function loadRecentFiles(): RecentFile[] {
  const stored = readStoredRecentFiles();
  return stored.map(toRecentFile);
}

export function rememberRecentDocument(document: PdfDocument): RecentFile[] {
  if (!document.filePath) {
    return loadRecentFiles();
  }

  const nextFile: StoredRecentFile = {
    fileName: document.fileName,
    filePath: document.filePath,
    openedAt: Date.now(),
    pageCount: document.pages.length,
    sizeBytes: document.sizeBytes,
  };

  const nextFiles = [nextFile, ...readStoredRecentFiles().filter((file) => file.filePath !== document.filePath)].slice(
    0,
    RECENT_FILE_LIMIT,
  );

  writeStoredRecentFiles(nextFiles);
  return nextFiles.map(toRecentFile);
}

function readStoredRecentFiles(): StoredRecentFile[] {
  try {
    const raw = localStorage.getItem(RECENT_FILES_STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(isStoredRecentFile).sort((left, right) => right.openedAt - left.openedAt);
  } catch {
    return [];
  }
}

function writeStoredRecentFiles(files: StoredRecentFile[]) {
  try {
    localStorage.setItem(RECENT_FILES_STORAGE_KEY, JSON.stringify(files));
  } catch {
    // Recent files are a convenience feature; opening PDFs should keep working if storage is unavailable.
  }
}

function toRecentFile(file: StoredRecentFile): RecentFile {
  return {
    fileName: file.fileName,
    filePath: file.filePath,
    id: file.filePath,
    pageCount: file.pageCount,
    sizeBytes: file.sizeBytes,
    status: inferFileLocation(file.filePath),
    updatedAt: formatOpenedAt(file.openedAt),
  };
}

function inferFileLocation(filePath: string): RecentFile["status"] {
  const normalizedPath = filePath.replace(/\\/g, "/").toLowerCase();
  if (normalizedPath.startsWith("//") || normalizedPath.includes("/10.") || normalizedPath.includes("10.10.")) {
    return "server";
  }

  return "local";
}

function formatOpenedAt(openedAt: number): string {
  const date = new Date(openedAt);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (isSameDay(date, today)) {
    return "Today";
  }

  if (isSameDay(date, yesterday)) {
    return "Yesterday";
  }

  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
  }).format(date);
}

function isSameDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function isStoredRecentFile(value: unknown): value is StoredRecentFile {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.filePath === "string" &&
    typeof value.fileName === "string" &&
    typeof value.pageCount === "number" &&
    Number.isFinite(value.pageCount) &&
    typeof value.sizeBytes === "number" &&
    Number.isFinite(value.sizeBytes) &&
    typeof value.openedAt === "number" &&
    Number.isFinite(value.openedAt)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
