import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const standaloneRoot = resolve(".next", "standalone");

await Promise.all([
  rm(resolve(standaloneRoot, ".next", "static"), { force: true, recursive: true }),
  rm(resolve(standaloneRoot, "public"), { force: true, recursive: true }),
]);
