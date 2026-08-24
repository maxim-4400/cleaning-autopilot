import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { z } from "zod";

import { pricingRulesSchema, type PricingRules } from "@/lib/contracts/domain";
import baselineJson from "../../../runtime-config/demo-console.baseline.json";

// The file layout stays at v1 for deployment compatibility. Revision metadata
// is derived at read time, so existing persisted files continue to work.
const schemaVersion = 1;
const maxPromptCharacters = 12_000;
const maxPricingRulesCharacters = 12_000;
const mutationQueues = new Map<string, Promise<void>>();

const persistedConfigSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  systemPrompt: z.string().trim().min(1).max(maxPromptCharacters),
  pricingRules: pricingRulesSchema,
}).strict();

const editableConfigSchema = z.object({
  systemPrompt: z.string().trim().min(1).max(maxPromptCharacters),
  pricingRulesText: z.string().trim().min(2).max(maxPricingRulesCharacters),
}).strict();

export type DemoConsoleConfig = z.infer<typeof persistedConfigSchema>;
export type DemoConsoleConfigSource = "baseline" | "active";

export type DemoConsoleConfigView = {
  source: DemoConsoleConfigSource;
  systemPrompt: string;
  pricingRules: PricingRules;
  pricingRulesText: string;
  revision?: string;
  savedAt?: string;
};

export type EditableDemoConsoleConfig = z.infer<typeof editableConfigSchema>;

export class RuntimeConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigValidationError";
  }
}

export type DemoConsoleConfigStoreOptions = {
  baselinePath?: string;
  activePath?: string;
};

/**
 * The baseline is version controlled. The active file is deliberately kept
 * outside the application source tree by default, so it can later be mounted
 * on a server volume without changing the read/write contract.
 *
 * This store does not replace the legacy immutable `agent_config` rows. It is
 * the explicit, server-only configuration source for the Demo Console. Wiring
 * a future runtime override into the delivery path needs a separate migration
 * and versioning decision so historical leads keep their original snapshots.
 */
export class DemoConsoleConfigStore {
  private readonly baselinePath: string | undefined;
  private readonly activePath: string;

  constructor(options: DemoConsoleConfigStoreOptions = {}) {
    this.baselinePath = options.baselinePath;
    this.activePath = options.activePath ?? resolve(
      process.cwd(),
      process.env.DEMO_CONSOLE_CONFIG_PATH ?? ".runtime/demo-console.json",
    );
  }

  async load(): Promise<DemoConsoleConfigView> {
    const baseline = await this.readBaseline();
    try {
      const active = await this.readConfig(this.activePath, "active");
      return toView(active, "active");
    } catch (error) {
      // A hand-edited or interrupted active file must never take down a new
      // customer turn. Keep the file for diagnosis and use the known-good,
      // version-controlled baseline until an admin saves a valid replacement.
      if (isMissingFile(error) || error instanceof RuntimeConfigValidationError) return toView(baseline, "baseline");
      throw error;
    }
  }

  async save(input: unknown): Promise<DemoConsoleConfigView> {
    const validated = editableConfigSchema.safeParse(input);
    if (!validated.success) throw new RuntimeConfigValidationError("Prompt or pricing rules are invalid");

    let pricingRulesJson: unknown;
    try {
      pricingRulesJson = JSON.parse(validated.data.pricingRulesText);
    } catch {
      throw new RuntimeConfigValidationError("Pricing rules must be valid JSON");
    }

    const pricingRules = pricingRulesSchema.safeParse(pricingRulesJson);
    if (!pricingRules.success) throw new RuntimeConfigValidationError("Pricing rules do not match the supported contract");

    const config: DemoConsoleConfig = {
      schemaVersion,
      systemPrompt: validated.data.systemPrompt,
      pricingRules: pricingRules.data,
    };
    return this.withExclusiveMutation(async () => {
      await this.atomicWrite(config);
      return toView(config, "active", new Date().toISOString());
    });
  }

  async saveSection(input: unknown): Promise<DemoConsoleConfigView> {
    const parsed = z.object({ section: z.enum(["prompt", "pricing"]), expectedRevision: z.string().min(1), systemPrompt: z.string().optional(), pricingRules: pricingRulesSchema.optional() }).strict().safeParse(input);
    if (!parsed.success) throw new RuntimeConfigValidationError("Configuration section is invalid");
    return this.withExclusiveMutation(async () => {
      const current = await this.load();
      if (current.revision !== parsed.data.expectedRevision) throw new RuntimeConfigConflictError();
      const config = await this.readEffectiveConfig();
      const next: DemoConsoleConfig = parsed.data.section === "prompt"
        ? { ...config, schemaVersion, systemPrompt: z.string().trim().min(1).max(maxPromptCharacters).parse(parsed.data.systemPrompt) }
        : { ...config, schemaVersion, pricingRules: pricingRulesSchema.parse(parsed.data.pricingRules) };
      const savedAt = new Date().toISOString();
      await this.atomicWrite(next);
      return toView(next, "active", savedAt);
    });
  }

  async resetSection(input: unknown): Promise<DemoConsoleConfigView> {
    const parsed = z.object({ section: z.enum(["prompt", "pricing"]), expectedRevision: z.string().min(1) }).strict().safeParse(input);
    if (!parsed.success) throw new RuntimeConfigValidationError("Configuration section is invalid");
    return this.withExclusiveMutation(async () => {
      const current = await this.load();
      if (current.revision !== parsed.data.expectedRevision) throw new RuntimeConfigConflictError();
      const [config, baseline] = await Promise.all([this.readEffectiveConfig(), this.readBaseline()]);
      const next: DemoConsoleConfig = parsed.data.section === "prompt"
        ? { ...config, schemaVersion, systemPrompt: baseline.systemPrompt }
        : { ...config, schemaVersion, pricingRules: baseline.pricingRules };
      const savedAt = new Date().toISOString();
      await this.atomicWrite(next);
      return toView(next, "active", savedAt);
    });
  }

  async resetToBaseline(): Promise<DemoConsoleConfigView> {
    const baseline = await this.readBaseline();
    return this.withExclusiveMutation(async () => {
      await this.atomicWrite(baseline);
      return toView(baseline, "active", new Date().toISOString());
    });
  }

  async resetToBaselineAtRevision(expectedRevision: string): Promise<DemoConsoleConfigView> {
    if (!expectedRevision.trim()) throw new RuntimeConfigValidationError("Configuration revision is required");
    return this.withExclusiveMutation(async () => {
      const current = await this.load();
      if (current.revision !== expectedRevision) throw new RuntimeConfigConflictError();
      const baseline = await this.readBaseline();
      await this.atomicWrite(baseline);
      return toView(baseline, "active", new Date().toISOString());
    });
  }

  private async readBaseline(): Promise<DemoConsoleConfig> {
    if (this.baselinePath) return this.readConfig(this.baselinePath, "baseline");
    const parsed = persistedConfigSchema.safeParse(baselineJson);
    if (!parsed.success) throw new RuntimeConfigValidationError("Baseline Demo Console configuration is invalid");
    return parsed.data;
  }

  private async readConfig(path: string, source: DemoConsoleConfigSource): Promise<DemoConsoleConfig> {
    let contents: string;
    try {
      contents = await readFile(path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) throw error;
      throw new RuntimeConfigValidationError(`Could not read ${source} Demo Console configuration`);
    }

    let json: unknown;
    try {
      json = JSON.parse(contents);
    } catch {
      throw new RuntimeConfigValidationError(`${capitalize(source)} Demo Console configuration is not valid JSON`);
    }

    const parsed = persistedConfigSchema.safeParse(json);
    if (!parsed.success) throw new RuntimeConfigValidationError(`${capitalize(source)} Demo Console configuration is invalid`);
    return { ...parsed.data, schemaVersion };
  }

  private async readEffectiveConfig(): Promise<DemoConsoleConfig> {
    const baseline = await this.readBaseline();
    try { return await this.readConfig(this.activePath, "active"); } catch (error) { if (isMissingFile(error) || error instanceof RuntimeConfigValidationError) return baseline; throw error; }
  }

  private async atomicWrite(config: DemoConsoleConfig): Promise<void> {
    const directory = dirname(this.activePath);
    await mkdir(directory, { recursive: true });
    const temporaryPath = resolve(directory, `.${randomUUID()}.demo-console-config.tmp`);
    const contents = `${JSON.stringify(config, null, 2)}\n`;
    try {
      await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporaryPath, this.activePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async withExclusiveMutation<T>(operation: () => Promise<T>): Promise<T> {
    let release: (() => void) | undefined;
    const ownTurn = new Promise<void>((resolve) => { release = resolve; });
    const prior = mutationQueues.get(this.activePath) ?? Promise.resolve();
    const queued = prior.then(() => ownTurn);
    mutationQueues.set(this.activePath, queued);
    await prior;
    try {
      return await operation();
    } finally {
      release?.();
      if (mutationQueues.get(this.activePath) === queued) mutationQueues.delete(this.activePath);
    }
  }
}

export function getDemoConsoleConfigStore(): DemoConsoleConfigStore {
  return new DemoConsoleConfigStore();
}

function toView(config: DemoConsoleConfig, source: DemoConsoleConfigSource, savedAt?: string): DemoConsoleConfigView {
  return {
    source,
    systemPrompt: config.systemPrompt,
    pricingRules: config.pricingRules,
    pricingRulesText: JSON.stringify(config.pricingRules, null, 2),
    revision: createHash("sha256").update(JSON.stringify({ systemPrompt: config.systemPrompt, pricingRules: config.pricingRules })).digest("hex").slice(0, 16),
    savedAt,
  };
}

export class RuntimeConfigConflictError extends Error {
  constructor() { super("Configuration was changed by another session"); this.name = "RuntimeConfigConflictError"; }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
