import React from "react";
import { createRoot } from "react-dom/client";
import { RotateCcw } from "lucide-react";
import { EditorView } from "/src/components/EditorView.tsx";
import { createDocument } from "/src/utils/demoPages.ts";
import { documentReducer } from "/src/state/documentReducer.ts";
import "/src/styles/app.css";

const h = React.createElement;
const automated = new URLSearchParams(location.search).has("test");
const paths = Array.from({ length: 6 }, (_, index) => `C:/Demo/file${index + 1}.${index === 5 ? "tiff" : "pdf"}`);
const callbacks = new Map();
const listeners = new Map();
const requests = [];
const calls = [];
const actions = [];
const removedListeners = [];
let nextId = 1;
let pickerResult = paths;
let holdPicker = false;
let pendingPicker = null;
let showPicker = () => {};
let latestDocument = null;
let currentBusyJob = null;
let demoScenario = "success";

function pageImage(number, inserted = false) {
  const canvas = document.createElement("canvas");
  canvas.width = 420;
  canvas.height = 594;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 420, 594);
  ctx.fillStyle = inserted ? "#147d43" : "#175cc4";
  ctx.fillRect(30, 32, 360, 7);
  ctx.font = "bold 25px sans-serif";
  ctx.fillText(inserted ? "Inserted document" : "Demo document", 30, 84);
  ctx.fillStyle = "#333d4a";
  ctx.font = "15px sans-serif";
  ctx.fillText(`Sample page ${number}`, 30, 116);
  ctx.font = "13px sans-serif";
  ctx.fillText("Insert workflow / October 2026", 30, 144);
  for (let line = 0; line < 12; line++) {
    ctx.fillStyle = line % 3 === 0 ? "#a7b5c5" : "#dce3eb";
    ctx.fillRect(30, 190 + line * 23, line % 3 === 2 ? 265 : 360, 7);
  }
  ctx.fillStyle = "#647182";
  ctx.fillText(String(number), 380, 561);
  return canvas.toDataURL();
}

function insertPages(count = 3) {
  return Array.from({ length: count }, (_, index) => ({
    source: { type: "image", fileName: `inserted-${index + 1}.tiff`, filePath: pageImage(index + 1, true), width: 420, height: 594 },
  }));
}

function issues(long = false) {
  return Array.from({ length: long ? 14 : 2 }, (_, index) => {
    const fileNumber = 5 + index % 2;
    const fileName = long
      ? `file${fileNumber}_${"very-long-technical-attachment-name_".repeat(6)}.${fileNumber === 5 ? "pdf" : "tiff"}`
      : `file${fileNumber}.${fileNumber === 5 ? "pdf" : "tiff"}`;
    return {
      filePath: `C:/Demo/${fileName}`,
      fileName,
      pageNumber: index === 0 ? null : index + 1,
      message: index % 2 === 0 ? "Cannot read the PDF: the document is damaged." : "Cannot decode TIFF page: the image data is incomplete.",
    };
  });
}

function emitProgress(patch = {}, request = requests.at(-1)) {
  if (!request) throw new Error("No insert request is pending");
  const payload = {
    runId: request.runId, phase: "scanning", completedFiles: 0,
    totalFiles: request.paths.length, currentFileName: "", completedPages: 0,
    totalPages: null, issues: [], ...patch,
  };
  for (const [id, listener] of listeners) {
    if (listener.event === "insert-progress") callbacks.get(listener.handler)?.({ event: listener.event, id, payload });
  }
}

function finishRequest({ pageCount = 3, errors = [], rejection = null } = {}) {
  const request = requests.at(-1);
  if (!request || request.settled) throw new Error("No insert request is pending");
  request.settled = true;
  if (rejection) request.reject(rejection);
  else request.resolve({ pages: insertPages(pageCount), issues: errors });
}

async function playScenario(request) {
  // Only the interactive demo uses pacing; automated tests advance every event explicitly.
  const pause = () => new Promise(resolve => setTimeout(resolve, 480));
  for (let completedFiles = 1; completedFiles <= paths.length; completedFiles++) {
    await pause();
    emitProgress({ completedFiles, currentFileName: paths[completedFiles - 1].split("/").at(-1) }, request);
  }
  if (demoScenario === "failure") {
    finishRequest({ errors: issues(true) });
    return;
  }
  if (demoScenario === "rejection") {
    finishRequest({ rejection: "Demo: the insert worker stopped unexpectedly. Try again." });
    return;
  }
  for (let completedPages = 0; completedPages <= 3; completedPages++) {
    await pause();
    emitProgress({ phase: "preparing", completedFiles: 6, totalPages: 3, completedPages, currentFileName: "appendix.tiff" }, request);
  }
  finishRequest();
}

function choose(result) {
  if (!pendingPicker) throw new Error("The demo picker is not open");
  const resolve = pendingPicker;
  pendingPicker = null;
  showPicker(false);
  resolve(result);
}

// Keep the actual Tauri JS APIs and loader active; replace only the native IPC boundary.
window.isTauri = true;
window.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "insert-demo" }, currentWebview: { label: "insert-demo" } },
  convertFileSrc: path => path,
  transformCallback(callback) {
    const id = nextId++;
    callbacks.set(id, callback);
    return id;
  },
  unregisterCallback: id => callbacks.delete(id),
  async invoke(command, args) {
    calls.push({ command, args });
    if (command === "plugin:event|listen") {
      const id = nextId++;
      listeners.set(id, { ...args });
      return id;
    }
    if (command === "plugin:event|unlisten") {
      removedListeners.push(args);
      return;
    }
    if (command === "plugin:dialog|open") {
      if (automated && !holdPicker) return pickerResult;
      return new Promise(resolve => { pendingPicker = resolve; showPicker(true); });
    }
    if (command === "read_insert_pages") {
      return new Promise((resolve, reject) => {
        const listener = [...listeners.values()].find(item => item.event === "insert-progress");
        const request = { ...args, resolve, reject, settled: false, callback: callbacks.get(listener?.handler) };
        requests.push(request);
        if (!automated) void playScenario(request);
      });
    }
    if (command === "save_pdf_edits") {
      return { filePath: latestDocument.filePath, fileName: latestDocument.fileName, pageCount: latestDocument.pages.length, sizeBytes: 42000 };
    }
    throw new Error(`Unmocked native command: ${command}`);
  },
};
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener(event, id) {
    const listener = listeners.get(id);
    if (listener?.event !== event) throw new Error(`Unknown listener ${event}:${id}`);
    callbacks.delete(listener.handler);
    listeners.delete(id);
  },
};

window.__insertFixture = {
  paths,
  issues,
  configurePicker({ result = paths, hold = false } = {}) { pickerResult = result; holdPicker = hold; },
  choose,
  emit: emitProgress,
  finish: finishRequest,
  replay(requestIndex, patch = {}) {
    const request = requests[requestIndex];
    request.callback({ event: "insert-progress", id: -1, payload: {
      runId: request.runId, phase: "preparing", completedFiles: 6, totalFiles: 6,
      currentFileName: "stale-event.tiff", completedPages: 99, totalPages: 99, issues: [], ...patch,
    } });
  },
  snapshot() {
    return {
      document: latestDocument ? {
        pages: latestDocument.pages.map(({ id, pageNumber, rotation, source }) => ({ id, pageNumber, rotation, fileName: source.fileName })),
        isDirty: latestDocument.isDirty,
        selectedPages: [...latestDocument.selectedPages],
        cuts: [...latestDocument.cutBeforePages],
        undoCount: latestDocument.previewUndoStack.length,
      } : null,
      calls, actions, removedListeners, busyJob: currentBusyJob,
      activeInsertListeners: [...listeners.values()].filter(listener => listener.event === "insert-progress").length,
      requests: requests.map(({ runId, paths, settled }) => ({ runId, paths, settled })),
      pickerPending: Boolean(pendingPicker),
    };
  },
};

function initialDocument() {
  const value = createDocument({ filePath: "C:/Demo/insert-demo.pdf", fileName: "Demo - insert pages.pdf", sizeBytes: 42000, pageCount: 4 });
  value.thumbnailLayout = "grid";
  value.detailPanelVisible = false;
  value.pages = value.pages.map((page, index) => ({ ...page, source: {
    type: "image", fileName: `original-${index + 1}.png`, filePath: pageImage(index + 1), width: 420, height: 594,
  } }));
  return value;
}

function Fixture() {
  const [value, reducerDispatch] = React.useReducer(documentReducer, undefined, initialDocument);
  const [busyJob, setBusyJob] = React.useState(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [scenario, setScenario] = React.useState("success");
  const busyRef = React.useRef(null);
  const dialogRef = React.useRef(null);
  const dispatch = React.useCallback(action => { actions.push(action.type); reducerDispatch(action); }, []);

  React.useLayoutEffect(() => {
    latestDocument = value;
    currentBusyJob = busyJob;
    showPicker = setPickerOpen;
  }, [value, busyJob]);
  React.useEffect(() => {
    if (pickerOpen && !automated) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [pickerOpen]);

  return h("div", { className: "insert-demo-frame" },
    !automated && h("header", { className: "insert-demo-toolbar" },
      h("strong", null, "Demo: Insert pages"),
      h("span", null, "Simulated files"),
      h("button", { type: "button", title: "Reset demo", "aria-label": "Reset demo", disabled: Boolean(busyJob) || pickerOpen, onClick: () => location.reload() }, h(RotateCcw, { size: 17 })),
    ),
    h(EditorView, {
      document: value, dispatch, busyJob, guardWindowClose: false, isFileDragging: false,
      loadState: { status: "idle" }, tabId: "insert-demo", onPickPdf: () => {},
      onBeginBusyJob: job => {
        if (busyRef.current) return false;
        busyRef.current = job;
        setBusyJob(job);
        return true;
      },
      onEndBusyJob: id => {
        if (busyRef.current?.id !== id) return;
        busyRef.current = null;
        setBusyJob(null);
      },
    }),
    !automated && h("dialog", { className: "insert-demo-picker", ref: dialogRef, "aria-labelledby": "insert-demo-picker-title", onCancel: event => { event.preventDefault(); choose(null); } },
      h("h2", { id: "insert-demo-picker-title" }, "Demo file picker"),
      h("label", { htmlFor: "demo-scenario" }, "Simulated result"),
      h("select", { id: "demo-scenario", value: scenario, onChange: event => { setScenario(event.target.value); demoScenario = event.target.value; } },
        h("option", { value: "success" }, "Success: insert 3 pages"),
        h("option", { value: "failure" }, "Failure: file5 / file6 errors"),
        h("option", { value: "rejection" }, "Failure: worker interrupted"),
      ),
      h("ul", null, ...paths.map(path => h("li", { key: path }, path.split("/").at(-1)))),
      h("footer", null,
        h("button", { className: "soft-button", onClick: () => choose(null) }, "Cancel"),
        h("button", { className: "primary-action compact", onClick: () => choose(paths) }, "Insert demo files"),
      ),
    ),
  );
}

const style = document.createElement("style");
style.textContent = `
  .insert-demo-frame { height:100vh; min-height:0; display:grid; grid-template-rows:${automated ? "minmax(0,1fr)" : "42px minmax(0,1fr)"}; }
  .insert-demo-toolbar { display:flex; align-items:center; gap:14px; padding:0 16px; background:#eef6f1; border-bottom:1px solid #c9ded0; font-size:13px; }
  .insert-demo-toolbar span { color:#526b5c; }
  .insert-demo-toolbar button { margin-left:auto; display:grid; place-items:center; width:30px; height:30px; border:1px solid #bdcebf; border-radius:5px; background:white; }
  .insert-demo-picker { width:min(440px,90vw); border:1px solid #cbd3df; border-radius:8px; padding:24px; color:#14161a; }
  .insert-demo-picker::backdrop { background:rgba(0,0,0,.25); }
  .insert-demo-picker h2 { font-size:19px; margin:0 0 20px; }
  .insert-demo-picker label { display:block; font-size:13px; margin-bottom:7px; }
  .insert-demo-picker select { width:100%; padding:9px; font:inherit; background:white; border:1px solid #cbd3df; border-radius:4px; }
  .insert-demo-picker ul { padding:14px 0; list-style:none; font-size:13px; line-height:1.8; }
  .insert-demo-picker footer { display:flex; justify-content:flex-end; gap:10px; }
`;
document.head.append(style);
createRoot(document.getElementById("root")).render(h(Fixture));
