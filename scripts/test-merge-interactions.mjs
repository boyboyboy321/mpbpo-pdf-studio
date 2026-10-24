import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createServer } from "vite";

const root = resolve(process.argv[2] || ".");
const output = resolve(root, ".tmp/merge-interactions");
const fixture = await readFile(resolve(root, "scripts/fixtures/merge-interactions.mjs"), "utf8");
const route = "/__merge_test";
const html = `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module">${fixture}</script></body></html>`;
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); } catch { playwright = require(resolve(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright")); }
let server, browser, passed = 0, failed = 0;
const snap = page => page.evaluate(() => window.__mergeFixture.snapshot());
const config = (page, options) => page.evaluate(options => window.__mergeFixture.configure(options), options);
const modal = page => page.getByRole("dialog", { name: "Merge PDF", exact: true });
const merge = page => modal(page).getByRole("button", { name: "Merge", exact: true });
const names = page => page.locator(".merge-file-name strong").allTextContents();
const idle = page => page.waitForFunction(() => window.__mergeFixture.snapshot().job === null);
async function add(page) {
  await page.getByRole("button", { name: "Add PDFs", exact: true }).click();
  await idle(page);
}
async function start(page, count = 1) {
  await merge(page).click();
  await page.waitForFunction(count => window.__mergeFixture.snapshot().requests.length === count, count);
}
async function finish(page, options = {}) {
  await page.evaluate(options => window.__mergeFixture.finish(options), options);
  await idle(page);
  await page.waitForFunction(() => window.__mergeFixture.snapshot().listeners === 0);
}
async function geometry(page) {
  const value = await modal(page).evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const footer = element.querySelector(".merge-footer").getBoundingClientRect();
    const list = element.querySelector(".merge-list-scroll").getBoundingClientRect();
    const destination = element.querySelector(".merge-destination").getBoundingClientRect();
    return { x: bounds.x, y: bounds.y, right: bounds.right, bottom: bounds.bottom, width: innerWidth, height: innerHeight,
      overflow: element.scrollWidth > element.clientWidth + 1, footerBottom: footer.bottom, listBottom: list.bottom, destinationTop: destination.top };
  });
  assert(value.x >= 0 && value.y >= 0 && value.right <= value.width && value.bottom <= value.height, JSON.stringify(value));
  assert(!value.overflow, "Dialog must not overflow horizontally");
  assert(value.footerBottom <= value.bottom && value.listBottom <= value.destinationTop + 1, "Sections cannot overlap");
}
async function run(name, body, viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  try {
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}${route}`);
    await page.getByRole("button", { name: "Merge PDF", exact: true }).click();
    await modal(page).waitFor();
    await body(page);
    assert.deepEqual(errors, []);
    console.log("PASS " + name); passed++;
  } catch (error) {
    console.error("FAIL " + name + ": " + error.stack, errors); failed++;
    await page.screenshot({ path: resolve(output, "failure-" + failed + ".png") });
  } finally { await context.close(); }
}
try {
  server = await createServer({ root, cacheDir: resolve(root, "node_modules/.vite-merge-interactions"),
    optimizeDeps: { include: ["react", "react-dom/client"] },
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, watch: { ignored: ["**/.tmp/**", "**/src-tauri/**"] } },
    plugins: [{ name: "merge-fixture", configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        if (request.url !== route) return next();
        try { response.setHeader("Content-Type", "text/html"); response.end(await vite.transformIndexHtml(route, html)); } catch (error) { next(error); }
      });
    } }],
  });
  await server.listen();
  browser = await playwright.chromium.launch({ channel: "chrome", headless: true });
  await mkdir(output, { recursive: true });

  await run("Home entrypoint, two destinations, default, picker cancel and dedup", async page => {
    assert.equal(await page.getByLabel("Files location", { exact: true }).inputValue(), "customFolder");
    assert.equal(await page.locator("#merge-location option").count(), 2);
    assert.equal(await merge(page).isDisabled(), true);
    await config(page, { files: null });
    await add(page);
    assert.deepEqual(await names(page), []);
    await config(page, { files: ["C:/First/alpha.pdf", "c:\\first\\ALPHA.pdf", "D:/Second/beta.pdf"] });
    await add(page);
    assert.deepEqual(await names(page), ["alpha.pdf", "beta.pdf"]);
    await add(page);
    assert.equal((await names(page)).length, 2);
    await geometry(page);
    await page.keyboard.press("Escape");
    await modal(page).waitFor({ state: "hidden" });
    assert.equal(await page.getByRole("button", { name: "Merge PDF", exact: true }).evaluate(element => element === document.activeElement), true);
  });

  await run("Sequential checks continue after errors; busy close lock; retained details", async page => {
    await config(page, { holdMetadata: true });
    await page.getByRole("button", { name: "Add PDFs", exact: true }).click();
    await page.waitForFunction(() => window.__mergeFixture.snapshot().pendingMetadata.length === 1);
    await page.keyboard.press("Escape");
    assert.equal(await modal(page).isVisible(), true);
    assert.equal(await page.getByRole("button", { name: "Close merge" }).isDisabled(), true);
    await page.evaluate(() => window.__mergeFixture.nextMetadata("Broken first PDF"));
    await page.waitForFunction(() => window.__mergeFixture.snapshot().pendingMetadata[0]?.endsWith("beta.pdf"));
    await page.evaluate(() => window.__mergeFixture.nextMetadata("Broken second PDF"));
    await page.waitForFunction(() => window.__mergeFixture.snapshot().pendingMetadata[0]?.endsWith("gamma.pdf"));
    await page.evaluate(() => window.__mergeFixture.nextMetadata());
    await idle(page);
    assert.equal(await merge(page).isDisabled(), true);
    await page.getByRole("button", { name: "View merge error details" }).click();
    assert.equal(await page.getByRole("region", { name: "Merge errors" }).locator("strong").count(), 2);
    await config(page, { holdMetadata: false, files: ["C:/Other/delta.pdf"] });
    await add(page);
    await page.getByRole("button", { name: "View merge error details" }).click();
    assert.equal(await page.getByRole("region", { name: "Merge errors" }).locator("strong").count(), 2);
    await page.getByRole("button", { name: "Remove alpha.pdf", exact: true }).click();
    await page.getByRole("button", { name: "View merge error details" }).click();
    assert.equal(await page.getByRole("region", { name: "Merge errors" }).locator("strong").count(), 1);
    await page.getByRole("button", { name: "Remove beta.pdf", exact: true }).click();
    assert.equal(await merge(page).isEnabled(), true);
  });

  await run("Pointer and keyboard reorder, sibling destination follows first file", async page => {
    await add(page);
    const source = await page.getByRole("button", { name: "Move beta.pdf", exact: true }).boundingBox();
    const target = await page.getByRole("button", { name: "Move alpha.pdf", exact: true }).boundingBox();
    await page.mouse.move(source.x + 12, source.y + 15);
    await page.mouse.down();
    await page.mouse.move(source.x + 12, source.y - 8, { steps: 4 });
    await page.mouse.move(target.x + 12, target.y + 5, { steps: 12 });
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector(".merge-file-name strong")?.textContent === "beta.pdf");
    await page.getByLabel("Files location", { exact: true }).selectOption("siblingFolder");
    assert.match(await page.locator(".merge-folder").innerText(), /D:\/Second/);
    await page.getByRole("button", { name: "Move gamma.pdf", exact: true }).focus();
    await page.keyboard.press("Space");
    await page.locator(".merge-file-row.is-dragging").waitFor();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.keyboard.press("ArrowUp");
    await page.waitForFunction(() => document.querySelector(".merge-file-row.is-dragging")?.style.transform.includes("-68"));
    await page.keyboard.press("Space");
    await page.waitForFunction(() => [...document.querySelectorAll(".merge-file-name strong")][1]?.textContent === "gamma.pdf");
    await start(page);
    assert.deepEqual((await snap(page)).requests[0].paths, ["D:/Second/beta.pdf", "C:/First/gamma.pdf", "C:/First/alpha.pdf"]);
    assert.deepEqual((await snap(page)).requests[0].outputOptions, { mode: "siblingFolder", customFolderPath: null });
    await finish(page);
  });

  await run("Folder cancellation, progress isolation, busy locks, success and folder failure", async page => {
    await add(page);
    await config(page, { folder: null });
    await merge(page).click();
    assert.equal((await snap(page)).requests.length, 0);
    assert.equal((await names(page)).length, 3);
    await config(page, { folder: "C:/Chosen" });
    await start(page);
    assert.deepEqual((await snap(page)).requests[0].outputOptions, { mode: "customFolder", customFolderPath: "C:/Chosen" });
    await page.evaluate(() => window.__mergeFixture.emit({ runId: "foreign", currentFileName: "foreign.pdf" }));
    assert(!await page.locator(".merge-status").innerText().then(text => text.includes("foreign")));
    await page.evaluate(() => window.__mergeFixture.emit());
    await page.locator(".merge-status").getByText(/Merging files 1\/3 - 3\/9 pages/).waitFor();
    await page.keyboard.press("Escape");
    assert.equal(await modal(page).isVisible(), true);
    assert.equal(await page.getByRole("button", { name: "Add PDFs" }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Move alpha.pdf", exact: true }).isDisabled(), true);
    await finish(page);
    await page.locator(".merge-status").getByText(/Merged 9 pages/).waitFor();
    await config(page, { folderError: true });
    await page.getByRole("button", { name: "Open folder", exact: true }).click();
    await page.locator(".merge-status").getByText(/Folder cannot be opened/).waitFor();
    await page.screenshot({ path: resolve(output, "success-1440x900.png") });
    await modal(page).getByRole("button", { name: "Open PDF", exact: true }).click();
    assert.equal((await snap(page)).opened, "C:/Output/merge_20261024.pdf");
    await modal(page).waitFor({ state: "hidden" });
  });

  await run("Backend error list, rejected merge, retries and listener cleanup", async page => {
    await add(page);
    await start(page);
    await finish(page, { errors: ["alpha", "beta"].map(name => ({ filePath: name + ".pdf", fileName: name + ".pdf", pageNumber: 2, message: "Missing page content" })) });
    await page.getByRole("button", { name: "View merge error details" }).click();
    assert.equal(await page.getByRole("region", { name: "Merge errors" }).locator("strong").count(), 2);
    assert.equal(await modal(page).getByRole("button", { name: "Open PDF", exact: true }).count(), 0);
    await start(page, 2);
    await finish(page, { reject: "Disk is full" });
    await page.locator(".merge-status").getByText(/Disk is full/).waitFor();
    await start(page, 3);
    await finish(page);
    await page.locator(".merge-status").getByText(/Merged 9 pages/).waitFor();
    assert.equal((await snap(page)).listeners, 0);
    assert((await snap(page)).calls.every(call => !/delete|remove_file/.test(call.command)));
    await page.getByRole("button", { name: "Clear file list" }).click();
    assert.deepEqual(await names(page), []);
  });

  for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 800, height: 600 }, { width: 390, height: 844 }]) {
    await run("Long names, scrolling and errors fit " + viewport.width + "x" + viewport.height, async page => {
      const files = Array.from({ length: 18 }, (_, index) => "C:/Documents/" + index + "-Long-engineering-document-".repeat(8) + ".pdf");
      await config(page, { files });
      await add(page);
      await geometry(page);
      const scrollable = await page.locator(".merge-list-scroll").evaluate(element => element.scrollHeight > element.clientHeight);
      assert.equal(scrollable, true);
      await start(page);
      await page.evaluate(() => window.__mergeFixture.emit({ currentFileName: "Long-file-".repeat(40) + ".pdf" }));
      await geometry(page);
      await finish(page, { errors: files.slice(0, 6).map(path => ({ filePath: path, fileName: path.split("/").at(-1), pageNumber: 10, message: "Cannot decode page: " + "Long error reason ".repeat(15) })) });
      await page.getByRole("button", { name: "View merge error details" }).click();
      await geometry(page);
      await page.screenshot({ path: resolve(output, "errors-" + viewport.width + "x" + viewport.height + ".png") });
    }, viewport);
  }
  console.log(JSON.stringify({ passed, failed, screenshots: output }));
  if (failed) process.exitCode = 1;
} finally {
  await browser?.close();
  await server?.close();
}
