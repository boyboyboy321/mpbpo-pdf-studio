import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [, , repositoryArg] = process.argv;

if (!repositoryArg || !/^[\w.-]+\/[\w.-]+$/.test(repositoryArg)) {
  console.error("Usage: node scripts/configure-updater.mjs owner/repo");
  process.exit(1);
}

const configPath = resolve("src-tauri", "tauri.conf.json");
const config = JSON.parse(await readFile(configPath, "utf8"));

config.plugins ??= {};
config.plugins.updater ??= {};
config.plugins.updater.active = true;
config.plugins.updater.endpoints = [`https://github.com/${repositoryArg}/releases/latest/download/latest.json`];

await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

console.log(`Updater endpoint set to ${repositoryArg}`);
