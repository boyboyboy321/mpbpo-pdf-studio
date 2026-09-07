import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
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
const ctx = canvas.getContext('2d');ctx.fillStyle = '#ffffff';ctx.fillRect(0,0,420,594);
ctx.fillStyle = '#123456';ctx.fillRect(30,30,360,170);ctx.fillStyle = '#222';ctx.font='24px sans-serif';ctx.fillText('PDF interaction test',30,270);
const initial = createDemoDocument();initial.filePath = 'fixture.pdf';initial.thumbnailLayout = 'grid';
initial.pages = initial.pages.map(page => ({ ...page, source: { type:'image', fileName:'fixture.png', filePath:canvas.toDataURL(), width:420, height:594 } }));
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
    root, optimizeDeps: { include: ['react', 'react-dom/client'] }, server: { host: "127.0.0.1", port: 0, strictPort: false },
    plugins: [{ name: "interaction-fixture", configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url !== "/__interaction_test") return next();
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml(req.url, html));
      });
    } }],
  });
  await server.listen();
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
  const url = `http://127.0.0.1:${server.httpServer.address().port}/__interaction_test`;
  await page.goto(url);
  const grid = page.locator(".page-grid-scroll");
  await grid.waitFor();
  console.log('Fixture mounted');
  await page.waitForFunction(() => document.querySelectorAll('.page-card img').length > 2);
  const startDrag = async () => {
    await grid.evaluate(el => el.scrollTop = 0);
    await page.waitForFunction(() => {
      const grid = document.querySelector('.page-grid-scroll');
      return !grid.classList.contains('is-scrolling') && grid.querySelector('.page-select-button > span')?.textContent === '1';
    });
    const box = await page.locator(".page-card").first().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 70);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 12, box.y + 85, { steps: 3 });
    await page.waitForFunction(() => document.querySelector('.is-dragging-pages'));
  };
  const stopped = async () => {
    await page.waitForFunction(() => !document.querySelector('.is-dragging-pages'));
    const before = await grid.evaluate(el => el.scrollTop);
    await page.mouse.move(600, 898);
    await page.waitForTimeout(180);
    assert.equal(await grid.evaluate(el => el.scrollTop), before);
    await page.mouse.up();
  };

  await startDrag();
  await page.mouse.move(600, 898, { steps: 5 });
  await page.waitForFunction(() => document.querySelector('.page-grid-scroll').scrollTop > 50);
  await page.mouse.move(600, 420);
  const wheelBefore = await grid.evaluate(el => el.scrollTop);
  await page.mouse.wheel(0, 240);
  await page.waitForFunction(before => document.querySelector('.page-grid-scroll').scrollTop > before, wheelBefore);
  await page.keyboard.press("Escape");
  await stopped();
  checks.push("edge auto-scroll, wheel during drag, Escape cleanup");
  console.log(checks.at(-1));

  for (const reason of ["missing-up", "blur", "pointercancel", "lostpointercapture", "visibilitychange"]) {
    await startDrag();
    await page.evaluate(reason => {
      if (reason === 'missing-up') document.dispatchEvent(new PointerEvent('pointermove', { pointerId:1, pointerType:'mouse', buttons:0, clientY:0, bubbles:true }));
      if (reason === 'blur') window.dispatchEvent(new Event('blur'));
      if (reason === 'pointercancel' || reason === 'lostpointercapture') document.dispatchEvent(new PointerEvent(reason, { pointerId:1, pointerType:'mouse', bubbles:true }));
      if (reason === 'visibilitychange') {
        Object.defineProperty(document, 'hidden', { configurable:true, value:true });
        document.dispatchEvent(new Event('visibilitychange'));
        delete document.hidden;
      }
    }, reason);
    await stopped();
    assert.equal(await page.evaluate(() => window.fixture.isDirty), false, "Canceled drag must not reorder pages");
    checks.push(reason + " cancels without modifying pages; drag can restart");
    console.log(checks.at(-1));
  }

  await startDrag();
  const destination = await page.locator('.page-slot').nth(3).boundingBox();
  await page.mouse.move(destination.x + 4, destination.y + 120, { steps: 10 });
  await page.mouse.up();
  await page.waitForFunction(() => window.fixture.isDirty);
  assert.equal(await page.evaluate(() => window.fixture.pages[0].id), "page-2");
  checks.push("normal drop reorders pages");
  console.log(checks.at(-1));

  await grid.evaluate(el => el.scrollTop = 0);
  await page.getByRole('button', { name:'Open page 1 preview', exact:true }).click({ force:true });
  const picker = page.getByRole('button', { name:'Pick color from screen', exact:true });
  await picker.waitFor();
  const color = page.getByLabel('Cover color', { exact:true });
  const initialColor = await color.inputValue();
  await page.evaluate(() => window.EyeDropper = class { open() { return Promise.reject(new DOMException('Native picker unavailable', 'AbortError')); } });
  await picker.click();
  await page.locator('.color-picker-error').waitFor();
  assert.equal(await color.inputValue(), initialColor);
  await page.getByRole('button', { name:'Dismiss color picker error' }).click();
  checks.push("immediate native failure is visible and leaves paint color unchanged");

  await page.evaluate(() => { window.pickCalls = 0; window.EyeDropper = class { open({signal}) {
    window.pickCalls++;
    return new Promise((resolve,reject) => { window.finishPick=resolve; signal.addEventListener('abort', () => reject(signal.reason)); });
  } }; });
  await picker.click();
  await page.keyboard.press('p');
  assert.equal(await page.evaluate(() => window.pickCalls), 1);
  assert(await picker.isDisabled());
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[aria-label="Pick color from screen"]').disabled);
  assert.equal(await color.inputValue(), initialColor);
  assert.equal(await page.getByRole('dialog', { name:'Page 1 preview' }).count(), 1);
  checks.push("no duplicate picker; Escape cancels without closing detail or changing color");

  await picker.click();
  await page.evaluate(() => window.finishPick({sRGBHex:'#123456'}));
  await page.waitForFunction(() => document.querySelector('[aria-label="Cover color"]').value === '#123456');
  checks.push("native result becomes the next paint color");

  await picker.click();
  await page.getByRole('button', { name:'Close preview', exact:true }).click();
  await page.waitForFunction(() => !document.querySelector('.full-preview-overlay'));
  checks.push("closing detail aborts pending picker");
  assert.deepEqual(errors, []);
  await mkdir(resolve(root, '.codex/test-results'), { recursive:true });
  await page.screenshot({ path:resolve(root, '.codex/test-results/interactions.png') });
  console.log(JSON.stringify({ root, checks, errors }, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
