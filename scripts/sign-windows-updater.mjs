import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const outputDir = resolve("dist-release");
const appConfig = JSON.parse(await readFile(resolve("src-tauri", "tauri.conf.json"), "utf8"));

const bundleDirs = [
  process.env.CARGO_TARGET_DIR
    ? resolve(process.env.CARGO_TARGET_DIR, "release", "bundle", "nsis")
    : undefined,
  resolve("src-tauri", "target-release-clean", "release", "bundle", "nsis"),
  resolve("src-tauri", "target", "release", "bundle", "nsis"),
].filter(Boolean);

function decodeTauriKey(encodedOrDecoded, label) {
  const trimmed = encodedOrDecoded.trim();

  if (trimmed.startsWith("untrusted comment:")) {
    return trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
  }

  try {
    return Buffer.from(trimmed, "base64").toString("utf8");
  } catch {
    throw new Error(`${label} is not a valid Tauri updater key`);
  }
}

async function findNewestInstaller() {
  const installers = [];

  for (const bundleDir of bundleDirs) {
    let entries = [];

    try {
      entries = await readdir(bundleDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith(".exe")) {
        continue;
      }

      const filePath = join(bundleDir, entry);
      const metadata = await stat(filePath);
      installers.push({ filePath, modifiedMs: metadata.mtimeMs });
    }
  }

  installers.sort((left, right) => right.modifiedMs - left.modifiedMs);
  return installers[0]?.filePath;
}

function runRsign(args) {
  const result = spawnSync("rsign", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error([result.stdout, result.stderr].filter(Boolean).join("\n").trim());
  }

  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

const installerPath = await findNewestInstaller();

if (!installerPath) {
  console.error("No NSIS installer found. Build first with: pnpm tauri build --bundles nsis");
  console.error(`Searched:\n${bundleDirs.map((directory) => `- ${directory}`).join("\n")}`);
  process.exit(1);
}

const privateKeyInput =
  process.env.TAURI_SIGNING_PRIVATE_KEY ||
  (process.env.TAURI_SIGNING_PRIVATE_KEY_PATH
    ? await readFile(process.env.TAURI_SIGNING_PRIVATE_KEY_PATH, "utf8")
    : "");

if (!privateKeyInput) {
  console.error("Missing updater private key. Set TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH.");
  process.exit(1);
}

const publicKeyInput = appConfig.plugins?.updater?.pubkey;

if (!publicKeyInput) {
  console.error("Missing plugins.updater.pubkey in src-tauri/tauri.conf.json.");
  process.exit(1);
}

let tempDir = "";

try {
  tempDir = await mkdtemp(join(tmpdir(), "mpbpo-updater-sign-"));

  const privateKeyPath = join(tempDir, "updater.key");
  const publicKeyPath = join(tempDir, "updater.pub");
  const signaturePath = `${installerPath}.sig`;

  await writeFile(privateKeyPath, decodeTauriKey(privateKeyInput, "Private key"), "utf8");
  await writeFile(publicKeyPath, decodeTauriKey(publicKeyInput, "Public key"), "utf8");

  runRsign(["sign", "-s", privateKeyPath, "-x", signaturePath, "-W", installerPath]);
  runRsign(["verify", "-p", publicKeyPath, "-x", signaturePath, installerPath]);

  console.log(`Signed ${basename(installerPath)}`);
  console.log(`Prepared ${basename(signaturePath)}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
}
