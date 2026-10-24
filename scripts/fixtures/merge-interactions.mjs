import React from "react";
import { createRoot } from "react-dom/client";
import { HomeView } from "/src/components/HomeView.tsx";
import { MergeDialog } from "/src/components/MergeDialog.tsx";
import "/src/styles/app.css";

const h = React.createElement;
const callbacks = new Map();
const listeners = new Map();
const calls = [];
const requests = [];
const pendingMetadata = [];
let id = 1;
let filePicker = ["C:/First/alpha.pdf", "D:/Second/beta.pdf", "C:/First/gamma.pdf"];
let folderPicker = "C:/Output";
let metadataErrors = {};
let holdMetadata = false;
let folderError = false;
let job = null;
let opened = null;
let setDrop = () => {};
const metadata = path => ({ filePath: path, fileName: path.split(/[\\/]/).at(-1), sizeBytes: 1048576, pageCount: 3 });
window.isTauri = true;
window.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "merge-demo" }, currentWebview: { label: "merge-demo" } },
  convertFileSrc: path => path,
  transformCallback(callback) { const next = id++; callbacks.set(next, callback); return next; },
  unregisterCallback: key => callbacks.delete(key),
  async invoke(command, args) {
    calls.push({ command, args });
    if (command === "plugin:event|listen") { const next = id++; listeners.set(next, args); return next; }
    if (command === "plugin:event|unlisten") return;
    if (command === "plugin:dialog|open") return args.options.directory ? folderPicker : filePicker;
    if (command === "read_merge_metadata") {
      if (holdMetadata) return new Promise((resolve, reject) => pendingMetadata.push({ path: args.path, resolve, reject }));
      if (metadataErrors[args.path]) throw metadataErrors[args.path];
      return metadata(args.path);
    }
    if (command === "merge_pdf") return new Promise((resolve, reject) => requests.push({ ...args, resolve, reject }));
    if (command === "open_folder") { if (folderError) throw "Folder cannot be opened"; return; }
    throw new Error("Unmocked command: " + command);
  },
};
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener(event, key) { const entry = listeners.get(key); if (entry) callbacks.delete(entry.handler); listeners.delete(key); },
};
window.__mergeFixture = {
  configure(options) {
    if ("files" in options) filePicker = options.files;
    if ("folder" in options) folderPicker = options.folder;
    if ("errors" in options) metadataErrors = options.errors;
    if ("holdMetadata" in options) holdMetadata = options.holdMetadata;
    if ("folderError" in options) folderError = options.folderError;
  },
  nextMetadata(error = null) {
    const next = pendingMetadata.shift();
    if (!next) throw new Error("No metadata request");
    if (error) next.reject(error); else next.resolve(metadata(next.path));
  },
  drop(paths) { setDrop({ id: crypto.randomUUID(), paths }); },
  emit(patch = {}) {
    const request = requests.at(-1);
    const payload = { runId: request.runId, phase: "merging", completedFiles: 1, totalFiles: request.paths.length,
      currentFileName: "alpha.pdf", completedPages: 3, totalPages: request.paths.length * 3, ...patch };
    for (const [key, entry] of listeners) callbacks.get(entry.handler)?.({ event: entry.event, id: key, payload });
  },
  finish({ errors = [], reject = null } = {}) {
    const request = requests.at(-1);
    if (reject) request.reject(reject);
    else request.resolve({ file: errors.length ? null : { ...metadata("C:/Output/merge_20261024.pdf"), pageCount: request.paths.length * 3 },
      outputDir: errors.length ? null : "C:/Output", issues: errors });
  },
  snapshot() { return { calls, requests: requests.map(({ paths, outputOptions, runId }) => ({ paths, outputOptions, runId })),
    listeners: listeners.size, pendingMetadata: pendingMetadata.map(item => item.path), job, opened }; },
};
function Fixture() {
  const [visible, setVisible] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [drop, updateDrop] = React.useState(null);
  setDrop = updateDrop;
  const begin = React.useCallback(value => { if (job) return false; job = value; setBusy(true); return true; }, []);
  const end = React.useCallback(value => { if (job?.id === value) { job = null; setBusy(false); } }, []);
  return h(React.Fragment, null,
    h(HomeView, { loadState: { status: "idle" }, recentFiles: [], isFileDragging: false,
      onOpenDemo() {}, onOpenRecent() {}, onPickPdf() {}, onMerge() { setVisible(true); } }),
    visible ? h(MergeDialog, { busy, dropRequest: drop, onBeginBusyJob: begin, onEndBusyJob: end,
      onClose() { setVisible(false); updateDrop(null); }, onOpenPdf(path) { opened = path; } }) : null);
}
createRoot(document.getElementById("root")).render(h(Fixture));
