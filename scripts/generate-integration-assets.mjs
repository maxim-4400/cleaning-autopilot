import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { siGooglecalendar, siTelegram, siTrello } from "simple-icons";

const destination = resolve("public/brand/integrations");
// Official OpenAI Blossom asset, downloaded unchanged on 2026-08-24 from:
// https://images.ctfassets.net/kftzwdyauwt9/3hUGLn3ypllZ0oa01qOYVq/28e8188e6f11b84c3e876569d492734f/Blossom_Light.svg?w=3840&q=90
// It is deliberately not regenerated from simple-icons: that package only
// contains the unrelated OpenAI Gym icon in the version used by this project.
const assets = [
  ["telegram", siTelegram],
  ["google-calendar", siGooglecalendar],
  ["trello", siTrello],
];

await mkdir(destination, { recursive: true });
await Promise.all(assets.map(async ([name, icon]) => {
  await writeFile(resolve(destination, `${name}.svg`), icon.svg, "utf8");
}));
