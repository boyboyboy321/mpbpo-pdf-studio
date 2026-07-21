import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const [, , repositoryArg] = process.argv;
const repository = repositoryArg || process.env.GITHUB_REPOSITORY || "buiqu/mpbpo-pdf-studio";

if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
  console.error("Usage: node scripts/create-github-release-json.mjs owner/repo");
  process.exit(1);
}

const appConfig = JSON.parse(await readFile(resolve("src-tauri", "tauri.conf.json"), "utf8"));
const version = appConfig.version;
const outputDir = resolve("dist-release");

const bundleDirs = [
  process.env.CARGO_TARGET_DIR
    ? resolve(process.env.CARGO_TARGET_DIR, "release", "bundle", "nsis")
    : undefined,
  resolve("src-tauri", "target-release-clean", "release", "bundle", "nsis"),
  resolve("src-tauri", "target", "release", "bundle", "nsis"),
].filter(Boolean);

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

const installerPath = await findNewestInstaller();

if (!installerPath) {
  console.error("No NSIS installer found. Build first with: pnpm tauri build --bundles nsis");
  console.error(`Searched:\n${bundleDirs.map((directory) => `- ${directory}`).join("\n")}`);
  process.exit(1);
}

const signaturePath = `${installerPath}.sig`;
let signature = "";

try {
  signature = (await readFile(signaturePath)).toString("base64");
} catch {
  console.error(`Missing updater signature: ${signaturePath}`);
  console.error("Run the build with TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH set.");
  process.exit(1);
}

await rm(outputDir, { force: true, recursive: true });
await mkdir(outputDir, { recursive: true });

const installerName = basename(installerPath);
const releaseInstallerName = installerName.replace(/\s+/g, "-");
const signatureName = `${releaseInstallerName}.sig`;
const installerOutputPath = join(outputDir, releaseInstallerName);
const signatureOutputPath = join(outputDir, signatureName);

await copyFile(installerPath, installerOutputPath);
await copyFile(signaturePath, signatureOutputPath);

const encodedInstallerName = encodeURIComponent(releaseInstallerName);
const latest = {
  version,
  notes: `MpBPO PDF Studio ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature,
      url: `https://github.com/${repository}/releases/latest/download/${encodedInstallerName}`,
    },
  },
};

await writeFile(join(outputDir, "latest.json"), `${JSON.stringify(latest, null, 2)}\n`, "utf8");

const appPolicy = {
  schemaVersion: 1,
  appId: "mpbpo-pdf-studio",
  version,
  minVersion: "0.0.0",
  mandatoryUpdate: true,
  blocked: false,
  blockedVersions: [],
  message: `MpBPO PDF Studio ${version} is active.`,
};

await writeFile(join(outputDir, "app-policy.json"), `${JSON.stringify(appPolicy, null, 2)}\n`, "utf8");

console.log(`Prepared ${releaseInstallerName}`);
console.log(`Prepared ${signatureName}`);
console.log("Prepared latest.json");
console.log("Prepared app-policy.json");
