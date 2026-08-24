import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("generated integration assets", () => {
  it("keeps the official OpenAI Blossom source unchanged instead of the unrelated Gym icon", async () => {
    const svg = await readFile(resolve("public/brand/integrations/ai-assistant.svg"));
    expect(createHash("sha256").update(svg).digest("hex")).toBe("01485e70cea6df8422f5abc643fbbd3c153442cc41da0e7d8e7451801ebf26e2");
    expect(svg.toString("utf8")).not.toContain("OpenAI Gym");
  });
});
