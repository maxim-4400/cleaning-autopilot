import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("generated integration assets", () => {
  it("uses a standalone OpenAI mark, rather than cropping a source sheet or substituting the unrelated Gym icon", async () => {
    const svg = await readFile(resolve("public/brand/integrations/openai-icon.svg"), "utf8");
    expect(svg).toContain('viewBox="146 227 268 265"');
    expect(svg).toContain("<path");
    expect(svg).not.toContain("OpenAI Gym");
    expect(svg).not.toContain("<image");
  });
});
