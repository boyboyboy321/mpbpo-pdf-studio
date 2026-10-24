import type { RenderQualityPreset, RenderQualitySettings } from "./pdfSettings";

export type PdfPageSource =
  | {
      fileName: string;
      filePath: string;
      pageNumber: number;
      type: "pdf";
    }
  | {
      fileName: string;
      filePath: string;
      height: number;
      type: "image";
      width: number;
    };

export interface PdfPage {
  id: string;
  pageNumber: number;
  paintEdits: PdfPagePaintEdit[];
  previewVariant: number;
  rotation: 0 | 90 | 180 | 270;
  source: PdfPageSource;
  deleted: boolean;
  tinted: boolean;
}

export type PdfPagePaintEdit =
  | {
      color: string;
      height: number;
      id: string;
      type: "cover";
      width: number;
      x: number;
      y: number;
    }
  | {
      height: number;
      id: string;
      type: "crop";
      width: number;
      x: number;
      y: number;
    }
  | {
      degrees: number;
      id: string;
      type: "straighten";
    }
  | {
      bold: boolean;
      color: string;
      fontFamily: string;
      fontSize: number;
      height: number;
      id: string;
      italic: boolean;
      textAlign: PdfTextAlign;
      text: string;
      type: "text";
      underline: boolean;
      width: number;
      x: number;
      y: number;
    };

export type PdfTextAlign = "left" | "center" | "right";

export type SplitOutputMode = "siblingFolder" | "originalFolderDeleteOriginal" | "customFolder";
export type ThumbnailLayoutMode = "grid" | "large1" | "large2" | "large3";

export interface PdfDocumentUndoSnapshot {
  cutBeforePages: number[];
  focusPageNumber: number;
  lastSelectedPageNumber: number;
  pages: PdfPage[];
  selectedPages: number[];
}

export interface PdfDocument {
  detailPanelVisible: boolean;
  id: string;
  isDirty: boolean;
  filePath: string | null;
  fileName: string;
  lastSelectedPageNumber: number;
  sizeBytes: number;
  pages: PdfPage[];
  previewUndoStack: PdfDocumentUndoSnapshot[];
  selectedPages: Set<number>;
  cutBeforePages: Set<number>;
  hoverZoomEnabled: boolean;
  customRenderQuality: RenderQualitySettings;
  renderQualityPreset: RenderQualityPreset;
  splitCustomOutputFolder: string | null;
  splitOutputMode: SplitOutputMode;
  thumbnailLayout: ThumbnailLayoutMode;
  thumbnailScale: number;
}

export type PdfLoadState =
  | { status: "idle" }
  | { status: "loading"; message: string }
  | { status: "error"; message: string };

export interface PdfMetadata {
  filePath: string;
  fileName: string;
  sizeBytes: number;
  pageCount: number;
}

export interface PdfPagePreview {
  pageNumber: number;
  width: number;
  height: number;
  dataUrl: string;
  filePath?: string;
}

export interface SplitOutputFile {
  filePath: string;
  fileName: string;
  startPage: number;
  endPage: number;
  pageCount: number;
  sizeBytes: number;
}

export interface SplitResult {
  outputDir: string;
  files: SplitOutputFile[];
  sourceDeleteError?: string | null;
}

export interface SplitOutputOptions {
  customFolderPath: string | null;
  mode: SplitOutputMode;
}

export interface SplitProgressEvent {
  runId: string;
  completedFiles: number;
  totalFiles: number;
  currentFileName: string;
}

export interface InsertPageMetadata {
  source: PdfPageSource;
}

export interface InsertIssue {
  filePath: string;
  fileName: string;
  pageNumber: number | null;
  message: string;
}

export interface InsertProgressEvent {
  runId: string;
  phase: "scanning" | "preparing" | "complete";
  completedFiles: number;
  totalFiles: number;
  currentFileName: string;
  completedPages: number;
  totalPages: number | null;
  issues: InsertIssue[];
}

export interface InsertBatchResult {
  pages: InsertPageMetadata[];
  issues: InsertIssue[];
}

export interface RecentFile {
  id: string;
  filePath: string;
  fileName: string;
  pageCount: number;
  sizeBytes: number;
  updatedAt: string;
  status: "local" | "server";
}

export interface ToolItem {
  id: string;
  label: string;
  tone: "red" | "blue" | "yellow" | "pink" | "purple" | "green";
}
