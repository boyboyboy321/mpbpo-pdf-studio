import { History, X } from "lucide-react";
import { useRef } from "react";
import { createPortal } from "react-dom";
import { name, version } from "../../package.json";
import { releaseNotes } from "../domain/releaseNotes";
import "../styles/release-notes.css";

export function ReleaseNotesButton() {
  const button = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);

  return (
    <>
      <button
        ref={button}
        className="release-notes-trigger"
        type="button"
        aria-label="What's new"
        aria-haspopup="dialog"
        title="What's new"
        onPointerDown={event => event.stopPropagation()}
        onClick={() => {
          dialog.current?.showModal();
          if (body.current) body.current.scrollTop = 0;
        }}
      >
        <History size={16} aria-hidden="true" />
      </button>
      {createPortal(
        <dialog
          ref={dialog}
          className="release-notes-dialog"
          data-release-notes-dialog
          aria-labelledby="release-notes-title"
          onKeyDown={event => event.stopPropagation()}
          onClose={() => button.current?.focus({ preventScroll: true })}
          onClick={event => {
            if (event.target !== event.currentTarget) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
              event.currentTarget.close();
            }
          }}
        >
          <header className="release-notes-header">
            <div>
              <h2 id="release-notes-title">What's new</h2>
              <p>MpBPO PDF Studio{name.endsWith("-offline") ? " Offline" : ""} / {version}</p>
            </div>
            <button className="release-notes-close" type="button" aria-label="Close release notes" title="Close" onClick={() => dialog.current?.close()}>
              <X size={19} aria-hidden="true" />
            </button>
          </header>
          <div ref={body} className="release-notes-body" tabIndex={0} role="region" aria-label="Release notes">
            {releaseNotes.map(section => (
              <section key={section.title}>
                <h3>{section.title}</h3>
                <ul>{section.items.map(item => <li key={item}>{item}</li>)}</ul>
              </section>
            ))}
          </div>
        </dialog>,
        document.body,
      )}
    </>
  );
}
