import type { PdfDocument, PdfMetadata, PdfPage, PdfPageSource, ToolItem } from "../domain/pdf";
import { loadEditorPreferences } from "../services/editorPreferences";

export function createPages(count: number, sourcePath: string | null = null, sourceFileName = "document.pdf"): PdfPage[] {
  return Array.from({ length: count }, (_, index) => {
    const pageNumber = index + 1;
    const source = createPdfPageSource(sourcePath, sourceFileName, pageNumber);

    return {
      id: `page-${pageNumber}`,
      paintEdits: [],
      pageNumber,
      previewVariant: pageNumber % 6,
      rotation: 0,
      source,
      deleted: false,
      tinted: false,
    };
  });
}

function createPdfPageSource(filePath: string | null, fileName: string, pageNumber: number): PdfPageSource {
  return {
    fileName,
    filePath: filePath ?? "",
    pageNumber,
    type: "pdf",
  };
}

export function createDocumentFromMetadata(metadata: PdfMetadata): PdfDocument {
  return createDocument({
    filePath: metadata.filePath,
    fileName: metadata.fileName,
    sizeBytes: metadata.sizeBytes,
    pageCount: metadata.pageCount,
  });
}

export function createDemoDocument(): PdfDocument {
  return createDocument({
    filePath: null,
    fileName: "site-survey-scan.pdf",
    sizeBytes: 58_200_000,
    pageCount: 48,
  });
}

export function createDocument(input: { filePath: string | null; fileName: string; sizeBytes: number; pageCount: number }): PdfDocument {
  const preferences = loadEditorPreferences();

  return {
    detailPanelVisible: preferences.detailPanelVisible,
    id: crypto.randomUUID(),
    isDirty: false,
    filePath: input.filePath,
    fileName: input.fileName,
    lastSelectedPageNumber: 1,
    sizeBytes: input.sizeBytes,
    pages: createPages(Math.max(1, input.pageCount), input.filePath, input.fileName),
    selectedPages: new Set([1]),
    cutBeforePages: new Set(),
    hoverZoomEnabled: false,
    customRenderQuality: preferences.customRenderQuality,
    renderQualityPreset: preferences.renderQualityPreset,
    thumbnailScale: preferences.thumbnailScale,
  };
}

export const tools: ToolItem[] = [
  { id: "split", label: "Split PDF", tone: "blue" },
  { id: "compress", label: "Compress PDF", tone: "red" },
  { id: "office", label: "PDF to Office", tone: "red" },
  { id: "image", label: "PDF to Image", tone: "yellow" },
  { id: "protect", label: "Protect PDF", tone: "pink" },
  { id: "merge", label: "Merge PDF", tone: "purple" },
];
