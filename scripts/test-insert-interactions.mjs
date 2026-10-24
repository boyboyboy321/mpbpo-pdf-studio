import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// node scripts/test-insert-interactions.mjs [root] [--serve] [--port=5175]
const args = process.argv.slice(2);
const serve = args.includes("--serve");
const root = resolve(args.find(arg => !arg.startsWith("--")) || fileURLToPath(new URL("..", import.meta.url)));
const port = Number(args.find(arg => arg.startsWith("--port="))?.split("=")[1] || 0);
const output = resolve(root, ".tmp/insert-interactions");
const route = "/__insert_demo";
const fixtureSource = await readFile(resolve(root, "scripts/fixtures/insert-interactions.mjs"), "utf8");
const html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>Demo: Insert pages</title></head><body><div id="root"></div><script type="module">${fixtureSource}</script></body></html>`;
const checks = [];
const failures = [];
let server;
let browser;

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  if (process.env.PLAYWRIGHT_MODULE) return require(process.env.PLAYWRIGHT_MODULE);
  try { return require("playwright"); }
  catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
    return require(resolve(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"));
  }
}

async function runTests(url) {
  const { chromium } = loadPlaywright();
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", headless: true, timeout: 30000 });
  await mkdir(output, { recursive: true });

  async function test(name, body, viewport = { width: 1440, height: 900 }, demo = false) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    const pendingRequests = new Set();
    page.setDefaultTimeout(12000);
    page.on("request", request => pendingRequests.add(request.url()));
    page.on("requestfinished", request => pendingRequests.delete(request.url()));
    page.on("requestfailed", request => { pendingRequests.delete(request.url()); errors.push(`${request.url()}: ${request.failure()?.errorText}`); });
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    try {
      await page.goto(demo ? url : `${url}?test=1`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.getByRole("button", { name: "Insert pages", exact: true }).waitFor();
      await page.waitForFunction(() => window.__insertFixture?.snapshot().document?.pages.length === 4);
      await body(page);
      assert.deepEqual(errors, [], "The fixture must not emit browser errors");
      checks.push(name);
      console.log(`PASS ${name}`);
    } catch (error) {
      failures.push({ name, message: error.message, errors });
      console.error(`FAIL ${name}: ${error.message}`);
      if (pendingRequests.size) console.error("Pending requests:", [...pendingRequests]);
      if (errors.length) console.error("Browser errors:", errors);
      await page.screenshot({ path: resolve(output, `failure-${failures.length}.png`), timeout: 5000 }).catch(() => {});
    } finally {
      await context.close();
    }
  }

  const snapshot = page => page.evaluate(() => window.__insertFixture.snapshot());
  const status = page => page.getByRole("region", { name: "Insert status" });
  const insert = page => page.getByRole("button", { name: "Insert pages", exact: true, includeHidden: true });
  const save = page => page.getByRole("button", { name: "Save", exact: true });
  const emit = (page, patch) => page.evaluate(patch => window.__insertFixture.emit(patch), patch);
  const settleRender = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const waitText = (page, text) => status(page).getByText(text, { exact: true }).waitFor();
  const countCalls = (state, command) => state.calls.filter(call => call.command === command).length;
  const details = page => page.getByRole("dialog", { name: "Insert error details" });
  async function openDetails(page) {
    assert.equal(await status(page).locator(".lucide-circle-alert").count(), 1, "Only one error icon belongs in the status row");
    assert.equal(await status(page).locator(".insert-status-details .lucide-circle-alert").count(), 1, "The error icon must be the details button");
    if (await status(page).getAttribute("aria-busy") === "false") {
      assert.equal(await status(page).locator(".insert-status-message svg").count(), 0, "No decorative error icon on the left");
    }
    await page.getByRole("button", { name: "View insert error details" }).click();
    await details(page).waitFor();
  }
  async function closeDetails(page) {
    await details(page).getByRole("button", { name: "Close insert error details" }).click();
    await details(page).waitFor({ state: "hidden" });
  }
  async function assertCompactHeader(page) {
    const layout = await page.locator(".editor-topbar").evaluate(element => {
      const header = element.getBoundingClientRect();
      const status = element.querySelector(".insert-status")?.getBoundingClientRect();
      const summary = element.querySelector(".document-summary").getBoundingClientRect();
      const actions = element.querySelector(".topbar-actions").getBoundingClientRect();
      const grid = document.querySelector(".editor-layout").getBoundingClientRect();
      return { height: header.height, bottom: header.bottom, right: header.right, gridTop: grid.top, statusLeft: status?.left, statusRight: status?.right, statusCenter: status && (status.top + status.bottom) / 2, summaryCenter: (summary.top + summary.bottom) / 2, actionsLeft: actions.left, actionsRight: actions.right, pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth };
    });
    assert.equal(layout.height, 44, "The header must stay one fixed-height row");
    assert.equal(layout.gridTop, layout.bottom, "Insert status cannot shift or overlap the grid");
    assert(layout.right <= layout.viewportWidth && layout.actionsRight <= layout.viewportWidth, "Header and action buttons must fit the viewport");
    if (layout.statusRight !== undefined) {
      assert(layout.statusLeft >= 0, "Status must not shift left outside the viewport");
      assert(layout.statusRight <= layout.actionsLeft, "Status must not overlap Open/Save");
      assert(Math.abs(layout.statusCenter - layout.summaryCenter) < 1, "Status and page count must share one line");
    }
    assert(layout.pageWidth <= layout.viewportWidth, "No page-level horizontal overflow");
    assert.equal(await page.getByRole("progressbar").count(), 0, "No horizontal progress bar");
    if (layout.viewportWidth >= 1100) {
      for (const selector of [".document-summary", ".insert-status-text"]) {
        const clipped = await page.locator(selector).evaluateAll(elements => elements.some(element => element.scrollWidth > element.clientWidth + 1));
        assert.equal(clipped, false, "Page counts and progress stay readable when filenames are long");
      }
    }
  }

  async function start(page, expectedRequests = 1) {
    await insert(page).click();
    await page.waitForFunction(count => window.__insertFixture.snapshot().requests.length === count, expectedRequests);
    await waitText(page, "Checking files 0/6");
    assert.equal((await snapshot(page)).activeInsertListeners, 1);
  }

  async function waitFinished(page) {
    await page.waitForFunction(() => {
      const state = window.__insertFixture.snapshot();
      return state.activeInsertListeners === 0 && state.busyJob === null;
    });
    assert.equal(await insert(page).isEnabled(), true, "Insert must be available again");
  }

  await test("file and page counters; foreign run ignored; one atomic commit", async page => {
    const before = (await snapshot(page)).document;
    await start(page);
    assert.equal(await status(page).getAttribute("aria-busy"), "true");
    await emit(page, { completedFiles: 2, currentFileName: "file2.pdf" });
    await waitText(page, "Checking files 2/6");
    await assertCompactHeader(page);
    assert.equal(await status(page).locator(".insert-spinner").count(), 1);
    await emit(page, { runId: "another-tab-run", completedFiles: 6, phase: "preparing", completedPages: 777, totalPages: 777, issues: [{ filePath: "foreign.pdf", fileName: "foreign.pdf", pageNumber: null, message: "Foreign error" }] });
    await settleRender(page);
    await waitText(page, "Checking files 2/6");
    assert.equal(await status(page).getByText("Foreign error").count(), 0);
    await emit(page, { phase: "preparing", completedFiles: 6, completedPages: 1, totalPages: null });
    await waitText(page, "Checking pages: 1 checked");
    await assertCompactHeader(page);
    await emit(page, { phase: "preparing", completedFiles: 6, completedPages: 2, totalPages: 3, currentFileName: "appendix.tiff" });
    await waitText(page, "Preparing insert 2/3 pages");
    await assertCompactHeader(page);
    await status(page).getByText("appendix.tiff", { exact: true }).waitFor();
    assert.deepEqual((await snapshot(page)).document, before, "Progress cannot add pages");
    await page.screenshot({ path: resolve(output, "preparing-1440x900.png") });
    await emit(page, { phase: "complete", completedFiles: 6, completedPages: 3, totalPages: 3 });
    await settleRender(page);
    assert.deepEqual((await snapshot(page)).document, before, "A complete event alone cannot commit pages");
    await page.evaluate(() => window.__insertFixture.finish());
    await waitText(page, "Inserted 3 pages");
    await waitFinished(page);
    await assertCompactHeader(page);
    const after = await snapshot(page);
    assert.equal(after.document.pages.length, 7);
    assert.equal(after.document.isDirty, true);
    assert.equal(after.actions.filter(type => type === "insert-pages-after-selection").length, 1);
    assert.deepEqual(after.document.pages.map(item => item.fileName), ["original-1.png", "inserted-1.tiff", "inserted-2.tiff", "inserted-3.tiff", "original-2.png", "original-3.png", "original-4.png"]);
    assert.equal(after.removedListeners.filter(item => item.event === "insert-progress").length, 1);
    await page.evaluate(() => window.__insertFixture.replay(0));
    await settleRender(page);
    await waitText(page, "Inserted 3 pages");
    assert.deepEqual((await snapshot(page)).document, after.document, "Queued events after completion cannot mutate the document");
  });

  await test("all file5/file6 errors shown; partial pages discarded; retry possible", async page => {
    const before = (await snapshot(page)).document;
    await start(page);
    await page.evaluate(() => window.__insertFixture.emit({ completedFiles: 6, currentFileName: "file6.tiff", issues: window.__insertFixture.issues() }));
    const list = page.getByRole("list", { name: "Files that could not be inserted" });
    await status(page).getByText("file5.pdf, file6.tiff", { exact: true }).waitFor();
    assert.equal(await list.count(), 0, "Reasons must stay hidden until requested");
    await assertCompactHeader(page);
    await openDetails(page);
    await list.getByText("file5.pdf", { exact: true }).waitFor();
    await list.getByText("file6.tiff - page 2", { exact: true }).waitFor();
    await page.evaluate(() => window.__insertFixture.finish({ errors: window.__insertFixture.issues(), pageCount: 3 }));
    await details(page).getByText("Insert cancelled. No pages were added.", { exact: true }).waitFor();
    await closeDetails(page);
    await waitText(page, "Insert cancelled");
    await waitFinished(page);
    await assertCompactHeader(page);
    await page.screenshot({ path: resolve(output, "single-error-icon-1440x900.png") });
    await openDetails(page);
    assert.equal(await list.getByRole("listitem").count(), 2);
    await list.getByText("Cannot read the PDF: the document is damaged.", { exact: true }).waitFor();
    await list.getByText("Cannot decode TIFF page: the image data is incomplete.", { exact: true }).waitFor();
    await page.keyboard.press("Delete");
    await page.keyboard.press("Escape");
    await details(page).waitFor({ state: "hidden" });
    assert.equal(await page.getByRole("button", { name: "View insert error details" }).evaluate(button => button === document.activeElement), true);
    const after = await snapshot(page);
    assert.deepEqual(after.document, before);
    assert.equal(after.actions.filter(type => type === "insert-pages-after-selection").length, 0);
    await start(page, 2);
    assert.equal(await page.getByRole("list", { name: "Files that could not be inserted" }).count(), 0, "Retry clears old errors");
    await page.evaluate(() => window.__insertFixture.finish({ pageCount: 1 }));
    await waitText(page, "Inserted 1 pages");
    await waitFinished(page);
    assert.equal((await snapshot(page)).document.pages.length, 5);
  });

  await test("double insert blocked across picker and progress; Save and Ctrl+S blocked", async page => {
    await page.getByRole("button", { name: "Rotate right", exact: true }).click();
    assert.equal(await save(page).isEnabled(), true, "Save must be enabled before insertion");
    await page.evaluate(() => window.__insertFixture.configurePicker({ hold: true }));
    await insert(page).dblclick();
    await page.waitForFunction(() => window.__insertFixture.snapshot().pickerPending);
    assert.equal(countCalls(await snapshot(page), "plugin:dialog|open"), 1);
    await page.keyboard.press("Control+s");
    await settleRender(page);
    assert.equal(countCalls(await snapshot(page), "save_pdf_edits"), 0);
    await page.evaluate(() => window.__insertFixture.choose(window.__insertFixture.paths));
    await page.waitForFunction(() => window.__insertFixture.snapshot().requests.length === 1);
    await waitText(page, "Checking files 0/6");
    assert.equal(await insert(page).isDisabled(), true);
    assert.equal(await save(page).isDisabled(), true);
    // Native click() is deliberate: it tests the disabled button without Playwright's retry timeout.
    await insert(page).evaluate(button => { button.click(); button.click(); });
    await save(page).evaluate(button => button.click());
    await page.keyboard.press("Control+s");
    await settleRender(page);
    const pending = await snapshot(page);
    assert.equal(countCalls(pending, "read_insert_pages"), 1);
    assert.equal(countCalls(pending, "plugin:dialog|open"), 1);
    assert.equal(countCalls(pending, "save_pdf_edits"), 0);
    await page.evaluate(() => window.__insertFixture.finish());
    await waitText(page, "Inserted 3 pages");
    await waitFinished(page);
    assert.equal(await save(page).isEnabled(), true);
    assert.equal((await snapshot(page)).actions.filter(type => type === "insert-pages-after-selection").length, 1);
  });

  await test("picker cancel leaves document unchanged; TIFF filter includes tif and tiff", async page => {
    const before = (await snapshot(page)).document;
    await page.evaluate(() => window.__insertFixture.configurePicker({ result: null }));
    await insert(page).click();
    await settleRender(page);
    const after = await snapshot(page);
    assert.deepEqual(after.document, before);
    assert.equal(after.requests.length, 0);
    assert.equal(after.activeInsertListeners, 0);
    assert.equal(after.busyJob, null);
    assert.equal(await status(page).count(), 0);
    const options = after.calls.find(call => call.command === "plugin:dialog|open").args.options;
    assert.equal(options.multiple, true);
    const extensions = options.filters.flatMap(filter => filter.extensions);
    for (const extension of ["pdf", "png", "jpg", "jpeg", "tif", "tiff"]) assert(extensions.includes(extension), `Missing ${extension} filter`);
    await page.evaluate(() => window.__insertFixture.configurePicker());
    await start(page);
    await page.evaluate(() => window.__insertFixture.finish({ pageCount: 1 }));
    await waitText(page, "Inserted 1 pages");
    await waitFinished(page);
  });

  await test("invoke failure cleans listener, preserves issues, and allows retry", async page => {
    const before = (await snapshot(page)).document;
    await start(page);
    await page.evaluate(() => window.__insertFixture.emit({ completedFiles: 6, issues: window.__insertFixture.issues() }));
    await status(page).getByText("file5.pdf, file6.tiff", { exact: true }).waitFor();
    await page.evaluate(() => window.__insertFixture.finish({ rejection: "The insert worker stopped unexpectedly." }));
    await waitText(page, "Insert cancelled");
    await waitFinished(page);
    await openDetails(page);
    await details(page).getByText("The insert worker stopped unexpectedly.", { exact: true }).waitFor();
    const failed = await snapshot(page);
    assert.deepEqual(failed.document, before);
    assert.equal(failed.removedListeners.filter(item => item.event === "insert-progress").length, 1);
    assert.equal(await page.getByRole("list", { name: "Files that could not be inserted" }).getByRole("listitem").count(), 2);
    await page.evaluate(() => window.__insertFixture.replay(0));
    await settleRender(page);
    await details(page).getByText("The insert worker stopped unexpectedly.", { exact: true }).waitFor();
    await closeDetails(page);
    await start(page, 2);
    const retry = await snapshot(page);
    assert.notEqual(retry.requests[0].runId, retry.requests[1].runId);
    await page.evaluate(() => window.__insertFixture.replay(0));
    await settleRender(page);
    await waitText(page, "Checking files 0/6");
    await page.evaluate(() => window.__insertFixture.finish({ pageCount: 2 }));
    await waitText(page, "Inserted 2 pages");
    await waitFinished(page);
    const after = await snapshot(page);
    assert.equal(after.document.pages.length, 6);
    assert.equal(after.removedListeners.filter(item => item.event === "insert-progress").length, 2);
    assert.equal(after.actions.filter(type => type === "insert-pages-after-selection").length, 1);
  });

  await test("unexpected failure details stay accessible without file issues", async page => {
    await start(page);
    await page.evaluate(() => window.__insertFixture.finish({ rejection: "The worker is unavailable." }));
    await waitText(page, "Insert cancelled");
    await waitFinished(page);
    assert.equal(await details(page).count(), 0);
    await openDetails(page);
    await details(page).getByText("The worker is unavailable.", { exact: true }).waitFor();
    await page.mouse.click(5, 400);
    await details(page).waitFor({ state: "hidden" });
    await assertCompactHeader(page);
  });

  for (const viewport of [{ width: 1100, height: 720 }, { width: 1440, height: 900 }]) {
    await test(`single-row status and on-demand errors at ${viewport.width}x${viewport.height}`, async page => {
      await start(page);
      const longName = `file6_${"long-filename_".repeat(20)}.tiff`;
      await emit(page, { completedFiles: 5, currentFileName: longName });
      await waitText(page, "Checking files 5/6");
      await assertCompactHeader(page);
      await page.screenshot({ path: resolve(output, `scanning-${viewport.width}x${viewport.height}.png`) });
      await page.evaluate(() => window.__insertFixture.finish({ errors: window.__insertFixture.issues(true) }));
      await waitText(page, "Insert cancelled");
      await waitFinished(page);
      await assertCompactHeader(page);
      assert.equal(await details(page).count(), 0, "No dialog opens automatically");
      await page.screenshot({ path: resolve(output, `errors-inline-${viewport.width}x${viewport.height}.png`) });
      await openDetails(page);
      const list = page.getByRole("list", { name: "Files that could not be inserted" });
      assert.equal(await list.getByRole("listitem").count(), 14);
      const bounds = await list.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth, height: element.clientHeight, scrollHeight: element.scrollHeight, overflowY: getComputedStyle(element).overflowY }));
      assert(bounds.scrollHeight > bounds.height, "Long error lists must have bounded vertical scrolling");
      assert(["auto", "scroll"].includes(bounds.overflowY));
      assert(bounds.scrollWidth <= bounds.width + 1, "Long filenames must not cause horizontal overflow");
      assert(bounds.height > 0 && bounds.height <= viewport.height / 2, "Details must have bounded height");
      const layout = await status(page).evaluate(element => {
        const rect = element.getBoundingClientRect();
        const editor = document.querySelector(".editor-layout").getBoundingClientRect();
        const buttons = document.querySelector(".topbar-actions").getBoundingClientRect();
        return { status: { left: rect.left, right: rect.right, bottom: rect.bottom }, editorTop: editor.top, editorHeight: editor.height, buttonsLeft: buttons.left, pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth };
      });
      assert(layout.status.left >= 0 && layout.status.right <= viewport.width, "Status must fit the viewport");
      assert(layout.status.right <= layout.buttonsLeft + 1, "Error text must not overlap the action buttons");
      assert(layout.status.bottom <= layout.editorTop + 1, "Error list must not overlap the editor");
      assert(layout.editorHeight >= 250, "The page grid must remain usable");
      assert(layout.pageWidth <= layout.viewportWidth, "No page-level horizontal overflow");
      await page.screenshot({ path: resolve(output, `errors-top-${viewport.width}x${viewport.height}.png`) });
      const lastError = list.getByRole("listitem").last();
      await lastError.scrollIntoViewIfNeeded();
      const visibleLast = await lastError.evaluate(element => {
        const item = element.getBoundingClientRect();
        const container = element.parentElement.getBoundingClientRect();
        return item.top >= container.top - 1 && item.bottom <= container.bottom + 1;
      });
      assert(visibleLast, "The final file6 issue must be reachable by scrolling");
      await page.screenshot({ path: resolve(output, `errors-bottom-${viewport.width}x${viewport.height}.png`) });
      await closeDetails(page);
      await assertCompactHeader(page);
      await page.getByRole("button", { name: "Dismiss insert status" }).click();
      assert.equal(await status(page).count(), 0);
      assert.equal((await snapshot(page)).document.pages.length, 4);
    }, viewport);
  }

  await test("interactive Demo picker supports cancel, failure, successful retry, and reset", async page => {
    assert.equal(await page.title(), "Demo: Insert pages");
    await page.getByText("Demo: Insert pages", { exact: true }).waitFor();
    const before = (await snapshot(page)).document;
    await insert(page).click();
    const picker = page.getByRole("dialog", { name: "Demo file picker" });
    await picker.waitFor();
    await picker.getByRole("button", { name: "Cancel", exact: true }).click();
    await picker.waitFor({ state: "hidden" });
    assert.deepEqual((await snapshot(page)).document, before);
    await insert(page).click();
    await picker.getByLabel("Simulated result").selectOption("failure");
    await picker.getByRole("button", { name: "Insert demo files", exact: true }).click();
    await waitText(page, "Insert cancelled");
    await waitFinished(page);
    assert.deepEqual((await snapshot(page)).document, before);
    await page.screenshot({ path: resolve(output, "demo-errors-1440x900.png") });
    await insert(page).click();
    await picker.getByLabel("Simulated result").selectOption("success");
    await picker.getByRole("button", { name: "Insert demo files", exact: true }).click();
    await waitText(page, "Inserted 3 pages");
    await waitFinished(page);
    assert.equal((await snapshot(page)).document.pages.length, 7);
    await page.screenshot({ path: resolve(output, "demo-success-1440x900.png") });
    await page.getByRole("button", { name: "Reset demo", exact: true }).click();
    await page.waitForFunction(() => window.__insertFixture?.snapshot().document?.pages.length === 4);
    assert.equal(await status(page).count(), 0);
  }, { width: 1440, height: 900 }, true);

  console.log(JSON.stringify({ checks, failures, screenshots: output }, null, 2));
  if (failures.length) process.exitCode = 1;
}

try {
  server = await createServer({
    root,
    cacheDir: resolve(root, "node_modules/.vite-insert-interactions"),
    optimizeDeps: { include: ["react", "react-dom/client"] },
    server: { host: "127.0.0.1", port, strictPort: false, hmr: serve, watch: { ignored: ["**/.tmp/**", "**/src-tauri/**"] } },
    plugins: [{ name: "insert-interaction-fixture", configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        if (request.url?.split("?")[0] !== route) return next();
        try {
          response.setHeader("Content-Type", "text/html");
          response.end(await vite.transformIndexHtml(route, html));
        } catch (error) { next(error); }
      });
    } }],
  });
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}${route}`;
  console.log(`Insert fixture listening: ${url}`);
  if (serve) {
    console.log(`Demo preview: ${url}`);
    console.log("Simulated native calls only. Press Ctrl+C to stop.");
    await new Promise(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  } else {
    await runTests(url);
  }
} finally {
  await browser?.close();
  await server?.close();
}
