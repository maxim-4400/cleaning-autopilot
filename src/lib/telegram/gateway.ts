export type TelegramSendResult = { messageId: string };
export type TelegramTransportProvenance = "agent" | "template";

export type TelegramReplyMarkup = { keyboard: Array<Array<{ text: string }>>; resize_keyboard: true; is_persistent: true };
export type TelegramInlineKeyboardMarkup = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
export type TelegramAnyReplyMarkup = TelegramReplyMarkup | TelegramInlineKeyboardMarkup;

export interface TelegramGateway {
  sendMessage(input: { chatId: number; text: string; replyMarkup?: TelegramAnyReplyMarkup; provenance?: TelegramTransportProvenance }): Promise<TelegramSendResult>;
  sendTyping(chatId: number): Promise<void>;
  answerCallbackQuery(callbackQueryId: string): Promise<void>;
}

export class TelegramDeliveryError extends Error {
  constructor(readonly outcome: "failed" | "ambiguous", message: string) {
    super(message);
    this.name = "TelegramDeliveryError";
  }
}

export class TelegramApiGateway implements TelegramGateway {
  constructor(private readonly botToken: string) {}

  async sendMessage(input: { chatId: number; text: string; replyMarkup?: TelegramAnyReplyMarkup; provenance?: TelegramTransportProvenance }): Promise<TelegramSendResult> {
    let response: Response;
    try {
      response = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: input.chatId, text: input.text, parse_mode: "HTML", reply_markup: input.replyMarkup }),
      });
    } catch {
      throw new TelegramDeliveryError("ambiguous", "Telegram send outcome is unknown");
    }

    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new TelegramDeliveryError("failed", `Telegram send failed with HTTP ${response.status}`);
    }
    if (!isTelegramSuccess(payload)) {
      throw new TelegramDeliveryError("ambiguous", "Telegram returned an invalid success payload");
    }

    return { messageId: String(payload.result.message_id) };
  }

  async sendTyping(chatId: number): Promise<void> {
    await this.callAuxiliaryMethod("sendChatAction", { chat_id: chatId, action: "typing" });
  }

  async answerCallbackQuery(callbackQueryId: string): Promise<void> {
    await this.callAuxiliaryMethod("answerCallbackQuery", { callback_query_id: callbackQueryId });
  }

  private async callAuxiliaryMethod(method: string, body: Record<string, unknown>): Promise<void> {
    const response = await fetch(`https://api.telegram.org/bot${this.botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Telegram ${method} failed with HTTP ${response.status}`);
    const payload: unknown = await response.json().catch(() => null);
    if (!isTelegramAuxiliarySuccess(payload)) throw new Error(`Telegram ${method} returned an invalid success payload`);
  }
}

function isTelegramSuccess(payload: unknown): payload is { ok: true; result: { message_id: number } } {
  return typeof payload === "object" && payload !== null &&
    "ok" in payload && payload.ok === true &&
    "result" in payload && typeof payload.result === "object" && payload.result !== null &&
    "message_id" in payload.result && typeof payload.result.message_id === "number";
}

function isTelegramAuxiliarySuccess(payload: unknown): payload is { ok: true } {
  return typeof payload === "object" && payload !== null && "ok" in payload && payload.ok === true;
}

export class FakeTelegramGateway implements TelegramGateway {
  readonly messages: Array<{ chatId: number; text: string; parseMode: "HTML"; replyMarkup?: TelegramAnyReplyMarkup; provenance?: TelegramTransportProvenance }> = [];
  readonly typingChatIds: number[] = [];
  readonly answeredCallbackQueryIds: string[] = [];
  shouldFail = false;
  failureOutcome: "failed" | "ambiguous" = "failed";
  shouldFailTyping = false;
  shouldFailCallbackAnswer = false;

  async sendMessage(input: { chatId: number; text: string; replyMarkup?: TelegramAnyReplyMarkup; provenance?: TelegramTransportProvenance }): Promise<TelegramSendResult> {
    if (this.shouldFail) throw new TelegramDeliveryError(this.failureOutcome, "Fake Telegram delivery failure");
    this.messages.push({ ...input, parseMode: "HTML" });
    return { messageId: String(this.messages.length) };
  }

  async sendTyping(chatId: number): Promise<void> {
    if (this.shouldFailTyping) throw new Error("Fake Telegram typing failure");
    this.typingChatIds.push(chatId);
  }

  async answerCallbackQuery(callbackQueryId: string): Promise<void> {
    if (this.shouldFailCallbackAnswer) throw new Error("Fake Telegram callback answer failure");
    this.answeredCallbackQueryIds.push(callbackQueryId);
  }
}
