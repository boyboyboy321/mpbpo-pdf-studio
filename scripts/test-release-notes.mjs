import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createServer } from "vite";

const root = resolve(process.argv[2] || ".");
const output = resolve(root, ".tmp/release-notes-test");
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); } catch {
  playwright = require(resolve(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"));
}
const route = "/__release_notes_test";
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module">
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "/src/App.tsx";
createRoot(document.getElementById("root")).render(React.createElement(App));
window.backgroundKeys = [];
window.addEventListener("keydown", event => window.backgroundKeys.push(event.key));
</script></body></html>`;
let server, browser;
try {
  await mkdir(output, { recursive: true });
  server = await createServer({
    root, cacheDir: resolve(root, "node_modules/.vite-release-notes"),
    optimizeDeps: { include: ["react", "react-dom/client"] },
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, watch: { ignored: ["**/.tmp/**", "**/src-tauri/**"] } },
    plugins: [{ name: "release-notes-fixture", configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        if (request.url !== route) return next();
        try {
          response.setHeader("Content-Type", "text/html");
          response.end(await vite.transformIndexHtml(route, html));
        } catch (error) { next(error); }
      });
    } }],
  });
  await server.listen();
  browser = await playwright.chromium.launch({ channel: "chrome", headless: true });
  for (const viewport of [{width:1100,height:720},{width:1440,height:900},{width:1920,height:1080},{width:800,height:600}]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}${route}`);
    const trigger = page.getByRole("button", { name: "What's new", exact: true });
    const dialog = page.getByRole("dialog", { name: "What's new", exact: true });
    const titlebar = page.locator(".app-titlebar");
    const controls = page.locator(".window-control-group");
    await trigger.waitFor().catch(async error => {
      console.error(errors);
      await page.screenshot({ path: resolve(output, "failure.png") });
      throw error;
    });
    assert.equal(await trigger.innerText(), "");
    const before = await titlebar.boundingBox();
    const windowControls = await controls.boundingBox();
    assert.equal(before.height, 38);
    assert.equal(windowControls.width, 146);
    assert.equal(windowControls.x + windowControls.width, viewport.width);
    await trigger.hover();
    await page.waitForTimeout(300);
    assert.equal(await dialog.isVisible(), false, "Hover must not open release notes");
    await trigger.click();
    await dialog.waitFor();
    assert.match(await dialog.innerText(), new RegExp(pkg.version.replaceAll(".", "\\.")));
    assert.equal(await dialog.locator("section").count(), 4);
    const body = dialog.getByRole("region", { name: "Release notes" });
    const bounds = await dialog.boundingBox();
    assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height);
    assert.equal(await dialog.evaluate(el => el.scrollWidth > el.clientWidth), false);
    assert.deepEqual(await titlebar.boundingBox(), before);
    assert.deepEqual(await controls.boundingBox(), windowControls);
    await page.keyboard.press("Tab");
    assert.equal(await body.evaluate(el => document.activeElement === el), true, "Tab must stay enabled inside the dialog");
    await page.evaluate(() => { window.backgroundKeys = []; });
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Delete");
    assert.deepEqual(await page.evaluate(() => window.backgroundKeys), [], "Background shortcuts must not receive modal keys");
    await body.evaluate(el => { el.scrollTop = el.scrollHeight; });
    assert(await body.evaluate(el => el.scrollTop > 0), "Long notes must scroll");
    const header = await dialog.locator("header").boundingBox();
    assert(header.y >= bounds.y && header.y + header.height < bounds.y + bounds.height);
    await page.screenshot({ path: resolve(output, `release-notes-${viewport.width}.png`) });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await trigger.evaluate(el => document.activeElement === el), true);
    await trigger.click();
    assert.equal(await body.evaluate(el => el.scrollTop), 0, "Reopening starts at the beginning");
    await dialog.getByRole("button", { name: "Close release notes" }).click();
    await dialog.waitFor({ state: "hidden" });
    await trigger.click();
    await page.mouse.click(4, viewport.height - 4);
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
    console.log(`PASS ${pkg.name} ${viewport.width}x${viewport.height}: icon, click, scroll, layout, keyboard, close, focus`);
    await page.close();
  }
} finally {
  await browser?.close();
  await server?.close();
}
