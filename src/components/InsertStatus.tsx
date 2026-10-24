import { CheckCircle2, CircleAlert, LoaderCircle, X } from "lucide-react";
import { useRef } from "react";

import type { InsertIssue, InsertProgressEvent } from "../domain/pdf";

export type InsertState =
  | { status: "idle" }
  | { status: "running"; progress: InsertProgressEvent }
  | { status: "success"; pageCount: number }
  | { status: "error"; issues: InsertIssue[]; message?: string };

export function InsertStatus({ state, onDismiss }: { state: InsertState; onDismiss: () => void }) {
  const detailsRef = useRef<HTMLDialogElement>(null);
  if (state.status === "idle") return null;

  const progress = state.status === "running" ? state.progress : null;
  const issues = progress?.issues ?? (state.status === "error" ? state.issues : []);
  const errorMessage = state.status === "error" ? state.message : undefined;
  const failedFiles = [...new Map(issues.map((issue) => [issue.filePath, issue.fileName])).values()].join(", ");
  const hasDetails = issues.length > 0 || Boolean(errorMessage);
  const scanning = progress?.phase === "scanning";
  const message = progress
    ? scanning
      ? `Checking files ${progress.completedFiles}/${progress.totalFiles}`
      : progress.totalPages === null
        ? `Checking pages: ${progress.completedPages} checked`
        : `Preparing insert ${progress.completedPages}/${progress.totalPages} pages`
    : state.status === "success"
      ? `Inserted ${state.pageCount} pages`
      : "Insert cancelled";

  return (
    <section className={`insert-status is-${state.status}`} aria-label="Insert status" aria-busy={state.status === "running"}>
        <span className="insert-status-message" role="status" aria-live="polite" title={message}>
          {progress ? <LoaderCircle className="insert-spinner" size={15} /> : state.status === "success" ? <CheckCircle2 size={15} /> : null}
          <span className="insert-status-text">{message}</span>
        </span>
        {progress?.currentFileName ? <span className="insert-current-file" title={progress.currentFileName}>{progress.currentFileName}</span> : null}
        {failedFiles ? <span className="insert-failed-files" title={failedFiles}>{failedFiles}</span> : null}
        {hasDetails ? <button type="button" className="insert-status-details" aria-label="View insert error details" title="View error details" onClick={() => detailsRef.current?.showModal()}><CircleAlert size={16} /></button> : null}
        {!progress ? <button type="button" className="insert-status-dismiss" aria-label="Dismiss insert status" title="Dismiss" onClick={onDismiss}><X size={15} /></button> : null}
      {hasDetails ? (
        <dialog
          ref={detailsRef}
          className="insert-error-details"
          aria-label="Insert error details"
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            if (event.target !== event.currentTarget) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
              event.currentTarget.close();
            }
          }}
        >
          <header>
            <h2>Insert errors</h2>
            <button type="button" className="insert-status-dismiss" aria-label="Close insert error details" title="Close" onClick={() => detailsRef.current?.close()}><X size={17} /></button>
          </header>
          <p>{progress ? "The batch will be cancelled after checking the remaining files." : "Insert cancelled. No pages were added."}</p>
          {errorMessage ? <p className="insert-error-message">{errorMessage}</p> : null}
          {issues.length > 0 ? (
            <ul className="insert-issues" aria-label="Files that could not be inserted">
              {issues.map((issue, index) => (
                <li key={`${issue.filePath}:${issue.pageNumber}:${index}`}>
                  <strong title={issue.filePath}>{issue.fileName}{issue.pageNumber !== null ? ` - page ${issue.pageNumber}` : ""}</strong>
                  <span>{issue.message}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </dialog>
      ) : null}
    </section>
  );
}
