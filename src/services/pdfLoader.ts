import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

import type {
  InsertBatchResult,
  InsertProgressEvent,
  PdfDocument,
  PdfMetadata,
  PdfPage,
  PdfPagePaintEdit,
  PdfPagePreview,
  PdfPageSource,
  SplitOutputOptions,
  SplitResult,
} from "../domain/pdf";
import { createDocumentFromMetadata } from "../utils/demoPages";

export async function pickPdfFilePath(): Promise<string | null> {
  const paths = await pickPdfFilePaths();
  return paths[0] ?? null;
}

export async function pickPdfFilePaths(): Promise<string[]> {
  if (!isTauri()) {
    return [];
  }

  const selected = await open({
    multiple: true,
    title: "Open PDF",
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });

  if (typeof selected === "string") {
    return [selected];
  }

  return Array.isArray(selected) ? selected : [];
}

export async function pickInsertFilePaths(): Promise<string[]> {
  if (!isTauri()) {
    return [];
  }

  const selected = await open({
    multiple: true,
    title: "Insert PDF or image",
    filters: [{ name: "PDF or image", extensions: ["pdf", "png", "jpg", "jpeg", "tif", "tiff"] }],
  });

  if (typeof selected === "string") {
    return [selected];
  }

  return Array.isArray(selected) ? selected : [];
}

export async function pickSplitOutputFolderPath(): Promise<string | null> {
  if (!isTauri()) {
    return null;
  }

  const selected = await open({
    directory: true,
    multiple: false,
    title: "Choose split output folder",
  });

  return typeof selected === "string" ? selected : null;
}

export async function loadPdfDocumentFromPath(path: string): Promise<PdfDocument> {
  const metadata = await invoke<PdfMetadata>("read_pdf_metadata", { path });
  return createDocumentFromMetadata(metadata);
}

export async function readStartupPdfPath(): Promise<string | null> {
  const paths = await readStartupPdfPaths();
  return paths[0] ?? null;
}

export async function readStartupPdfPaths(): Promise<string[]> {
  if (!isTauri()) {
    return [];
  }

  return invoke<string[]>("read_startup_pdf_paths");
}

interface RenderPdfPagesOptions {
  jpegQuality?: number;
  priority?: boolean;
  renderLane?: "thumbnail" | "zoom" | "full";
}

interface ImageColorSample {
  color: string;
}

export async function sampleImageColor(filePath: string | undefined, x: number, y: number, radius: number): Promise<string | null> {
  if (!isTauri() || !filePath) {
    return null;
  }

  const sample = await invoke<ImageColorSample>("sample_image_color", {
    filePath,
    radius,
    x,
    y,
  });

  return sample.color;
}

export async function renderPdfPages(path: string, pageNumbers: number[], targetWidth: number, options: RenderPdfPagesOptions = {}): Promise<PdfPagePreview[]> {
  if (pageNumbers.length === 0) {
    return [];
  }

  const previews = await invoke<PdfPagePreview[]>("render_pdf_pages", {
    path,
    pageNumbers,
    jpegQuality: options.jpegQuality ?? null,
    priority: options.priority ?? false,
    renderLane: options.renderLane ?? null,
    targetWidth: Math.round(targetWidth),
  });

  return previews.map((preview) => ({
    ...preview,
    dataUrl: preview.filePath ? convertFileSrc(preview.filePath) : preview.dataUrl,
  }));
}

export async function renderDocumentPages(
  documentPath: string | null,
  pages: PdfPage[],
  targetWidth: number,
  options: RenderPdfPagesOptions = {},
): Promise<PdfPagePreview[]> {
  if (pages.length === 0) {
    return [];
  }

  const previews: PdfPagePreview[] = [];
  const pdfRequests = new Map<string, Map<number, PdfPage[]>>();

  for (const page of pages) {
    const source = normalizePageSource(page.source);

    if (source.type === "image") {
      previews.push({
        dataUrl: convertFileSrc(source.filePath),
        filePath: source.filePath,
        height: source.height,
        pageNumber: page.pageNumber,
        width: source.width,
      });
      continue;
    }

    const sourcePath = source.filePath || documentPath;
    if (!sourcePath) {
      continue;
    }

    const sourcePages = pdfRequests.get(sourcePath) ?? new Map<number, PdfPage[]>();
    const displayPages = sourcePages.get(source.pageNumber) ?? [];
    displayPages.push(page);
    sourcePages.set(source.pageNumber, displayPages);
    pdfRequests.set(sourcePath, sourcePages);
  }

  for (const [sourcePath, sourcePages] of pdfRequests) {
    const renderedPreviews = await renderPdfPages(sourcePath, [...sourcePages.keys()], targetWidth, options);

    for (const renderedPreview of renderedPreviews) {
      const displayPages = sourcePages.get(renderedPreview.pageNumber) ?? [];
      for (const page of displayPages) {
        previews.push({
          ...renderedPreview,
          pageNumber: page.pageNumber,
        });
      }
    }
  }

  return previews;
}

export async function splitPdfFile(path: string, cutBeforePages: number[], runId: string, outputOptions: SplitOutputOptions): Promise<SplitResult> {
  return invoke<SplitResult>("split_pdf", { path, cutBeforePages, outputOptions, runId });
}

export async function splitPdfDocument(
  document: PdfDocument,
  cutBeforePages: number[],
  runId: string,
  outputOptions: SplitOutputOptions,
): Promise<SplitResult> {
  if (!document.filePath) {
    throw new Error("Open a real PDF before splitting.");
  }

  return invoke<SplitResult>("split_pdf_with_edits", {
    cutBeforePages,
    outputOptions,
    pages: createEditPagePlans(document),
    path: document.filePath,
    runId,
  });
}

export async function readInsertPages(
  paths: string[],
  runId: string,
  onProgress: (progress: InsertProgressEvent) => void,
): Promise<InsertBatchResult> {
  if (paths.length === 0) {
    return { pages: [], issues: [] };
  }

  let acceptingProgress = true;
  const unlisten = await listen<InsertProgressEvent>("insert-progress", ({ payload }) => {
    if (acceptingProgress && payload.runId === runId) {
      onProgress(payload);
    }
  });
  try {
    const result = await invoke<InsertBatchResult>("read_insert_pages", { paths, runId });
    return {
      issues: result.issues,
      pages: result.issues.length > 0 ? [] : result.pages.map((page) => ({ source: normalizePageSource(page.source) })),
    };
  } finally {
    acceptingProgress = false;
    await Promise.resolve(unlisten()).catch((error: unknown) => console.warn("Could not remove insert progress listener", error));
  }
}

export async function savePdfEdits(document: PdfDocument): Promise<PdfMetadata> {
  if (!document.filePath) {
    throw new Error("Open a real PDF before saving.");
  }

  return invoke<PdfMetadata>("save_pdf_edits", {
    pages: createEditPagePlans(document),
    path: document.filePath,
  });
}

function normalizePaintEditForSave(edit: PdfPagePaintEdit): PdfPagePaintEdit {
  if (edit.type !== "text") {
    return edit;
  }

  return {
    ...edit,
    textAlign: edit.textAlign ?? "left",
  };
}

function createEditPagePlans(document: PdfDocument) {
  return document.pages.map((page) => ({
    paintEdits: page.paintEdits.map(normalizePaintEditForSave),
    rotation: page.rotation,
    source: normalizePageSource(page.source),
  }));
}

export async function openOutputFolder(path: string): Promise<void> {
  await invoke("open_folder", { path });
}

export function findFirstPdfPath(paths: string[]): string | null {
  return findPdfPaths(paths)[0] ?? null;
}

export function findPdfPaths(paths: string[]): string[] {
  return paths.filter((path) => path.toLowerCase().endsWith(".pdf"));
}

export function getFriendlyLoadError(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Could not open this PDF.";
}

function normalizePageSource(source: unknown): PdfPageSource {
  if (!isRecord(source)) {
    throw new Error("Inserted page source is invalid.");
  }

  const type = pickString(source, "type");
  const fileName = pickString(source, "fileName", "file_name") ?? "insert";
  const filePath = pickString(source, "filePath", "file_path") ?? "";

  if (type === "pdf") {
    const pageNumber = pickNumber(source, "pageNumber", "page_number");
    if (!filePath || !pageNumber) {
      throw new Error("Inserted PDF page is missing its source file.");
    }

    return {
      fileName,
      filePath,
      pageNumber,
      type: "pdf",
    };
  }

  if (type === "image") {
    const width = pickNumber(source, "width");
    const height = pickNumber(source, "height");
    if (!filePath || !width || !height) {
      throw new Error("Inserted image is missing its source file.");
    }

    return {
      fileName,
      filePath,
      height,
      type: "image",
      width,
    };
  }

  throw new Error("Inserted file type is not supported.");
}

function pickString(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }

  return null;
}

function pickNumber(record: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
