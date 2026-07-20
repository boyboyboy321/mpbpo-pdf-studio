import { FileImage, FilePenLine, Files, Folder, Home, Plus, Search, Upload } from "lucide-react";
import { useState } from "react";

import type { PdfLoadState, RecentFile, ToolItem } from "../domain/pdf";
import { tools } from "../utils/demoPages";

interface HomeViewProps {
  isFileDragging: boolean;
  loadState: PdfLoadState;
  recentFiles: RecentFile[];
  onOpenDemo: () => void;
  onOpenRecent: (path: string) => void;
  onPickPdf: () => void;
}

const toolIcons: Record<ToolItem["id"], typeof Files> = {
  split: Files,
  edit: FilePenLine,
};

export function HomeView({ isFileDragging, loadState, recentFiles, onOpenDemo, onOpenRecent, onPickPdf }: HomeViewProps) {
  const [query, setQuery] = useState("");

  const filteredRecent = recentFiles.filter((file) => file.fileName.toLowerCase().includes(query.toLowerCase()));
  const hasRecentFiles = filteredRecent.length > 0;

  return (
    <main className="home-shell">
      <div className="home-tabs">
        <button className="tab-button is-active" type="button">
          <Home size={19} />
          Home
        </button>
        <button className="tab-add" type="button" onClick={onPickPdf} aria-label="Open another PDF">
          <Plus size={18} />
        </button>
      </div>

      <div className="home-layout">
        <aside className="home-sidebar">
          <button className="primary-open" type="button" onClick={onPickPdf}>
            <Plus size={20} />
            Open
          </button>

          <section className="sidebar-section">
            <h2>Files</h2>
            <button className="sidebar-link is-selected" type="button">
              <Folder size={22} />
              All documents
            </button>
          </section>

          <section className="sidebar-section">
            <h2>Tools</h2>
            <div className="tool-list">
              {tools.map((tool) => {
                const Icon = toolIcons[tool.id] ?? FileImage;
                return (
                  <button className="tool-card" type="button" key={tool.id}>
                    <span className={`tool-icon tone-${tool.tone}`}>
                      <Icon size={20} />
                    </span>
                    {tool.label}
                  </button>
                );
              })}
            </div>
          </section>
        </aside>

        <section className="home-content">
          <label className="search-box">
            <Search size={24} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search file" />
          </label>
          <LoadNotice state={loadState} />

          <div className={`drop-home ${isFileDragging ? "is-dragging" : ""} ${hasRecentFiles ? "has-recent" : ""}`}>
            {!hasRecentFiles ? (
              <div className="empty-state">
                <div className="empty-illustration" aria-hidden="true">
                  <Upload size={40} />
                </div>
                <p>No items match your search.</p>
                <div className="empty-actions">
                  <button className="primary-action" type="button" onClick={onPickPdf}>
                    Open PDF
                  </button>
                  <button className="secondary-action" type="button" onClick={onOpenDemo}>
                    Try demo
                  </button>
                </div>
              </div>
            ) : (
              <div className="recent-grid">
                {filteredRecent.map((file) => (
                  <button
                    className="recent-file"
                    type="button"
                    key={file.id}
                    title={file.filePath}
                    onClick={() => onOpenRecent(file.filePath)}
                  >
                    <span className="recent-icon">
                      <Files size={24} />
                    </span>
                    <span>
                      <strong>{file.fileName}</strong>
                      <small>
                        {file.pageCount} pages - {file.updatedAt}
                      </small>
                      <small className="recent-path">{file.filePath}</small>
                    </span>
                    <em>{file.status}</em>
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function LoadNotice({ state }: { state: PdfLoadState }) {
  if (state.status === "idle") {
    return null;
  }

  return <div className={`load-notice is-${state.status}`}>{state.message}</div>;
}
