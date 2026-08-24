import { cp, mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const buildRoot = resolve(".next");
const standaloneRoot = resolve(buildRoot, "standalone");
const staticSource = resolve(buildRoot, "static");
const staticDestination = resolve(standaloneRoot, ".next", "static");
const publicSource = resolve("public");
const publicDestination = resolve(standaloneRoot, "public");

await copyRequiredDirectory(staticSource, staticDestination, ".next/static");
await copyOptionalDirectory(publicSource, publicDestination, "public");

async function copyRequiredDirectory(source, destination, label) {
  await mkdir(destination, { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
  const entries = await readdir(destination);
  if (entries.length === 0) {
    throw new Error(`Standalone output is missing copied ${label} assets.`);
  }
}

async function copyOptionalDirectory(source, destination, label) {
  try {
    await mkdir(destination, { recursive: true });
    await cp(source, destination, { recursive: true, force: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw new Error(`Could not copy ${label} into standalone output.`, { cause: error });
  }
}
