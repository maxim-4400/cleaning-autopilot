import { Agent, MaxTurnsExceededError, OpenAIProvider, retryPolicies, Runner, tool } from "@openai/agents";
import OpenAI from "openai";
import { z } from "zod";

import type { AgentToolName, AgentToolResult, AgentTurn, ClientData } from "@/lib/contracts/domain";
import { isRussianLanguage, isSerbianCyrillic, isSerbianLanguage, type ReplyLanguage } from "@/lib/telegram/language";

export type AgentToolExecutor = (name: AgentToolName, argumentsJson: unknown) => Promise<Record<string, unknown>>;

export type AgentTurnInput = {
  conversationId: string;
  systemPrompt: string;
  message: string;
  replyLanguage: ReplyLanguage;
  knownClientData: ClientData;
  executeTool: AgentToolExecutor;
};

export interface AgentGateway {
  createConversation(leadId: string): Promise<{ id: string }>;
  runTurn(input: AgentTurnInput): Promise<AgentTurn>;
}

const updateClientDataParameters = z.object({
  patch: z.object({
    cleaningType: z.enum(["standard", "deep"]).nullable(),
    areaM2: z.number().positive().nullable(),
    rooms: z.number().int().positive().nullable(),
    bathrooms: z.number().int().positive().nullable(),
    heavyPetHair: z.boolean().nullable(),
    extras: z.array(z.enum(["windows", "oven_inside", "fridge_inside", "balcony_or_terrace"])).nullable(),
    addressOrDistrict: z.string().nullable(),
    preferredDate: z.string().nullable(),
  }).strict(),
}).strict();

const humanNeededParameters = z.object({
  reason: z.enum([
    "after_renovation",
    "commercial_property",
    "unusually_heavy_soiling",
    "unsupported_service",
    "scope_uncertain",
    "missing_required_data",
  ]),
}).strict();

const calculateQuoteParameters = z.object({}).strict();
const requestAvailableSlotsParameters = z.object({}).strict();

const maxToolSteps = 4;

export class OpenAiAgentsGateway implements AgentGateway {
  private readonly runner: Runner;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly reasoningEffort: "low" = "low",
  ) {
    this.runner = new Runner({
      modelProvider: new OpenAIProvider({
        openAIClient: new OpenAI({ apiKey, maxRetries: 0 }),
        useResponses: true,
      }),
      tracingDisabled: true,
      traceIncludeSensitiveData: false,
    });
  }

  async createConversation(leadId: string): Promise<{ id: string }> {
    const payload = await this.request("https://api.openai.com/v1/conversations", {
      method: "POST",
      body: JSON.stringify({ metadata: { lead_id: leadId } }),
    });

    if (!isObjectWithString(payload, "id")) throw new Error("OpenAI conversation response did not contain an id");
    return { id: payload.id };
  }

  async runTurn(input: AgentTurnInput): Promise<AgentTurn> {
    const languageInstruction = replyLanguageInstruction(input.replyLanguage);
    const toolResults: AgentToolResult[] = [];
    let modelToolSteps = 0;
    let toolLimitEscalated = false;
    let humanNeededRequested = false;
    const execute = async (name: AgentToolName, argumentsJson: unknown): Promise<Record<string, unknown>> => {
      if (modelToolSteps >= maxToolSteps) {
        return { ok: false, error: "tool_step_limit_reached" };
      }
      modelToolSteps += 1;
      try {
        const output = await input.executeTool(name, argumentsJson);
        toolResults.push({ name, output });
        if (name === "mark_human_needed") humanNeededRequested = true;
        return this.finishToolLimitEscalation(input, toolResults, modelToolSteps, humanNeededRequested, output, () => {
          toolLimitEscalated = true;
        });
      } catch {
        const output = { ok: false, error: "invalid_tool_arguments" };
        toolResults.push({ name, output });
        return this.finishToolLimitEscalation(input, toolResults, modelToolSteps, humanNeededRequested, output, () => {
          toolLimitEscalated = true;
        });
      }
    };
    const toolsEnabled = () => modelToolSteps < maxToolSteps;
    const agent = new Agent({
      name: "Sherlock Cleaning Agent",
      model: this.model,
      instructions: `${input.systemPrompt}\n\n${languageInstruction}\n\nThe backend derives urgency deterministically from the requested cleaning date in Europe/Belgrade. Do not ask the customer to choose standard versus same-day urgency, and do not send an urgency field in update_client_data.\n\nIf a tool result has error \"tool_step_limit_reached\", do not provide a quote or take further action. Briefly tell the customer that a human will continue the request.`,
      tools: [
        tool({
          name: "update_client_data",
          description: "Save only validated cleaning details extracted from the customer's messages.",
          parameters: updateClientDataParameters,
          strict: true,
          isEnabled: toolsEnabled,
          execute: (argumentsJson) => execute("update_client_data", argumentsJson),
        }),
        tool({
          name: "mark_human_needed",
          description: "Stop automatic quoting and preserve a concrete reason for human review.",
          parameters: humanNeededParameters,
          strict: true,
          isEnabled: toolsEnabled,
          execute: (argumentsJson) => execute("mark_human_needed", argumentsJson),
        }),
        tool({
          name: "calculate_quote",
          description: "Request the deterministic backend price after all required data is known.",
          parameters: calculateQuoteParameters,
          strict: true,
          isEnabled: toolsEnabled,
          execute: (argumentsJson) => execute("calculate_quote", argumentsJson),
        }),
        tool({
          name: "request_available_slots",
          description: "Request up to three real, server-generated available time options after an active quote. The backend presents choices securely; never invent times or identifiers.",
          parameters: requestAvailableSlotsParameters,
          strict: true,
          isEnabled: toolsEnabled,
          execute: (argumentsJson) => execute("request_available_slots", argumentsJson),
        }),
      ],
      modelSettings: {
        toolChoice: "auto",
        parallelToolCalls: false,
        reasoning: { effort: this.reasoningEffort },
        maxTokens: 1200,
        retry: {
          maxRetries: 1,
          policy: retryPolicies.all(
            retryPolicies.providerSuggested(),
            ({ normalized }) => normalized.statusCode === 429 || (normalized.statusCode !== undefined && normalized.statusCode >= 500),
          ),
        },
      },
    });

    try {
      const result = await this.runner.run(
        agent,
        `Known validated data: ${JSON.stringify(input.knownClientData)}\nCustomer message: ${input.message}`,
        {
          conversationId: input.conversationId,
          maxTurns: maxToolSteps + 1,
          toolExecution: { maxFunctionToolConcurrency: 1 },
        },
      );
      if (toolLimitEscalated) return { reply: fallbackReply(input.replyLanguage), toolResults, steps: modelToolSteps };
      return {
        reply: typeof result.finalOutput === "string" && result.finalOutput.trim().length > 0
          ? result.finalOutput
          : fallbackReply(input.replyLanguage),
        toolResults,
        steps: modelToolSteps,
      };
    } catch (error) {
      if (error instanceof MaxTurnsExceededError) {
        return this.failClosedForToolLimit(input, toolResults);
      }
      throw error;
    }
  }

  private async finishToolLimitEscalation(
    input: AgentTurnInput,
    toolResults: AgentToolResult[],
    modelToolSteps: number,
    humanNeededRequested: boolean,
    output: Record<string, unknown>,
    markEscalated: () => void,
  ): Promise<Record<string, unknown>> {
    if (modelToolSteps !== maxToolSteps || humanNeededRequested) return output;

    const escalation = await input.executeTool("mark_human_needed", { reason: "scope_uncertain" });
    toolResults.push({ name: "mark_human_needed", output: escalation });
    markEscalated();
    return {
      ok: false,
      error: "tool_step_limit_reached",
      instruction: "Automatic handling has stopped and a human review is active. Do not provide a quote or take further action.",
    };
  }

  private async failClosedForToolLimit(input: AgentTurnInput, toolResults: AgentToolResult[]): Promise<AgentTurn> {
    const output = await input.executeTool("mark_human_needed", { reason: "scope_uncertain" });
    toolResults.push({ name: "mark_human_needed", output });
    return { reply: fallbackReply(input.replyLanguage), toolResults, steps: maxToolSteps };
  }

  private async request(url: string, init: RequestInit): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(url, {
        ...init,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          ...init.headers,
        },
      });

      const payload: unknown = await response.json().catch(() => null);
      if (response.ok) return payload;
      if (attempt === 0 && (response.status === 429 || response.status >= 500)) continue;
      throw new Error(`OpenAI request failed with HTTP ${response.status}`);
    }

    throw new Error("OpenAI request exhausted retries");
  }
}

function isObjectWithString<K extends string>(value: unknown, key: K): value is Record<K, string> {
  return typeof value === "object" && value !== null && key in value &&
    typeof (value as Record<string, unknown>)[key] === "string";
}

export class FakeAgentGateway implements AgentGateway {
  private sequence = 0;

  async createConversation(leadId: string): Promise<{ id: string }> {
    void leadId;
    this.sequence += 1;
    return { id: `fake-conversation-${this.sequence}` };
  }

  async runTurn(input: AgentTurnInput): Promise<AgentTurn> {
    const patch = inferClientDataPatch(input.message);
    const toolResults: AgentToolResult[] = [];

    const updateOutput = await input.executeTool("update_client_data", { patch });
    toolResults.push({ name: "update_client_data", output: updateOutput });

    if (containsOutOfScopeSignal(input.message)) {
      const escalationOutput = await input.executeTool("mark_human_needed", { reason: inferOutOfScopeReason(input.message) });
      toolResults.push({ name: "mark_human_needed", output: escalationOutput });
      return {
        reply: replyForLanguage(input.replyLanguage, "human_needed"),
        toolResults,
        steps: 1,
      };
    }

    if (/\b(slots?|availability|available time|schedule)\b/i.test(input.message)) {
      const output = await input.executeTool("request_available_slots", {});
      toolResults.push({ name: "request_available_slots", output });
      return {
        reply: output.ok === true
          ? replyForLanguage(input.replyLanguage, "slots")
          : replyForLanguage(input.replyLanguage, "human_needed"),
        toolResults,
        steps: 1,
      };
    }

    const quoteOutput = await input.executeTool("calculate_quote", {});
    toolResults.push({ name: "calculate_quote", output: quoteOutput });

    if (quoteOutput.kind === "quote" && isObjectWithNumber(quoteOutput.quote, "amountRsd")) {
      return {
        reply: replyForLanguage(input.replyLanguage, "quote", quoteOutput.quote.amountRsd),
        toolResults,
        steps: 2,
      };
    }

    if (quoteOutput.kind === "human_needed") {
      return { reply: replyForLanguage(input.replyLanguage, "human_needed"), toolResults, steps: 2 };
    }

    return {
      reply: replyForLanguage(
        input.replyLanguage,
        "missing",
        undefined,
        stringArray(quoteOutput.missing_fields),
      ),
      toolResults,
      steps: 2,
    };
  }
}

function inferClientDataPatch(message: string): Record<string, unknown> {
  const lower = message.toLowerCase();
  const patch: Record<string, unknown> = {};
  const area = lower.match(/(\d+(?:[.,]\d+)?)\s*(?:m²|m2|sqm)/i);
  const rooms = lower.match(/(\d+)\s*(?:rooms?|комнат)/i);
  const bathrooms = lower.match(/(\d+)\s*(?:bathrooms?|сануз)/i);
  const date = lower.match(/\b\d{4}-\d{2}-\d{2}\b/);
  const district = lower.match(/(?:district|address)\s*[:=-]\s*([^,.;]+)/i);

  if (lower.includes("deep cleaning") || lower.includes("генераль")) patch.cleaningType = "deep";
  if (lower.includes("standard cleaning") || lower.includes("standard") || lower.includes("обычн")) {
    patch.cleaningType = "standard";
  }
  if (area) patch.areaM2 = Number(area[1].replace(",", "."));
  if (rooms) patch.rooms = Number(rooms[1]);
  if (bathrooms) patch.bathrooms = Number(bathrooms[1]);
  if (date) {
    patch.preferredDate = date[0];
  }
  if (district) patch.addressOrDistrict = district[1].trim();

  if (/heavy pet hair|сильн.*шерст/.test(lower)) patch.heavyPetHair = true;
  if (/no pet hair|без шерст/.test(lower)) patch.heavyPetHair = false;
  const mentionedExtras = [
    lower.includes("windows") ? "windows" : null,
    lower.includes("oven") ? "oven_inside" : null,
    lower.includes("fridge") ? "fridge_inside" : null,
    lower.includes("balcony") || lower.includes("terrace") ? "balcony_or_terrace" : null,
  ].filter((extra): extra is string => extra !== null);
  if (mentionedExtras.length > 0) patch.extras = mentionedExtras;
  if (/no extras|без дополн/.test(lower)) patch.extras = [];

  return patch;
}

function containsOutOfScopeSignal(message: string): boolean {
  return /after renovation|construction cleaning|commercial|office|unusually dirty|сезон.*ремонт|после ремонта|коммерчес/.test(
    message.toLowerCase(),
  );
}

function inferOutOfScopeReason(message: string): string {
  const lower = message.toLowerCase();
  if (/renovation|construction|ремонт/.test(lower)) return "after_renovation";
  if (/commercial|office|коммерчес/.test(lower)) return "commercial_property";
  if (/unusually dirty/.test(lower)) return "unusually_heavy_soiling";
  return "scope_uncertain";
}

function replyForLanguage(
  language: ReplyLanguage,
  kind: "quote" | "missing" | "human_needed" | "slots" | "reserved",
  amount?: number,
  missingFields: string[] = [],
): string {
  const russian = isRussianLanguage(language);
  const serbian = isSerbianLanguage(language);
  if (russian) {
    if (kind === "quote") return `Уборка будет стоить ${amount} RSD. Если вам подходит, я подберу время.`;
    if (kind === "human_needed") return "Спасибо, я передам детали нашей команде, чтобы всё проверить внимательно.";
    if (kind === "slots") return "Сейчас покажу ближайшее свободное время.";
    if (kind === "reserved") return "Время зарезервировано.";
    return missingDetailsReply("ru", missingFields);
  }
  if (serbian) {
    if (kind === "quote") return serbianText(language, `Vaša procena za čišćenje je ${amount} RSD. Ako vam odgovara, mogu da pronađem odgovarajući termin.`, `Ваша процена за чишћење је ${amount} RSD. Ако вам одговара, могу да пронађем одговарајући термин.`);
    if (kind === "human_needed") return serbianText(language, "Hvala. Naš tim će pažljivo pregledati ovaj zahtev i nastaviti sa detaljima koje ste podelili.", "Хвала. Наш тим ће пажљиво прегледати овај захтев и наставити са детаљима које сте поделили.");
    if (kind === "slots") return serbianText(language, "Sada ću prikazati najbliže slobodne termine.", "Сада ћу приказати најближе слободне термине.");
    if (kind === "reserved") return serbianText(language, "Vaš termin je rezervisan.", "Ваш термин је резервисан.");
    return missingDetailsReply(language, missingFields);
  }
  if (kind === "quote") return `Your cleaning estimate is ${amount} RSD. If it works for you, I can look for a suitable time.`;
  if (kind === "human_needed") return "Thank you. Our team will take a careful look at this request and continue with the details you shared.";
  if (kind === "slots") return "I’ll show the nearest available times now.";
  if (kind === "reserved") return "Your time is reserved.";
  return missingDetailsReply("en", missingFields);
}

function missingDetailsReply(language: ReplyLanguage, missingFields: string[]): string {
  const missing = new Set(missingFields);
  const has = (field: string) => missing.has(field);
  if (isSerbianLanguage(language)) {
    if (has("cleaningType") || has("areaM2")) return serbianText(language, "Da li vam je potrebno standardno ili detaljno čišćenje, i kolika je približno površina stana?", "Да ли вам је потребно стандардно или детаљно чишћење, и колика је приближно површина стана?");
    if (has("rooms") && has("bathrooms")) return serbianText(language, "Koliko soba i kupatila ima stan?", "Колико соба и купатила има стан?");
    if (has("rooms")) return serbianText(language, "Koliko soba ima stan?", "Колико соба има стан?");
    if (has("bathrooms")) return serbianText(language, "Koliko kupatila ima stan?", "Колико купатила има стан?");
    if (has("addressOrDistrict") && has("preferredDate")) return serbianText(language, "U kom delu grada je stan i koji datum bi vam odgovarao za čišćenje?", "У ком делу града је стан и који датум би вам одговарао за чишћење?");
    if (has("addressOrDistrict")) return serbianText(language, "U kom delu grada se nalazi stan?", "У ком делу града се налази стан?");
    if (has("preferredDate") || has("urgency")) return serbianText(language, "Koji datum bi vam odgovarao za čišćenje?", "Који датум би вам одговарао за чишћење?");
    if (has("heavyPetHair") && has("extras")) return serbianText(language, "Da li treba da uzmemo u obzir mnogo dlaka kućnih ljubimaca ili dodatne usluge?", "Да ли треба да узмемо у обзир много длака кућних љубимаца или додатне услуге?");
    if (has("heavyPetHair")) return serbianText(language, "Da li treba da uzmemo u obzir mnogo dlaka kućnih ljubimaca?", "Да ли треба да узмемо у обзир много длака кућних љубимаца?");
    if (has("extras")) return serbianText(language, "Da li su vam potrebne dodatne usluge, kao što su prozori, rerna, frižider ili terasa?", "Да ли су вам потребне додатне услуге, као што су прозори, рерна, фрижидер или тераса?");
    return serbianText(language, "Recite nam još jedan ili dva detalja o čišćenju.", "Реците нам још један или два детаља о чишћењу.");
  }
  if (has("cleaningType") || has("areaM2")) {
    return isRussianLanguage(language)
      ? "Подскажите, пожалуйста, какой тип уборки нужен и примерно какая площадь квартиры?"
      : "Could you tell me whether you need a standard or deep cleaning, and roughly how many square metres it is?";
  }
  if (has("rooms") && has("bathrooms")) {
    return isRussianLanguage(language)
      ? "Сколько в квартире комнат и санузлов?"
      : "How many rooms and bathrooms are there?";
  }
  if (has("rooms")) return isRussianLanguage(language) ? "Сколько в квартире комнат?" : "How many rooms are there?";
  if (has("bathrooms")) return isRussianLanguage(language) ? "Сколько в квартире санузлов?" : "How many bathrooms are there?";
  if (has("addressOrDistrict") && has("preferredDate")) {
    return isRussianLanguage(language)
      ? "В каком районе находится квартира и на какую дату вам удобно запланировать уборку?"
      : "Which district is it in, and what date would suit you for the cleaning?";
  }
  if (has("addressOrDistrict")) return isRussianLanguage(language) ? "В каком районе находится квартира?" : "Which district is it in?";
  if (has("preferredDate") || has("urgency")) {
    return isRussianLanguage(language) ? "На какую дату вам удобно запланировать уборку?" : "What date would suit you for the cleaning?";
  }
  if (has("heavyPetHair") && has("extras")) {
    return isRussianLanguage(language)
      ? "Нужно ли учесть сильную шерсть животных или дополнительные услуги, например окна, духовку, холодильник или балкон?"
      : "Should we account for heavy pet hair or any extras, such as windows, oven, fridge or a balcony?";
  }
  if (has("heavyPetHair")) return isRussianLanguage(language) ? "Нужно ли учесть сильную шерсть животных?" : "Should we account for heavy pet hair?";
  if (has("extras")) return isRussianLanguage(language) ? "Нужны ли дополнительные услуги, например окна, духовка, холодильник или балкон?" : "Would you like any extras, such as windows, oven, fridge or a balcony?";
  return isRussianLanguage(language)
    ? "Подскажите, пожалуйста, ещё немного деталей об уборке."
    : "Could you share one or two more details about the cleaning?";
}

function fallbackReply(language: string): string {
  if (isSerbianLanguage(language)) return serbianText(language, "Hvala. Naš tim će pažljivo nastaviti sa detaljima koje ste podelili.", "Хвала. Наш тим ће пажљиво наставити са детаљима које сте поделили.");
  return isRussianLanguage(language)
    ? "Спасибо, я передам детали нашей команде, чтобы ничего не упустить."
    : "Thank you. Our team will continue this carefully with the details you shared.";
}

function replyLanguageInstruction(language: ReplyLanguage): string {
  return replyLanguageInstructions[language];
}

const replyLanguageInstructions: Record<ReplyLanguage, string> = {
  en: "Reply only in English for this customer turn. Sound like a helpful local coordinator: use one or two short natural sentences, no em or en dashes, no headings, labels, raw Markdown, technical terms, or generic AI filler.",
  ru: "Reply only in Russian for this customer turn. Sound like a helpful local coordinator: use one or two short natural sentences, no em or en dashes, no headings, labels, raw Markdown, technical terms, or generic AI filler.",
  "sr-Latn": "Reply only in Serbian using the Latin script for this customer turn. Sound like a helpful local coordinator: use one or two short natural sentences, no em or en dashes, no headings, labels, raw Markdown, technical terms, or generic AI filler.",
  "sr-Cyrl": "Reply only in Serbian using the Cyrillic script for this customer turn. Sound like a helpful local coordinator: use one or two short natural sentences, no em or en dashes, no headings, labels, raw Markdown, technical terms, or generic AI filler.",
};

function serbianText(language: string, latin: string, cyrillic: string): string {
  return isSerbianCyrillic(language) ? cyrillic : latin;
}

function isObjectWithNumber<K extends string>(value: unknown, key: K): value is Record<K, number> {
  return typeof value === "object" && value !== null && key in value &&
    typeof (value as Record<string, unknown>)[key] === "number";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}
