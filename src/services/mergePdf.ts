import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { MergeOutputOptions, MergeProgress, MergeResult } from "../domain/merge";
import type { PdfMetadata } from "../domain/pdf";

export async function pickMergeFiles(): Promise<string[]> {
  if (!isTauri()) return [];
  const result = await open({ multiple: true, title: "Merge PDF", filters: [{ name: "PDF", extensions: ["pdf"] }] });
  return typeof result === "string" ? [result] : result ?? [];
}

export async function pickMergeFolder(): Promise<string | null> {
  if (!isTauri()) return null;
  const result = await open({ directory: true, multiple: false, title: "Choose merge output folder" });
  return typeof result === "string" ? result : null;
}

export function readMergeMetadata(path: string): Promise<PdfMetadata> {
  return invoke<PdfMetadata>("read_merge_metadata", { path });
}

export async function mergePdfFiles(
  paths: string[],
  outputOptions: MergeOutputOptions,
  runId: string,
  onProgress: (progress: MergeProgress) => void,
): Promise<MergeResult> {
  let accepting = true;
  const unlisten = await listen<MergeProgress>("merge-progress", ({ payload }) => {
    if (accepting && payload.runId === runId) onProgress(payload);
  });
  try {
    return await invoke<MergeResult>("merge_pdf", { paths, outputOptions, runId });
  } finally {
    accepting = false;
    await Promise.resolve(unlisten()).catch((error: unknown) => console.warn("Could not remove merge progress listener", error));
  }
}
