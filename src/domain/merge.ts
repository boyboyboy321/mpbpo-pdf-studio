import type { PdfMetadata } from "./pdf";

export type MergeOutputMode = "customFolder" | "siblingFolder";

export interface MergeOutputOptions {
  mode: MergeOutputMode;
  customFolderPath: string | null;
}

export interface MergeIssue {
  filePath: string;
  fileName: string;
  pageNumber: number | null;
  message: string;
}

export interface MergeProgress {
  runId: string;
  phase: "checking" | "merging" | "writing" | "complete";
  completedFiles: number;
  totalFiles: number;
  currentFileName: string;
  completedPages: number;
  totalPages: number | null;
}

export interface MergeResult {
  file: PdfMetadata | null;
  outputDir: string | null;
  issues: MergeIssue[];
}
