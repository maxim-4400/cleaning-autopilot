import type { AvailabilitySlot } from "@/lib/contracts/domain";
import type { TelegramAnyReplyMarkup, TelegramInlineKeyboardMarkup } from "@/lib/telegram/gateway";
import { isRussianLanguage, isSerbianCyrillic, isSerbianLanguage, type ReplyLocale } from "@/lib/telegram/language";

export type TelegramRenderedReply = { text: string; replyMarkup?: TelegramAnyReplyMarkup };

const telegramTextLimit = 4096;

export function renderAgentReply(reply: string, language: string): TelegramRenderedReply {
  const safeText = truncateTelegramText(stripRawMarkdown(stripUnsafeArtifacts(reply)));
  return { text: escapePlainText(safeText && isAgentReplyLocaleCompatible(safeText, language) ? safeText : fallbackAgentReply(language)) };
}

export function renderQuoteReply(language: string, amountRsd: number): TelegramRenderedReply {
  const amount = `${new Intl.NumberFormat("en-US").format(amountRsd)} RSD`;
  if (isSerbianLanguage(language)) {
    return { text: serbianText(language,
      `<b>Čišćenje bi koštalo ${amount}</b>\n\nAko vam odgovara, mogu da pokažem najbliže slobodne termine.`,
      `<b>Чишћење би коштало ${amount}</b>\n\nАко вам одговара, могу да покажем најближе слободне термине.`,
    ) };
  }
  return isRussianLanguage(language)
    ? { text: `<b>Уборка будет стоить ${amount}</b>\n\nЕсли всё подходит, я покажу ближайшее свободное время.` }
    : { text: `<b>Your cleaning would cost ${amount}</b>\n\nIf that works for you, I can show the nearest available times.` };
}

export function renderSlotOfferReply(language: string, slots: AvailabilitySlot[]): TelegramRenderedReply {
  const header = isSerbianLanguage(language)
    ? serbianText(language, "<b>Najbliži slobodni termini</b>\nIzaberite dugme ispod ili odgovorite brojem opcije:", "<b>Најближи слободни термини</b>\nИзаберите дугме испод или одговорите бројем опције:")
    : isRussianLanguage(language)
    ? "<b>Ближайшее свободное время</b>\nВыберите кнопку ниже или ответьте номером варианта."
    : "<b>Nearest available times</b>\nChoose a button below, or reply with an option number.";
  const options = slots.map((slot) => `${slot.displayOrder}. ${escapePlainText(slot.label)}`).join("\n");
  return { text: `${header}\n\n${options}`, replyMarkup: slotKeyboard(slots, replyLocaleForKeyboard(language)) };
}

export function renderReservationPendingReply(language: string): TelegramRenderedReply {
  if (isSerbianLanguage(language)) return { text: serbianText(language,
    "<b>Vaš termin je rezervisan.</b>\n\nPripremićemo konačnu potvrdu koristeći već dogovorene detalje.",
    "<b>Ваш термин је резервисан.</b>\n\nПрипремићемо коначну потврду користећи већ договорене детаље.",
  ) };
  return isRussianLanguage(language)
    ? { text: "<b>Время зарезервировано.</b>\n\nМы подготовим финальное подтверждение и продолжим с уже согласованными деталями." }
    : { text: "<b>Your time is reserved.</b>\n\nWe’ll prepare the final confirmation using the details already agreed." };
}

// Kept for callers compiled against the Stage 3 renderer. Stage 4 booking
// code uses the explicit pending/confirmed renderers and separate delivery keys.
export function renderReservationReply(language: string): TelegramRenderedReply {
  return renderReservationPendingReply(language);
}

export function renderBookingConfirmedReply(input: {
  language: string;
  team: "team_a" | "team_b";
  start: string;
  quoteAmountRsd: number;
}): TelegramRenderedReply {
  const language = input.language;
  const details = bookingDetails(input);
  if (isSerbianLanguage(language)) return { text: serbianText(language,
    `<b>Vaše čišćenje je potvrđeno.</b>\n\n${details}\n\nNaš tim ima sve potrebne detalje i videćemo se u dogovorenom terminu.`,
    `<b>Ваше чишћење је потврђено.</b>\n\n${details}\n\nНаш тим има све потребне детаље и видимо се у договореном термину.`,
  ) };
  return isRussianLanguage(language)
    ? { text: `<b>Ваша уборка подтверждена.</b>\n\n${details}\n\nУ нашей команды есть все детали. Увидимся в согласованное время.` }
    : { text: `<b>Your cleaning is confirmed.</b>\n\n${details}\n\nOur team has all the details, and we’ll see you at the agreed time.` };
}

export function renderBookingManualReviewReply(language: string): TelegramRenderedReply {
  if (isSerbianLanguage(language)) return { text: serbianText(language,
    "Vaš zahtev je kod našeg tima na ručnoj proveri. Nećemo praviti dalja automatska ažuriranja.",
    "Ваш захтев је код нашег тима на ручној провери. Нећемо правити даља аутоматска ажурирања.",
  ) };
  return isRussianLanguage(language)
    ? { text: "Ваша заявка передана команде на ручную проверку. Дальше мы не будем вносить автоматические изменения." }
    : { text: "Your request is with our team for manual review. We will not make further automatic changes." };
}

export function renderCalendarReservationFailedReply(language: string): TelegramRenderedReply {
  if (isSerbianLanguage(language)) return { text: serbianText(language,
    "Nismo mogli bezbedno da potvrdimo taj termin. Naš tim će nastaviti zahtev sa već podeljenim detaljima.",
    "Нисмо могли безбедно да потврдимо тај термин. Наш тим ће наставити захтев са већ подељеним детаљима.",
  ) };
  return isRussianLanguage(language)
    ? { text: "Этот вариант уже нельзя безопасно подтвердить. Мы продолжим заявку вручную и сохраним все детали." }
    : { text: "We could not safely confirm that time. Our team will continue the request with the details already shared." };
}

export function renderHumanNeededReply(language: string): TelegramRenderedReply {
  if (isSerbianLanguage(language)) return { text: serbianText(language,
    "Hvala. Proslediću detalje našem timu da sve pažljivo pregleda.",
    "Хвала. Проследићу детаље нашем тиму да све пажљиво прегледа.",
  ) };
  return isRussianLanguage(language)
    ? { text: "Спасибо, я сохраню детали и передам заявку нашей команде, чтобы всё проверить внимательно." }
    : { text: "Thank you — I’ll pass the details to our team so they can review everything carefully." };
}

export function renderStaleSlotReply(language: string): TelegramRenderedReply {
  if (isSerbianLanguage(language)) return { text: serbianText(language,
    "Ta opcija više nije dostupna. Pošaljite poruku i proveriću nove termine.",
    "Та опција више није доступна. Пошаљите поруку и проверићу нове термине.",
  ) };
  return isRussianLanguage(language)
    ? { text: "Этот вариант больше недоступен. Напишите, и я проверю новое свободное время." }
    : { text: "That option is no longer available. Send me a message and I’ll check fresh times." };
}

export function renderNoAvailabilityReply(language: string): TelegramRenderedReply {
  if (isSerbianLanguage(language)) return { text: serbianText(language,
    "U naredne dve nedelje nema odgovarajućeg slobodnog termina. Naš tim će pomoći da pronađe alternativu.",
    "У наредне две недеље нема одговарајућег слободног термина. Наш тим ће помоћи да пронађе алтернативу.",
  ) };
  return isRussianLanguage(language)
    ? { text: "В ближайшие две недели подходящего свободного времени пока нет. Наша команда поможет найти другой вариант." }
    : { text: "There isn’t a suitable free time in the next two weeks. Our team will help find an alternative." };
}

export function renderNewAddressDivider(language: string): TelegramRenderedReply {
  return { text: isRussianLanguage(language) ? "Новый адрес уборки" : "New cleaning location" };
}

function slotKeyboard(slots: AvailabilitySlot[], language: ReplyLocale): TelegramInlineKeyboardMarkup {
  return { inline_keyboard: slots.map((slot) => [{ text: slot.label, callback_data: `slot:${language}:${slot.token}` }]) };
}

function replyLocaleForKeyboard(language: string): ReplyLocale {
  if (isRussianLanguage(language)) return "ru";
  if (isSerbianCyrillic(language)) return "sr-Cyrl";
  if (isSerbianLanguage(language)) return "sr-Latn";
  return "en";
}

function stripRawMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^\n)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^\n)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\\([_*\[\]()~`>#+\-=|{}.!])/g, "$1")
    .replace(/[\*_`]/g, "");
}

function stripUnsafeArtifacts(value: string): string {
  return value
    .replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi, "")
    .replace(/\b(?:update_client_data|calculate_quote|mark_human_needed|request_available_slots|reserve_slot)\b/gi, "")
    .replace(/\b(?:slot\s+token|token|event\s+id|qualified|human\s+needed|team\s+sync)\b/gi, "")
    .replace(/\{[^{}\n]*\}/g, "")
    .replace(/[^\S\r\n]{2,}/g, " ")
    .trim();
}

function truncateTelegramText(value: string): string {
  const characters = Array.from(value);
  return characters.length <= telegramTextLimit
    ? value
    : `${characters.slice(0, telegramTextLimit - 1).join("")}…`;
}

function fallbackAgentReply(language: string): string {
  if (isSerbianLanguage(language)) return serbianText(language,
    "Hvala. Zabeležio sam to. Možete li podeliti još malo detalja?",
    "Хвала. Забележио сам то. Можете ли поделити још мало детаља?",
  );
  return isRussianLanguage(language)
    ? "Спасибо, я всё отметил. Подскажите, пожалуйста, немного подробнее?"
    : "Thanks. I’ve noted that. Could you share a little more detail?";
}

function isAgentReplyLocaleCompatible(reply: string, language: string): boolean {
  const cyrillicLetters = (reply.match(/[\u0400-\u052f]/g) ?? []).length;
  const latinLetters = (reply.match(/[A-Za-zČĆŠŽĐčćšžđ]/g) ?? []).length;
  if (language === "en" || language === "sr-Latn") return cyrillicLetters === 0;
  if (language === "ru" || language === "sr-Cyrl") return !(latinLetters > 0 && cyrillicLetters === 0);
  return true;
}

function serbianText(language: string, latin: string, cyrillic: string): string {
  return isSerbianCyrillic(language) ? cyrillic : latin;
}

function bookingDetails(input: { language: string; team: "team_a" | "team_b"; start: string; quoteAmountRsd: number }): string {
  const locale = isRussianLanguage(input.language)
    ? "ru-RU"
    : isSerbianCyrillic(input.language)
    ? "sr-Cyrl-RS"
    : isSerbianLanguage(input.language)
    ? "sr-Latn-RS"
    : "en-GB";
  const team = isRussianLanguage(input.language)
    ? `Команда ${input.team === "team_a" ? "А" : "Б"}`
    : isSerbianCyrillic(input.language)
    ? `Тим ${input.team === "team_a" ? "А" : "Б"}`
    : isSerbianLanguage(input.language)
    ? `Tim ${input.team === "team_a" ? "A" : "B"}`
    : `Team ${input.team === "team_a" ? "A" : "B"}`;
  const when = new Intl.DateTimeFormat(locale, {
    timeZone: "Europe/Belgrade", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(input.start));
  const quote = `${new Intl.NumberFormat(locale).format(input.quoteAmountRsd)} RSD`;
  if (isRussianLanguage(input.language)) return `${team} приедет ${when}. Стоимость ${quote}.`;
  if (isSerbianCyrillic(input.language)) return `${team} долази ${when}. Цена је ${quote}.`;
  if (isSerbianLanguage(input.language)) return `${team} dolazi ${when}. Cena je ${quote}.`;
  return `${team} will arrive ${when}. The price is ${quote}.`;
}

function escapePlainText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
