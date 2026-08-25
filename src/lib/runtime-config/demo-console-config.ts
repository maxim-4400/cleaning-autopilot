import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { z } from "zod";

import { pricingRulesSchema, type PricingRules } from "@/lib/contracts/domain";
import baselineHistoryJson from "../../../runtime-config/demo-console.baseline-history.json";
import baselineJson from "../../../runtime-config/demo-console.baseline.json";

// Keep the persisted Railway Volume format at v1. Deployment-time baseline
// reconciliation is derived from version-controlled SHA-256 history instead
// of changing the active file schema or silently overwriting admin edits.
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

const sectionHistoryEntrySchema = z.object({
  semanticRevision: z.string().trim().min(1).max(80),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const baselineHistorySchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  sections: z.object({
    prompt: z.object({ current: sectionHistoryEntrySchema, history: z.array(sectionHistoryEntrySchema) }).strict(),
    pricing: z.object({ current: sectionHistoryEntrySchema, history: z.array(sectionHistoryEntrySchema) }).strict(),
  }).strict(),
}).strict();
const activeProvenanceSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  sections: z.object({
    prompt: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), pendingSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().refine((section) => section.sha256 !== undefined || section.pendingSha256 !== undefined).optional(),
    pricing: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), pendingSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().refine((section) => section.sha256 !== undefined || section.pendingSha256 !== undefined).optional(),
  }).strict(),
}).strict();
const expectedRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
const sectionMutationSchema = z.discriminatedUnion("section", [
  z.object({ section: z.literal("prompt"), expectedRevision: expectedRevisionSchema, systemPrompt: z.string() }).strict(),
  z.object({ section: z.literal("pricing"), expectedRevision: expectedRevisionSchema, pricingRules: pricingRulesSchema }).strict(),
]);

type ConfigSection = "prompt" | "pricing";
type BaselineHistory = z.infer<typeof baselineHistorySchema>;
type ActiveProvenance = z.infer<typeof activeProvenanceSchema>;

export type DemoConsoleConfig = z.infer<typeof persistedConfigSchema>;
export type DemoConsoleConfigSource = "baseline" | "active";
export type RuntimeConfigSectionMode = "baseline" | "custom";
export type RuntimeConfigSectionView = {
  mode: RuntimeConfigSectionMode;
  semanticRevision: string;
  shippedBaselineRevision: string;
  sha256: string;
  revision: string;
};

export type DemoConsoleConfigView = {
  source: DemoConsoleConfigSource;
  systemPrompt: string;
  pricingRules: PricingRules;
  pricingRulesText: string;
  revision: string;
  sections: { prompt: RuntimeConfigSectionView; pricing: RuntimeConfigSectionView };
  savedAt?: string;
};

export type EditableDemoConsoleConfig = z.infer<typeof editableConfigSchema>;

export class RuntimeConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigValidationError";
  }
}

export class RuntimeConfigConflictError extends Error {
  constructor() {
    super("Configuration was changed by another session");
    this.name = "RuntimeConfigConflictError";
  }
}

export class RuntimeConfigProvenanceError extends RuntimeConfigValidationError {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigProvenanceError";
  }
}

export type DemoConsoleConfigStoreOptions = {
  baselinePath?: string;
  baselineHistoryPath?: string;
  activePath?: string;
  provenancePath?: string;
  beforeActiveRename?: () => Promise<void> | void;
};

type ResolvedConfig = {
  config: DemoConsoleConfig;
  source: DemoConsoleConfigSource;
  sections: DemoConsoleConfigView["sections"];
  provenance?: ActiveProvenance;
};

type BaselineBundle = { config: DemoConsoleConfig; history: BaselineHistory };
type ProvenanceCommitOrder = "activate" | "deactivate";

/**
 * The version-controlled baseline is the desired shipped default. The mounted
 * v1 active file is retained across deploys. Each independent section is
 * classified by content SHA: a known prior baseline follows the newest
 * baseline, while unknown content is an intentional custom override and is
 * preserved. A malformed active file still fails safely to baseline.
 */
export class DemoConsoleConfigStore {
  private readonly baselinePath: string | undefined;
  private readonly baselineHistoryPath: string | undefined;
  private readonly activePath: string;
  private readonly provenancePath: string;
  private readonly beforeActiveRename: (() => Promise<void> | void) | undefined;

  constructor(options: DemoConsoleConfigStoreOptions = {}) {
    this.baselinePath = options.baselinePath;
    this.baselineHistoryPath = options.baselineHistoryPath;
    this.activePath = options.activePath ?? resolve(
      process.cwd(),
      process.env.DEMO_CONSOLE_CONFIG_PATH ?? ".runtime/demo-console.json",
    );
    this.provenancePath = options.provenancePath ?? `${this.activePath}.provenance.json`;
    this.beforeActiveRename = options.beforeActiveRename;
  }

  async load(): Promise<DemoConsoleConfigView> {
    return toView(await this.resolve());
  }

  // Retained for programmatic callers that already validate a full document.
  // The UI uses section-level compare-and-swap mutations below.
  async save(input: unknown): Promise<DemoConsoleConfigView> {
    const validated = editableConfigSchema.safeParse(input);
    if (!validated.success) throw new RuntimeConfigValidationError("Prompt or pricing rules are invalid");
    const config = parseEditableConfig(validated.data);
    return this.withExclusiveMutation(async () => {
      const current = await this.resolve();
      await this.atomicWrite(config, createProvenance(config, ["prompt", "pricing"]), "activate", current.provenance);
      return toView(await this.resolve(), new Date().toISOString());
    });
  }

  async saveSection(input: unknown): Promise<DemoConsoleConfigView> {
    const parsed = sectionMutationSchema.safeParse(input);
    if (!parsed.success) throw new RuntimeConfigValidationError("Configuration section is invalid");
    return this.withExclusiveMutation(async () => {
      const current = await this.resolve();
      this.assertSectionRevision(current, parsed.data.section, parsed.data.expectedRevision);
      const config: DemoConsoleConfig = parsed.data.section === "prompt"
        ? { ...current.config, systemPrompt: z.string().trim().min(1).max(maxPromptCharacters).parse(parsed.data.systemPrompt) }
        : { ...current.config, pricingRules: pricingRulesSchema.parse(parsed.data.pricingRules) };
      await this.atomicWrite(config, withCustomSection(current, config, parsed.data.section), "activate", current.provenance);
      return toView(await this.resolve(), new Date().toISOString());
    });
  }

  async resetSection(input: unknown): Promise<DemoConsoleConfigView> {
    const parsed = z.object({ section: z.enum(["prompt", "pricing"]), expectedRevision: expectedRevisionSchema }).strict().safeParse(input);
    if (!parsed.success) throw new RuntimeConfigValidationError("Configuration section is invalid");
    return this.withExclusiveMutation(async () => {
      const [current, baseline] = await Promise.all([this.resolve(), this.readBaselineBundle()]);
      this.assertSectionRevision(current, parsed.data.section, parsed.data.expectedRevision);
      const config: DemoConsoleConfig = parsed.data.section === "prompt"
        ? { ...current.config, systemPrompt: baseline.config.systemPrompt }
        : { ...current.config, pricingRules: baseline.config.pricingRules };
      await this.atomicWrite(config, withoutCustomSection(current, config, parsed.data.section), "deactivate");
      return toView(await this.resolve(), new Date().toISOString());
    });
  }

  async resetToBaseline(): Promise<DemoConsoleConfigView> {
    const baseline = await this.readBaselineBundle();
    return this.withExclusiveMutation(async () => {
      await this.atomicWrite(baseline.config, undefined, "deactivate");
      return toView(await this.resolve(), new Date().toISOString());
    });
  }

  async resetToBaselineAtRevision(expectedRevision: string): Promise<DemoConsoleConfigView> {
    if (!/^[a-f0-9]{64}$/.test(expectedRevision)) throw new RuntimeConfigValidationError("Configuration revision is required");
    return this.withExclusiveMutation(async () => {
      const current = await this.resolve();
      if (currentRevision(current.sections) !== expectedRevision) throw new RuntimeConfigConflictError();
      const baseline = await this.readBaselineBundle();
      await this.atomicWrite(baseline.config, undefined, "deactivate");
      return toView(await this.resolve(), new Date().toISOString());
    });
  }

  private assertSectionRevision(current: ResolvedConfig, section: ConfigSection, expectedRevision: string): void {
    if (current.sections[section].revision !== expectedRevision) throw new RuntimeConfigConflictError();
  }

  private async resolve(): Promise<ResolvedConfig> {
    const baseline = await this.readBaselineBundle();
    let active: DemoConsoleConfig;
    try {
      active = await this.readConfig(this.activePath, "active");
    } catch (error) {
      if (!isMissingFile(error) && !(error instanceof RuntimeConfigValidationError)) throw error;
      const prompt = baselineSectionState("prompt", baseline.config.systemPrompt, baseline.history);
      const pricing = baselineSectionState("pricing", baseline.config.pricingRules, baseline.history);
      return {
        config: baseline.config,
        source: "baseline",
        sections: { prompt, pricing },
      };
    }
    const provenance = await this.readProvenance();
    const prompt = resolveSection("prompt", active.systemPrompt, baseline.config.systemPrompt, baseline.history, isExplicitCustom(provenance, "prompt", active.systemPrompt));
    const pricing = resolveSection("pricing", active.pricingRules, baseline.config.pricingRules, baseline.history, isExplicitCustom(provenance, "pricing", active.pricingRules));
    return {
      config: { schemaVersion, systemPrompt: prompt.value, pricingRules: pricing.value },
      source: "active",
      sections: { prompt: prompt.state, pricing: pricing.state },
      provenance,
    };
  }

  private async readBaselineBundle(): Promise<BaselineBundle> {
    const config = this.baselinePath
      ? await this.readConfig(this.baselinePath, "baseline")
      : parsePersistedConfig(baselineJson, "Baseline Demo Console configuration");
    const history = this.baselineHistoryPath
      ? await this.readHistory(this.baselineHistoryPath)
      : this.baselinePath
        ? createCurrentOnlyHistory(config)
        : parseHistory(baselineHistoryJson);
    assertBaselineRegistry(config, history);
    return { config, history };
  }

  private async readHistory(path: string): Promise<BaselineHistory> {
    let contents: string;
    try {
      contents = await readFile(path, "utf8");
    } catch (error) {
      throw new RuntimeConfigValidationError(isMissingFile(error) ? "Baseline history is missing" : "Could not read baseline history");
    }
    try {
      return parseHistory(JSON.parse(contents));
    } catch (error) {
      if (error instanceof RuntimeConfigValidationError) throw error;
      throw new RuntimeConfigValidationError("Baseline history is not valid JSON");
    }
  }

  private async readProvenance(): Promise<ActiveProvenance | undefined> {
    let contents: string;
    try {
      contents = await readFile(this.provenancePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw new RuntimeConfigProvenanceError("Active configuration provenance could not be read");
    }
    try {
      const parsed = activeProvenanceSchema.safeParse(JSON.parse(contents));
      if (!parsed.success) throw new RuntimeConfigProvenanceError("Active configuration provenance is invalid");
      return parsed.data;
    } catch {
      // An existing marker protects an explicit custom value equal to a
      // historical baseline. Treat corruption as operationally unavailable,
      // never as permission to discard that protection.
      throw new RuntimeConfigProvenanceError("Active configuration provenance is invalid");
    }
  }

  private async readConfig(path: string, source: DemoConsoleConfigSource): Promise<DemoConsoleConfig> {
    let contents: string;
    try {
      contents = await readFile(path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) throw error;
      throw new RuntimeConfigValidationError(`Could not read ${source} Demo Console configuration`);
    }
    try {
      return parsePersistedConfig(JSON.parse(contents), `${capitalize(source)} Demo Console configuration`);
    } catch (error) {
      if (error instanceof RuntimeConfigValidationError) throw error;
      throw new RuntimeConfigValidationError(`${capitalize(source)} Demo Console configuration is not valid JSON`);
    }
  }

  private async atomicWrite(config: DemoConsoleConfig, provenance: ActiveProvenance | undefined, order: ProvenanceCommitOrder, previousProvenance?: ActiveProvenance): Promise<void> {
    // A rename cannot atomically commit two files. Activation first writes a
    // transition sidecar with both the currently effective hash and pending
    // target hash. If the active rename fails, the current explicit custom
    // marker remains effective; if it succeeds but finalization is interrupted,
    // the pending marker protects the new content. Deactivation reverses the
    // order because a stale marker no longer matches the new baseline config.
    if (order === "activate") await this.atomicWriteProvenance(transitionProvenance(previousProvenance, provenance));
    const directory = dirname(this.activePath);
    await mkdir(directory, { recursive: true });
    const temporaryPath = resolve(directory, `.${randomUUID()}.demo-console-config.tmp`);
    const contents = `${JSON.stringify(config, null, 2)}\n`;
    try {
      await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await this.beforeActiveRename?.();
      await rename(temporaryPath, this.activePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    if (order === "activate" || order === "deactivate") await this.atomicWriteProvenance(provenance);
  }

  private async atomicWriteProvenance(provenance: ActiveProvenance | undefined): Promise<void> {
    if (!provenance) {
      await unlink(this.provenancePath).catch((error: unknown) => { if (!isMissingFile(error)) throw error; });
      return;
    }
    const directory = dirname(this.provenancePath);
    await mkdir(directory, { recursive: true });
    const temporaryPath = resolve(directory, `.${randomUUID()}.demo-console-provenance.tmp`);
    try {
      await writeFile(temporaryPath, `${JSON.stringify(provenance, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporaryPath, this.provenancePath);
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

function parseEditableConfig(input: EditableDemoConsoleConfig): DemoConsoleConfig {
  let pricingRulesJson: unknown;
  try {
    pricingRulesJson = JSON.parse(input.pricingRulesText);
  } catch {
    throw new RuntimeConfigValidationError("Pricing rules must be valid JSON");
  }
  const pricingRules = pricingRulesSchema.safeParse(pricingRulesJson);
  if (!pricingRules.success) throw new RuntimeConfigValidationError("Pricing rules do not match the supported contract");
  return { schemaVersion, systemPrompt: input.systemPrompt, pricingRules: pricingRules.data };
}

function parsePersistedConfig(input: unknown, label: string): DemoConsoleConfig {
  const parsed = persistedConfigSchema.safeParse(input);
  if (!parsed.success) throw new RuntimeConfigValidationError(`${label} is invalid`);
  return parsed.data;
}

function parseHistory(input: unknown): BaselineHistory {
  const parsed = baselineHistorySchema.safeParse(input);
  if (!parsed.success) throw new RuntimeConfigValidationError("Baseline history is invalid");
  return parsed.data;
}

function createCurrentOnlyHistory(config: DemoConsoleConfig): BaselineHistory {
  return {
    schemaVersion,
    sections: {
      prompt: { current: { semanticRevision: "test-baseline", sha256: sha256(config.systemPrompt) }, history: [] },
      pricing: { current: { semanticRevision: "test-baseline", sha256: sha256(config.pricingRules) }, history: [] },
    },
  };
}

function assertBaselineRegistry(config: DemoConsoleConfig, history: BaselineHistory): void {
  for (const section of ["prompt", "pricing"] as const) {
    const value = section === "prompt" ? config.systemPrompt : config.pricingRules;
    if (history.sections[section].current.sha256 !== sha256(value)) {
      throw new RuntimeConfigValidationError(`Baseline history does not match the shipped ${section} baseline`);
    }
    const revisions = new Set<string>();
    for (const entry of [history.sections[section].current, ...history.sections[section].history]) {
      if (revisions.has(entry.semanticRevision)) throw new RuntimeConfigValidationError(`Baseline history repeats ${section} revision ${entry.semanticRevision}`);
      revisions.add(entry.semanticRevision);
    }
  }
}

function resolveSection<T>(section: ConfigSection, activeValue: T, baselineValue: T, history: BaselineHistory, explicitCustom: boolean): { value: T; state: RuntimeConfigSectionView } {
  const contentHash = sha256(activeValue);
  const known = [history.sections[section].current, ...history.sections[section].history].some((entry) => entry.sha256 === contentHash);
  return known && !explicitCustom
    ? { value: baselineValue, state: baselineSectionState(section, baselineValue as string | PricingRules, history) }
    : { value: activeValue, state: customSectionState(section, contentHash, history) };
}

function baselineSectionState(section: ConfigSection, baselineValue: string | PricingRules, history: BaselineHistory): RuntimeConfigSectionView {
  const current = history.sections[section].current;
  return createSectionState("baseline", current.semanticRevision, current.semanticRevision, sha256(baselineValue));
}

function customSectionState(section: ConfigSection, contentHash: string, history: BaselineHistory): RuntimeConfigSectionView {
  return createSectionState("custom", "custom", history.sections[section].current.semanticRevision, contentHash);
}

function createSectionState(mode: RuntimeConfigSectionMode, semanticRevision: string, shippedBaselineRevision: string, contentHash: string): RuntimeConfigSectionView {
  return {
    mode,
    semanticRevision,
    shippedBaselineRevision,
    sha256: contentHash,
    revision: sha256({ mode, semanticRevision, shippedBaselineRevision, sha256: contentHash }),
  };
}

function isExplicitCustom(provenance: ActiveProvenance | undefined, section: ConfigSection, value: string | PricingRules): boolean {
  const marker = provenance?.sections[section];
  const contentHash = sha256(value);
  return marker?.sha256 === contentHash || marker?.pendingSha256 === contentHash;
}

function withCustomSection(current: ResolvedConfig, config: DemoConsoleConfig, section: ConfigSection): ActiveProvenance | undefined {
  const marked = explicitCustomSections(current);
  marked.add(section);
  return createProvenance(config, marked);
}

function withoutCustomSection(current: ResolvedConfig, config: DemoConsoleConfig, section: ConfigSection): ActiveProvenance | undefined {
  const marked = explicitCustomSections(current);
  marked.delete(section);
  return createProvenance(config, marked);
}

function explicitCustomSections(current: ResolvedConfig): Set<ConfigSection> {
  const marked = new Set<ConfigSection>();
  for (const section of ["prompt", "pricing"] as const) {
    const value = section === "prompt" ? current.config.systemPrompt : current.config.pricingRules;
    if (isExplicitCustom(current.provenance, section, value)) marked.add(section);
  }
  return marked;
}

function createProvenance(config: DemoConsoleConfig, sections: Iterable<ConfigSection>): ActiveProvenance | undefined {
  const marked = new Set(sections);
  if (marked.size === 0) return undefined;
  return {
    schemaVersion,
    sections: {
      ...(marked.has("prompt") ? { prompt: { sha256: sha256(config.systemPrompt) } } : {}),
      ...(marked.has("pricing") ? { pricing: { sha256: sha256(config.pricingRules) } } : {}),
    },
  };
}

function transitionProvenance(previous: ActiveProvenance | undefined, target: ActiveProvenance | undefined): ActiveProvenance | undefined {
  if (!target) return undefined;
  const sections: ActiveProvenance["sections"] = {};
  for (const section of ["prompt", "pricing"] as const) {
    const previousHash = previous?.sections[section]?.sha256 ?? previous?.sections[section]?.pendingSha256;
    const targetHash = target.sections[section]?.sha256;
    if (targetHash === undefined) continue;
    sections[section] = previousHash !== undefined && previousHash !== targetHash
      ? { sha256: previousHash, pendingSha256: targetHash }
      : { sha256: targetHash };
  }
  return { schemaVersion, sections };
}

function toView(resolved: ResolvedConfig, savedAt?: string): DemoConsoleConfigView {
  return {
    source: resolved.source,
    systemPrompt: resolved.config.systemPrompt,
    pricingRules: resolved.config.pricingRules,
    pricingRulesText: JSON.stringify(resolved.config.pricingRules, null, 2),
    revision: currentRevision(resolved.sections),
    sections: resolved.sections,
    savedAt,
  };
}

function currentRevision(sections: DemoConsoleConfigView["sections"]): string {
  return sha256({ prompt: sections.prompt.revision, pricing: sections.pricing.revision });
}

function sha256(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
