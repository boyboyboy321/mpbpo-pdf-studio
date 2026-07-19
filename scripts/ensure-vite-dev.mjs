import { spawn } from "node:child_process";

const devUrl = "http://127.0.0.1:5173/";
const startupTimeoutMs = 30_000;
const retryDelayMs = 250;

async function isServerReady() {
  try {
    const response = await fetch(devUrl, { cache: "no-store" });
    return response.ok;
  } catch {
    return false;
  }
}

if (await isServerReady()) {
  console.log(`Vite dev server already running at ${devUrl}`);
  process.exit(0);
}

const isWindows = process.platform === "win32";
const command = isWindows ? "cmd.exe" : "pnpm";
const args = isWindows ? ["/d", "/s", "/c", "pnpm.cmd dev"] : ["dev"];
const child = spawn(command, args, {
  cwd: process.cwd(),
  detached: true,
  stdio: "ignore",
});

child.unref();

const startedAt = Date.now();

while (Date.now() - startedAt < startupTimeoutMs) {
  if (await isServerReady()) {
    console.log(`Vite dev server started at ${devUrl}`);
    process.exit(0);
  }

  await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
}

console.error(`Timed out waiting for Vite dev server at ${devUrl}`);
process.exit(1);
