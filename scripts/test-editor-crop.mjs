import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = resolve(process.argv[2] || ".");
const html = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';
import { EditorView } from '/src/components/EditorView.tsx';
import { createDemoDocument } from '/src/utils/demoPages.ts';
import { documentReducer } from '/src/state/documentReducer.ts';
import '/src/styles/app.css';
window.__TAURI_INTERNALS__ = { convertFileSrc: path => path, transformCallback: () => 1, invoke: async () => 1 };
const canvas = document.createElement('canvas'); canvas.width = 420; canvas.height = 594;
const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0,0,420,594);
ctx.fillStyle = '#123456'; ctx.fillRect(30,30,360,170);
ctx.fillStyle = '#222'; ctx.font = '24px sans-serif'; ctx.fillText('Crop interaction test',30,270);
const initial = createDemoDocument(); initial.filePath = 'fixture.pdf'; initial.thumbnailLayout = 'grid';
initial.pages = initial.pages.slice(0,3).map(page => ({ ...page, source: { type:'image', fileName:'fixture.png', filePath:canvas.toDataURL(), width:420, height:594 } }));
initial.pages[0].paintEdits = [
  { id:'cover', type:'cover', color:'#ee4444', x:0.2, y:0.4, width:0.25, height:0.1 },
  { id:'text', type:'text', text:'Existing edit', x:0.2, y:0.6, width:0.3, height:0.08, bold:false, italic:false, underline:false, fontFamily:'Arial', fontSize:13, textAlign:'left', color:'#111827' }
];
window.cropAttentionEvents = [];
document.addEventListener('animationstart', event => {
  if (event.animationName.startsWith('detail-crop-action-')) window.cropAttentionEvents.push({ label:event.target.getAttribute('aria-label'), name:event.animationName });
});
function Fixture() {
  const [document, dispatch] = React.useReducer(documentReducer, initial);
  window.fixture = document;
  return React.createElement(EditorView, { document, dispatch, busyJob:null, guardWindowClose:false, isFileDragging:false, loadState:{status:'idle'}, tabId:'fixture', onBeginBusyJob:()=>true, onEndBusyJob:()=>{}, onPickPdf:()=>{} });
}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));
</script></body></html>`;

let server, browser;
const checks = [];
try {
  server = await createServer({
    root,
    cacheDir: resolve(root, "node_modules/.vite-crop-test"),
    optimizeDeps: { entries: ["src/components/EditorView.tsx"], include: ["react", "react-dom/client"] },
    server: { host: "127.0.0.1", port: 0, strictPort: false, watch: null, hmr: false },
    plugins: [{ name: "crop-fixture", configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url !== "/__crop_test") return next();
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml(req.url, html));
      });
    } }],
  });
  await server.listen();
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__crop_test`, { timeout: 60000, waitUntil: "domcontentloaded" });
  await page.locator(".page-card img").first().waitFor();
  console.log("Crop fixture mounted");

  const button = name => page.getByRole("button", { name, exact: true });
  const edits = () => page.evaluate(() => window.fixture.pages[0].paintEdits);
  const originalEdits = await edits();
  const openPreview = async () => {
    await button("Open page 1 preview").click({ force: true });
    await page.locator(".editable-preview-page").waitFor();
  };
  const beginCrop = async () => {
    await button("Crop page").click();
    await button("Cancel crop").waitFor();
  };
  const outside = () => page.mouse.click(8, 8);
  const cropRect = () => page.locator(".crop-box").evaluate(element => ({
    x: parseFloat(element.style.left) / 100,
    y: parseFloat(element.style.top) / 100,
    width: 1 - (parseFloat(element.style.left) + parseFloat(element.style.right)) / 100,
    height: 1 - (parseFloat(element.style.top) + parseFloat(element.style.bottom)) / 100,
  }));
  const resizeCrop = async (release = true) => {
    const handle = await page.locator(".crop-handle.is-northWest").boundingBox();
    const frame = await page.locator(".editable-preview-page").boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + frame.width * 0.08, handle.y + handle.height / 2 + frame.height * 0.07, { steps: 5 });
    if (release) await page.mouse.up();
    return cropRect();
  };
  const assertRect = (actual, expected) => {
    for (const key of ["x", "y", "width", "height"]) {
      assert(Math.abs(actual[key] - expected[key]) < 0.002, `${key}: ${actual[key]} != ${expected[key]}`);
    }
  };
  const assertNudge = async (action, animationName = "detail-crop-action-shake") => {
    await page.evaluate(() => { window.cropAttentionEvents = []; });
    await action();
    await page.waitForFunction(() => window.cropAttentionEvents.length >= 2);
    const events = await page.evaluate(() => window.cropAttentionEvents);
    for (const label of ["Apply crop", "Cancel crop"]) {
      assert(events.some(event => event.label === label && event.name === animationName), `${label} must receive attention feedback`);
    }
    assert.equal(await page.getByRole("dialog", { name: "Page 1 preview", exact: true }).count(), 1);
    assert.equal(await button("Cancel crop").count(), 1);
  };
  const check = description => { checks.push(description); console.log(description); };

  await openPreview();
  await beginCrop();
  const draft = await resizeCrop();
  assert(draft.width < 1 && draft.height < 1);
  await assertNudge(outside);
  await assertNudge(outside);
  await assertNudge(() => button("Close preview").click());
  assertRect(await cropRect(), draft);
  assert.deepEqual(await edits(), originalEdits);
  check("Outside and Close preserve the draft and shake both actions, including repeated clicks");

  await assertNudge(() => button("Next page").click());
  await assertNudge(() => page.keyboard.press("ArrowRight"));
  await assertNudge(() => button("Pan page").click());
  await assertNudge(() => page.keyboard.press("Control+t"));
  await assertNudge(() => button("Pick color from screen").click());
  await assertNudge(() => button("Rotate page right").click());
  await assertNudge(() => page.keyboard.press("Control+r"));
  await assertNudge(() => button("Undo last paint edit").click());
  await assertNudge(() => page.keyboard.press("Control+z"));
  assert.equal(await page.evaluate(() => window.fixture.pages[0].rotation), 0);
  assert.deepEqual(await edits(), originalEdits);
  await assertNudge(async () => {
    await page.getByLabel("Go to page", { exact: true }).fill("2");
    await page.keyboard.press("Enter");
  });
  assert.equal(await page.getByLabel("Go to page", { exact: true }).inputValue(), "1");
  await button("Crop page").click();
  await page.keyboard.press("c");
  assertRect(await cropRect(), draft);
  check("Page/tool changes, rotation, undo, and reselecting Crop cannot lose the draft or alter saved edits");

  const colors = await page.locator(".detail-crop-actions button").evaluateAll(elements => elements.map(element => getComputedStyle(element).backgroundColor));
  assert.deepEqual(colors, ["rgb(21, 184, 106)", "rgb(220, 53, 69)"]);
  const screenshotDir = resolve(root, ".tmp/crop-test");
  await mkdir(screenshotDir, { recursive: true });
  await page.screenshot({ path: join(screenshotDir, "crop-actions.png") });
  await button("Cancel crop").click();
  await page.locator(".is-tool-hand.editable-preview-page").waitFor();
  assert.deepEqual(await edits(), originalEdits);
  await outside();
  await page.locator(".full-preview-overlay").waitFor({ state: "detached" });
  check("Red Cancel discards the draft, preserves edits, and restores outside-close");

  await openPreview();
  await beginCrop();
  const applied = await resizeCrop();
  await page.keyboard.press("Enter");
  await button("Cancel crop").waitFor({ state: "detached" });
  const savedEdits = await edits();
  assert.deepEqual(savedEdits.slice(0, -1), originalEdits);
  assert.equal(savedEdits.at(-1).type, "crop");
  assertRect(savedEdits.at(-1), applied);
  check("Enter commits the draft without changing existing cover/text coordinates");

  await beginCrop();
  assertRect(await cropRect(), applied);
  await resizeCrop();
  await button("Cancel crop").click();
  assert.deepEqual(await edits(), savedEdits);
  await beginCrop();
  assertRect(await cropRect(), applied);
  await resizeCrop(false);
  await page.keyboard.down("Escape");
  await page.mouse.up();
  await page.locator(".is-tool-hand.editable-preview-page").waitFor();
  assert.deepEqual(await edits(), savedEdits);
  assert.equal(await page.locator(".full-preview-overlay").count(), 1);
  await page.keyboard.down("Escape");
  assert.equal(await page.locator(".full-preview-overlay").count(), 1, "Held Escape must not close after canceling crop");
  await page.keyboard.up("Escape");
  await page.keyboard.press("Escape");
  await page.locator(".full-preview-overlay").waitFor({ state: "detached" });
  check("Cancel restores the committed crop; Escape cancels an active drag, ignores auto-repeat, and closes only on a new press");

  await openPreview();
  await beginCrop();
  await page.getByLabel("Go to page", { exact: true }).fill("2");
  await page.keyboard.press("Escape");
  await button("Cancel crop").waitFor({ state: "detached" });
  assert.equal(await page.getByLabel("Go to page", { exact: true }).inputValue(), "1");
  assert.equal(await page.getByRole("dialog", { name: "Page 1 preview", exact: true }).count(), 1);
  assert.deepEqual(await edits(), savedEdits);
  check("Escape in the page input cancels crop without navigating or closing");

  for (const rotation of [90, 180, 270]) {
    await button("Rotate page right").click();
    await page.waitForFunction(rotation => window.fixture.pages[0].rotation === rotation, rotation);
    await beginCrop();
    const visual = await resizeCrop();
    const expected = rotation === 90
      ? { x: visual.y, y: 1 - visual.x - visual.width, width: visual.height, height: visual.width }
      : rotation === 180
        ? { x: 1 - visual.x - visual.width, y: 1 - visual.y - visual.height, width: visual.width, height: visual.height }
        : { x: 1 - visual.y - visual.height, y: visual.x, width: visual.height, height: visual.width };
    await button("Apply crop").click();
    assertRect((await edits()).at(-1), expected);
    assert.deepEqual((await edits()).slice(0, 2), originalEdits);
  }
  check("Apply preserves source-space crop and existing edit coordinates at 90, 180, and 270 degrees");

  await page.setViewportSize({ width: 1024, height: 768 });
  await beginCrop();
  for (const name of ["Apply crop", "Cancel crop"]) {
    const box = await button(name).boundingBox();
    assert(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 1024 && box.y + box.height <= 768);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await assertNudge(outside, "detail-crop-action-highlight");
  await page.screenshot({ path: join(screenshotDir, "crop-actions-compact.png") });
  check("Both actions fit a compact desktop viewport; reduced motion uses a highlight instead of shaking");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ root, checks, errors, screenshotDir }, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
