import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(root, "scripts/webview2-runtime.json"), "utf8"));
const destination = join(root, "src-tauri/resources/webview2");
const cacheRoot = join(root, ".codex/webview-downloads");
const checkOnly = process.argv.includes("--check");

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}
async function run(command, args) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    // Do not pass PowerShell 7 module paths to Windows PowerShell 5.
    if (command === "powershell.exe") delete env.PSModulePath;
    const child = spawn(command, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", data => output += data);
    child.stderr.on("data", data => output += data);
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve(output) : reject(new Error(`${command} failed (${code}): ${output.slice(-2000)}`)));
  });
}
async function verifyRuntime(directory) {
  for (const file of ["msedgewebview2.exe", "msedge.dll", "icudtl.dat", "resources.pak", "locales/en-US.pak"]) {
    if (!await exists(join(directory, file))) throw new Error(`Incomplete WebView2 runtime: ${file}`);
  }
  const exe = join(directory, "msedgewebview2.exe").replaceAll("'", "''");
  const result = JSON.parse(await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `$s = Get-AuthenticodeSignature -LiteralPath '${exe}'; $v = (Get-Item -LiteralPath '${exe}').VersionInfo.ProductVersion; @{status=$s.Status.ToString(); signer=$s.SignerCertificate.Subject; version=$v} | ConvertTo-Json -Compress`,
  ]));
  if (result.status !== "Valid" || !result.signer?.includes("O=Microsoft Corporation") || result.version !== manifest.version) {
    throw new Error("WebView2 signature or version does not match the tested Microsoft runtime.");
  }
}
async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

try {
  if (process.platform !== "win32" || process.arch !== manifest.architecture) {
    throw new Error("This runtime is for Windows x64 builds only.");
  }
  if (await exists(destination)) {
    const installed = JSON.parse(await readFile(join(destination, ".verified-runtime.json"), "utf8"));
    if (installed.sha256 !== manifest.sha256) throw new Error("The bundled WebView2 version differs from the pinned manifest.");
    await verifyRuntime(destination);
  } else {
    if (checkOnly) throw new Error("Bundled WebView2 is missing. Run node scripts/prepare-webview2.mjs on the development computer first.");
    await mkdir(cacheRoot, { recursive: true });
    const archiveOption = process.argv.indexOf("--archive");
    if (archiveOption >= 0 && !process.argv[archiveOption + 1]) throw new Error("--archive requires a CAB file path.");
    const archive = archiveOption >= 0 ? resolve(process.argv[archiveOption + 1]) : join(cacheRoot, `${manifest.version}.cab`);
    if (!await exists(archive)) {
      if (archiveOption >= 0) throw new Error("The supplied CAB file does not exist.");
      console.log(`Downloading Microsoft WebView2 ${manifest.version} for packaging (development computer only)...`);
      const response = await fetch(manifest.url);
      if (!response.ok || !response.body) throw new Error(`WebView2 download failed: ${response.status}`);
      const partial = `${archive}.partial`;
      await pipeline(response.body, createWriteStream(partial));
      await rename(partial, archive);
    }
    if (await digest(archive) !== manifest.sha256) throw new Error("WebView2 archive SHA-256 mismatch. Nothing was installed.");
    const stage = resolve(cacheRoot, `extract-${process.pid}-${Date.now()}`);
    if (!stage.startsWith(resolve(cacheRoot) + sep)) throw new Error("Invalid extraction directory.");
    await mkdir(stage);
    try {
      await run("expand.exe", [archive, "-F:*", stage]);
      const extracted = join(stage, `Microsoft.WebView2.FixedVersionRuntime.${manifest.version}.${manifest.architecture}`);
      await verifyRuntime(extracted);
      await mkdir(dirname(destination), { recursive: true });
      if (!resolve(extracted).startsWith(stage + sep) || !destination.startsWith(root + sep)) {
        throw new Error("Invalid runtime installation paths.");
      }
      await writeFile(join(extracted, ".verified-runtime.json"), JSON.stringify(manifest, null, 2) + "\n");
      await rename(extracted, destination);
    } finally {
      // Only this invocation's verified staging directory is removed.
      await rm(stage, { recursive: true, force: true });
    }
  }
  console.log(`Bundled WebView2 ${manifest.version}: ready. System WebView2 is unchanged.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
