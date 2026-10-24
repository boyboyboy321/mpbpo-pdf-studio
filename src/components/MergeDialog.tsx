import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { CheckCircle2, CircleAlert, FilePlus2, FileText, FolderOpen, GripVertical, LoaderCircle, Merge, Trash2, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MergeIssue, MergeOutputMode, MergeProgress, MergeResult } from "../domain/merge";
import type { PdfMetadata } from "../domain/pdf";
import { mergePdfFiles, pickMergeFiles, pickMergeFolder, readMergeMetadata } from "../services/mergePdf";
import { getFriendlyLoadError } from "../services/pdfLoader";
import { formatBytes } from "../utils/format";
import "../styles/merge.css";

interface MergeFile {
  id: string;
  path: string;
  name: string;
  metadata: PdfMetadata | null;
  error: string | null;
}

interface MergeDialogProps {
  busy: boolean;
  dropRequest: { id: string; paths: string[] } | null;
  onBeginBusyJob: (job: { id: string; kind: "merge"; fileName: string; tabId: string }) => boolean;
  onEndBusyJob: (id: string) => void;
  onClose: () => void;
  onOpenPdf: (path: string) => void;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) || path;
}

function folderName(path: string): string {
  return path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))) || path;
}

function pathKey(path: string): string {
  return path.replaceAll("\\", "/").toLowerCase();
}

function MergeFileRow({ file, index, disabled, onRemove }: { file: MergeFile; index: number; disabled: boolean; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: file.id, disabled });
  return (
    <li ref={setNodeRef} className={`merge-file-row ${isDragging ? "is-dragging" : ""} ${file.error ? "has-error" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }} data-file-path={file.path}>
      <button className="merge-icon merge-grip" type="button" {...attributes} {...listeners}
        aria-label={`Move ${file.name}`} title="Move file" disabled={disabled}><GripVertical size={18} /></button>
      <span className="merge-order">{index + 1}</span>
      <FileText className="merge-file-icon" size={23} aria-hidden="true" />
      <span className="merge-file-name">
        <strong title={file.path}>{file.name}</strong>
        <small title={file.error ?? file.path}>{file.error ?? file.path}</small>
      </span>
      <span className="merge-file-meta">
        {file.metadata ? <><strong>{file.metadata.pageCount} pages</strong><small>{formatBytes(file.metadata.sizeBytes)}</small></> : file.error ? "Error" : <LoaderCircle size={17} className="merge-spinner" aria-label="Checking file" />}
      </span>
      <button className="merge-icon merge-remove" type="button" disabled={disabled} onClick={onRemove}
        aria-label={`Remove ${file.name}`} title="Remove file"><X size={18} /></button>
    </li>
  );
}

export function MergeDialog({ busy, dropRequest, onBeginBusyJob, onEndBusyJob, onClose, onOpenPdf }: MergeDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const running = useRef(false);
  const alive = useRef(true);
  const lastDrop = useRef<string | null>(null);
  const [files, setFiles] = useState<MergeFile[]>([]);
  const [mode, setMode] = useState<MergeOutputMode>("customFolder");
  const [folder, setFolder] = useState<string | null>(null);
  const [activity, setActivity] = useState<"idle" | "choosing" | "checking" | "merging">("idle");
  const [progress, setProgress] = useState<MergeProgress | null>(null);
  const [message, setMessage] = useState("");
  const [issues, setIssues] = useState<MergeIssue[]>([]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [result, setResult] = useState<MergeResult | null>(null);
  const disabled = busy || activity !== "idle";
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const totalPages = files.reduce((sum, file) => sum + (file.metadata?.pageCount ?? 0), 0);
  const totalBytes = files.reduce((sum, file) => sum + (file.metadata?.sizeBytes ?? 0), 0);
  const invalid = files.some(file => file.error || !file.metadata);
  const displayedIssues = [
    ...files.filter(file => file.error).map(file => ({ filePath: file.path, fileName: file.name, pageNumber: null, message: file.error ?? "" })),
    ...issues,
  ].filter((issue, index, all) => all.findIndex(other => other.filePath === issue.filePath && other.pageNumber === issue.pageNumber && other.message === issue.message) === index);

  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement;
    dialog.current?.showModal();
    return () => {
      alive.current = false;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  const resetOutcome = () => { setMessage(""); setIssues([]); setResult(null); setDetailsOpen(false); };

  const addPaths = useCallback(async (paths: string[]) => {
    if (running.current || busy || paths.length === 0) return;
    const known = new Set(files.map(file => pathKey(file.path)));
    const added = paths.filter(path => {
      const key = pathKey(path);
      if (known.has(key)) return false;
      known.add(key);
      return true;
    }).map(path => ({ id: crypto.randomUUID(), path, name: fileName(path), metadata: null, error: null } satisfies MergeFile));
    if (added.length === 0) return;
    const id = crypto.randomUUID();
    if (!onBeginBusyJob({ id, kind: "merge", fileName: "Merge PDF", tabId: "merge" })) return;
    running.current = true;
    setActivity("checking");
    resetOutcome();
    setFiles(current => [...current, ...added]);
    const failures: MergeIssue[] = [];
    try {
      for (const [index, file] of added.entries()) {
        if (!alive.current) break;
        setMessage(`Checking files ${index + 1}/${added.length}: ${file.name}`);
        try {
          const metadata = await readMergeMetadata(file.path);
          if (metadata.pageCount < 1) throw new Error("The PDF has no pages.");
          if (alive.current) setFiles(current => current.map(row => row.id === file.id ? { ...row, metadata } : row));
        } catch (error) {
          const message = getFriendlyLoadError(error);
          failures.push({ filePath: file.path, fileName: file.name, pageNumber: null, message });
          if (alive.current) setFiles(current => current.map(row => row.id === file.id ? { ...row, error: message } : row));
        }
      }
      if (alive.current) {
        setMessage(failures.length ? "Some files could not be opened." : "");
      }
    } finally {
      running.current = false;
      if (alive.current) setActivity("idle");
      onEndBusyJob(id);
    }
  }, [busy, files, onBeginBusyJob, onEndBusyJob]);

  useEffect(() => {
    if (!dropRequest || lastDrop.current === dropRequest.id) return;
    lastDrop.current = dropRequest.id;
    void addPaths(dropRequest.paths);
  }, [addPaths, dropRequest]);

  async function chooseFiles() {
    if (disabled || running.current) return;
    running.current = true;
    setActivity("choosing");
    let paths: string[] = [];
    try { paths = await pickMergeFiles(); }
    catch (error) { setMessage(getFriendlyLoadError(error)); }
    finally { running.current = false; if (alive.current) setActivity("idle"); }
    if (alive.current && paths.length) await addPaths(paths);
  }

  async function chooseFolder() {
    if (disabled || running.current) return;
    running.current = true;
    setActivity("choosing");
    try {
      const selected = await pickMergeFolder();
      if (alive.current && selected) setFolder(selected);
    } catch (error) { if (alive.current) setMessage(getFriendlyLoadError(error)); }
    finally { running.current = false; if (alive.current) setActivity("idle"); }
  }

  function reorder({ active, over }: DragEndEvent) {
    if (disabled || !over || active.id === over.id) return;
    setFiles(current => {
      const from = current.findIndex(file => file.id === active.id);
      const to = current.findIndex(file => file.id === over.id);
      return from < 0 || to < 0 ? current : arrayMove(current, from, to);
    });
    resetOutcome();
  }

  async function startMerge() {
    if (disabled || running.current || files.length < 2 || invalid) return;
    running.current = true;
    setActivity("choosing");
    resetOutcome();
    let jobId: string | null = null;
    try {
      let destination = folder;
      if (mode === "customFolder" && !destination) {
        destination = await pickMergeFolder();
        if (!destination || !alive.current) return;
        setFolder(destination);
      }
      const id = crypto.randomUUID();
      if (!onBeginBusyJob({ id, kind: "merge", fileName: "Merge PDF", tabId: "merge" })) {
        setMessage("Another file operation is running. Please wait.");
        return;
      }
      jobId = id;
      setActivity("merging");
      setProgress({ runId: id, phase: "checking", completedFiles: 0, totalFiles: files.length, currentFileName: "", completedPages: 0, totalPages });
      const merged = await mergePdfFiles(files.map(file => file.path), { mode, customFolderPath: mode === "customFolder" ? destination : null }, id, progress => {
        if (alive.current) setProgress(progress);
      });
      if (!alive.current) return;
      if (merged.issues.length) {
        setIssues(merged.issues);
        setMessage("Merge cancelled. No output file was created.");
      } else if (merged.file) {
        setResult(merged);
        setMessage("");
      } else {
        setMessage("Merge did not produce an output file.");
      }
    } catch (error) { if (alive.current) setMessage(getFriendlyLoadError(error)); }
    finally {
      running.current = false;
      if (alive.current) { setActivity("idle"); setProgress(null); }
      if (jobId) onEndBusyJob(jobId);
    }
  }

  const progressText = progress?.phase === "writing" ? "Writing merged PDF..."
    : progress ? `${progress.phase === "checking" ? "Checking" : "Merging"} files ${progress.completedFiles}/${progress.totalFiles} - ${progress.completedPages}${progress.totalPages !== null ? `/${progress.totalPages}` : ""} pages${progress.currentFileName ? ` - ${progress.currentFileName}` : ""}`
      : message || (displayedIssues.length ? "Some files could not be opened." : "");

  return (
    <dialog ref={dialog} className="merge-dialog" aria-labelledby="merge-title" data-merge-dialog
      onCancel={event => { event.preventDefault(); if (!disabled) onClose(); }}
      onClick={event => { if (event.target === event.currentTarget && !disabled) onClose(); }}>
      <div className="merge-shell">
        <header className="merge-header">
          <h2 id="merge-title"><Merge size={23} /> Merge PDF</h2>
          <button className="merge-icon" type="button" onClick={onClose} disabled={disabled} aria-label="Close merge" title="Close"><X size={21} /></button>
        </header>
        <div className="merge-toolbar">
          <button className="secondary-action compact" type="button" onClick={() => void chooseFiles()} disabled={disabled}><FilePlus2 size={18} /> Add PDFs</button>
          <span className="merge-summary">{files.length} files - {totalPages} pages - {formatBytes(totalBytes)}</span>
          <button className="merge-icon" type="button" disabled={disabled || files.length === 0} aria-label="Clear file list" title="Clear file list"
            onClick={() => { setFiles([]); resetOutcome(); }}><Trash2 size={18} /></button>
        </div>
        <div className="merge-list-scroll">
          {files.length ? <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={reorder}>
            <SortableContext items={files.map(file => file.id)} strategy={verticalListSortingStrategy}>
              <ol className="merge-file-list" aria-label="PDF merge order">
                {files.map((file, index) => <MergeFileRow key={file.id} file={file} index={index} disabled={disabled}
                  onRemove={() => { setFiles(current => current.filter(row => row.id !== file.id)); resetOutcome(); }} />)}
              </ol>
            </SortableContext>
          </DndContext> : <div className="merge-empty"><FileText size={36} aria-hidden="true" /><p>No PDF files selected</p></div>}
        </div>
        <section className="merge-destination" aria-label="Merge destination">
          <label htmlFor="merge-location">Files location</label>
          <select id="merge-location" value={mode} disabled={disabled} onChange={event => { setMode(event.target.value as MergeOutputMode); resetOutcome(); }}>
            <option value="customFolder">Choose folder</option>
            <option value="siblingFolder">New folder beside first PDF</option>
          </select>
          {mode === "customFolder" ? <button className="merge-folder" type="button" onClick={() => void chooseFolder()} disabled={disabled} title={folder ?? "Choose merge output folder"}>
            <FolderOpen size={18} /><span>{folder ?? "Choose folder..."}</span>
          </button> : <div className="merge-folder is-readonly" title={files[0] ? folderName(files[0].path) : undefined}>
            <FolderOpen size={18} /><span>{files[0] ? `${folderName(files[0].path)} / merge_...` : "No PDF files selected"}</span>
          </div>}
        </section>
        <div className="merge-status" role="status" aria-live="polite" aria-busy={activity !== "idle"}>
          {result?.file && !message ? <><CheckCircle2 className="merge-success-icon" size={18} /><span title={result.file.filePath}>Merged {result.file.pageCount} pages - {result.file.fileName}</span></>
            : <>{activity !== "idle" ? <LoaderCircle className="merge-spinner" size={18} /> : null}<span title={progressText}>{progressText || (files.length === 1 ? "Select at least two PDF files." : "")}</span></>}
          {displayedIssues.length > 0 ? <button className="merge-icon merge-error-icon" type="button" aria-label="View merge error details" title="View error details"
            aria-expanded={detailsOpen} onClick={() => setDetailsOpen(value => !value)}><CircleAlert size={19} /></button> : null}
        </div>
        {detailsOpen && displayedIssues.length > 0 ? <section className="merge-errors" aria-label="Merge errors">
          {displayedIssues.map((issue, index) => <div key={`${issue.filePath}-${index}`}><strong>{issue.fileName}{issue.pageNumber ? ` - page ${issue.pageNumber}` : ""}</strong><p>{issue.message}</p></div>)}
        </section> : null}
        <footer className="merge-footer">
          {result?.outputDir ? <button className="secondary-action compact" type="button" onClick={() => {
            void invoke("open_folder", { path: result.outputDir }).catch((error: unknown) => setMessage(getFriendlyLoadError(error)));
          }}><FolderOpen size={17} /> Open folder</button> : <span />}
          <div>
            {result?.file ? <button className="secondary-action compact" type="button" onClick={() => { if (result.file) { onOpenPdf(result.file.filePath); onClose(); } }}><FileText size={17} /> Open PDF</button> : null}
            <button className="primary-action compact" type="button" disabled={disabled || files.length < 2 || invalid} onClick={() => void startMerge()}>
              <Merge size={18} /> {activity === "merging" ? "Merging..." : "Merge"}
            </button>
          </div>
        </footer>
      </div>
    </dialog>
  );
}
