import type { AvailabilitySlot } from "@/lib/contracts/domain";
import type { TelegramAnyReplyMarkup, TelegramInlineKeyboardMarkup } from "@/lib/telegram/gateway";
import { isRussianLanguage, isSerbianCyrillic, isSerbianLanguage, type ReplyLocale } from "@/lib/telegram/language";

/** Provenance is a renderer contract, never inferred from customer-visible text. */
export type TelegramRenderedReply = { text: string; replyMarkup?: TelegramAnyReplyMarkup; provenance: "agent" | "template" };

const telegramTextLimit = 4096;

export function renderAgentReply(reply: string, language: string): TelegramRenderedReply {
  const safeText = truncateTelegramText(stripRawMarkdown(stripUnsafeArtifacts(reply)));
  return { text: escapePlainText(safeText && isAgentReplyLocaleCompatible(safeText, language) ? safeText : fallbackAgentReply(language)), provenance: "agent" };
}

export function renderQuoteReply(language: string, amountRsd: number, options: { sameDayAmountRsd?: number } = {}): TelegramRenderedReply {
  const amount = formatRsdAmount(language, amountRsd);
  const sameDayAmount = options.sameDayAmountRsd === undefined ? undefined : formatRsdAmount(language, options.sameDayAmountRsd);
  if (sameDayAmount) {
    if (isSerbianLanguage(language)) return { text: serbianText(language,
      `<b>Redovna cena: ${amount}</b>\n\nAko je čišćenje potrebno danas, cena je ${sameDayAmount} (+20%). Kada izaberete datum, mogu da proverim slobodno vreme.`,
      `<b>Редовна цена: ${amount}</b>\n\nАко је чишћење потребно данас, цена је ${sameDayAmount} (+20%). Када изаберете датум, могу да проверим слободно време.`,
    ), provenance: "template" };
    return isRussianLanguage(language)
      ? { text: `<b>Обычная цена уборки: ${amount}</b>\n\nЕсли уборка нужна сегодня, будет ${sameDayAmount} (+20%). Когда выберете дату, я проверю свободное время.`, provenance: "template" }
      : { text: `<b>The standard price: ${amount}</b>\n\nIf you need the cleaning today, it is ${sameDayAmount} (+20%). Once you choose a date, I can check free times.`, provenance: "template" };
  }
  if (isSerbianLanguage(language)) {
    return { text: serbianText(language,
      `<b>Cena čišćenja: ${amount}</b>\n\nAko vam odgovara, mogu da pokažem najbliže slobodne termine.`,
      `<b>Цена чишћења: ${amount}</b>\n\nАко вам одговара, могу да покажем најближе слободне термине.`,
    ), provenance: "template" };
  }
  return isRussianLanguage(language)
    ? { text: `<b>Стоимость уборки: ${amount}</b>\n\nЕсли всё подходит, я покажу ближайшее свободное время.`, provenance: "template" }
    : { text: `<b>Your cleaning would cost: ${amount}</b>\n\nIf that works for you, I can show the nearest available times.`, provenance: "template" };
}

/** The first post-quote "yes" is useful only when a date is already known. */
export function renderSchedulingConsentNeedsDateReply(language: string): TelegramRenderedReply {
  if (isSerbianLanguage(language)) return { text: serbianText(language,
    "Odlično. Koji datum i koje vreme bi vam najviše odgovarali? Na primer, 29. avgust uveče.",
    "Одлично. Који датум и које време би вам највише одговарали? На пример, 29. август увече.",
  ), provenance: "template" };
  return isRussianLanguage(language)
    ? { text: "Отлично. На какой день и какое время вам удобнее? Например, 29 августа вечером.", provenance: "template" }
    : { text: "Great. Which date and time would suit you best? For example, 29 August in the evening.", provenance: "template" };
}

export function renderSlotOfferReply(language: string, slots: AvailabilitySlot[]): TelegramRenderedReply {
  const header = isSerbianLanguage(language)
    ? serbianText(language, "<b>Najbliži slobodni termini</b>\nIzaberite dugme ispod ili odgovorite brojem opcije.", "<b>Најближи слободни термини</b>\nИзаберите дугме испод или одговорите бројем опције.")
    : isRussianLanguage(language)
    ? "<b>Ближайшее свободное время</b>\nВыберите кнопку ниже или ответьте номером варианта."
    : "<b>Nearest available times</b>\nChoose a button below, or reply with an option number.";
  const options = slots.map((slot) => `${slot.displayOrder}. ${escapePlainText(slot.label)}.`).join("\n");
  return { text: `${header}\n\n${options}`, replyMarkup: slotKeyboard(slots, replyLocaleForKeyboard(language)), provenance: "template" };
}

/** The requested range was checked first; these are real, explicitly relaxed alternatives. */
export function renderNearestSlotAlternativesReply(language: string, slots: AvailabilitySlot[], reason: "nonworking_day" | "requested_date_unavailable" | "requested_time_unavailable" = "requested_time_unavailable"): TelegramRenderedReply {
  const dateUnavailable = reason === "requested_date_unavailable";
  const nonworkingDay = reason === "nonworking_day";
  const header = isSerbianLanguage(language)
    ? serbianText(language,
      nonworkingDay ? "<b>Nedeljom ne radimo.</b>\nEvo najbližih stvarnih alternativa:" : dateUnavailable ? "<b>Na traženi datum nema slobodnog termina.</b>\nEvo najbližih stvarnih alternativa:" : "<b>U traženo vreme nema slobodnog termina.</b>\nEvo najbližih stvarnih alternativa:",
      nonworkingDay ? "<b>Недељом не радимо.</b>\nЕво најближих стварних алтернатива:" : dateUnavailable ? "<b>На тражени датум нема слободног термина.</b>\nЕво најближих стварних алтернатива:" : "<b>У тражено време нема слободног термина.</b>\nЕво најближих стварних алтернатива:",
    )
    : isRussianLanguage(language)
    ? nonworkingDay ? "<b>По воскресеньям мы не работаем.</b>\nВот ближайшие реальные варианты:" : dateUnavailable ? "<b>На выбранную дату свободных слотов нет.</b>\nВот ближайшие реальные варианты:" : "<b>В указанное время свободных слотов нет.</b>\nВот ближайшие реальные варианты:"
    : nonworkingDay ? "<b>We do not work on Sundays.</b>\nHere are the nearest real alternatives:" : dateUnavailable ? "<b>There are no free slots on that requested date.</b>\nHere are the nearest real alternatives:" : "<b>There are no free slots in that requested time.</b>\nHere are the nearest real alternatives:";
  const options = slots.map((slot) => `${slot.displayOrder}. ${escapePlainText(slot.label)}.`).join("\n");
  return { text: `${header}\n\n${options}`, replyMarkup: slotKeyboard(slots, replyLocaleForKeyboard(language)), provenance: "template" };
}

export function renderReservationPendingReply(language: string, booking?: { team: "team_a" | "team_b"; start: string; quoteAmountRsd: number }): TelegramRenderedReply {
  const details = booking ? bookingDetails({ language, ...booking }) : undefined;
  if (isSerbianLanguage(language)) return { text: serbianText(language,
    `<b>Vaš termin je potvrđen.</b>${details ? `\n\n${details}` : ""}\n\nZahtev je sačuvan i prosleđen timu.`,
    `<b>Ваш термин је потврђен.</b>${details ? `\n\n${details}` : ""}\n\nЗахтев је сачуван и прослеђен тиму.`,
  ), provenance: "template" };
  return isRussianLanguage(language)
    ? { text: `<b>Время подтверждено.</b>${details ? `\n\n${details}` : ""}\n\nЗаявка сохранена и передана команде.`, provenance: "template" }
    : { text: `<b>Your time is confirmed.</b>${details ? `\n\n${details}` : ""}\n\nYour request is saved and with our team.`, provenance: "template" };
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
  ), provenance: "template" };
  return isRussianLanguage(language)
    ? { text: `<b>Ваша уборка подтверждена.</b>\n\n${details}\n\nУ нашей команды есть все детали. Увидимся в согласованное время.`, provenance: "template" }
    : { text: `<b>Your cleaning is confirmed.</b>\n\n${details}\n\nOur team has all the details, and we’ll see you at the agreed time.`, provenance: "template" };
}

export function renderBookingManualReviewReply(language: string): TelegramRenderedReply {
  if (isSerbianLanguage(language)) return { text: serbianText(language,
    "Vaš zahtev je kod našeg tima na ručnoj proveri. Nećemo praviti dalja automatska ažuriranja.",
    "Ваш захтев је код нашег тима на ручној провери. Нећемо правити даља аутоматска ажурирања.",
  ), provenance: "template" };
  return isRussianLanguage(language)
    ? { text: "Ваша заявка передана команде на ручную проверку. Дальше мы не будем вносить автоматические изменения.", provenance: "template" }
    : { text: "Your request is with our team for manual review. We will not make further automatic changes.", provenance: "template" };
}

export function renderCalendarReservationFailedReply(language: string): TelegramRenderedReply {
  if (isSerbianLanguage(language)) return { text: serbianText(language,
    "Nismo mogli bezbedno da potvrdimo taj termin. Naš tim će nastaviti zahtev sa već podeljenim detaljima.",
    "Нисмо могли безбедно да потврдимо тај термин. Наш тим ће наставити захтев са већ подељеним детаљима.",
  ), provenance: "template" };
  return isRussianLanguage(language)
    ? { text: "Этот вариант уже нельзя безопасно подтвердить. Мы продолжим заявку вручную и сохраним все детали.", provenance: "template" }
    : { text: "We could not safely confirm that time. Our team will continue the request with the details already shared.", provenance: "template" };
}

/** Availability failed before any booking write; do not imply a reservation attempt. */
export function renderCalendarAvailabilityFailedReply(language: string): TelegramRenderedReply {
  if (isSerbianLanguage(language)) return { text: serbianText(language,
    "Trenutno nismo mogli bezbedno da proverimo slobodne termine. Sačuvali smo detalje zahteva i proverićemo ih sa timom.",
    "Тренутно нисмо могли безбедно да проверимо слободне термине. Сачували смо детаље захтева и проверићемо их са тимом.",
  ), provenance: "template" };
  return isRussianLanguage(language)
    ? { text: "Сейчас не получилось безопасно проверить свободное время. Детали заявки сохранены, мы уточним их с командой.", provenance: "template" }
    : { text: "We could not safely check free times right now. Your request details are saved, and we will check them with the team.", provenance: "template" };
}

export function renderHumanNeededReply(language: string): TelegramRenderedReply {
  if (isSerbianLanguage(language)) return { text: serbianText(language,
    "Treba da proverimo još nekoliko detalja sa timom. Sačuvaću zahtev i proslediti ga kolegi; javićemo vam se nakon provere.",
    "Треба да проверимо још неколико детаља са тимом. Сачуваћу захтев и проследити га колеги; јавићемо вам се после провере.",
  ), provenance: "template" };
  return isRussianLanguage(language)
    ? { text: "Нужно уточнить пару деталей с командой. Я всё сохраню и передам заявку специалисту, а после проверки команда свяжется с вами.", provenance: "template" }
    : { text: "We need to check a couple of details with the team. I’ll save your request and pass it to a specialist; the team will contact you after the review.", provenance: "template" };
}

/** A later detail may help the team, but it must not look like a second handoff. */
export function renderHumanNeededUpdateReply(language: string, detail?: string, persisted = false): TelegramRenderedReply {
  // Price availability is an answer, not a claim that a fact was persisted.
  // Every other detail that says "added" or "recorded" needs explicit
  // webhook proof of a validated data change.
  const informationalDetail = /(?:автоматически точную цену|automatski obračun|automatic price)/iu.test(detail ?? "");
  if (detail && (persisted || informationalDetail)) {
    if (isSerbianLanguage(language)) return { text: serbianText(language,
      `${detail}. Naš tim već vodi sledeći korak.`,
      `${detail}. Наш тим већ води следећи корак.`,
    ), provenance: "template" };
    return isRussianLanguage(language)
      ? { text: `${detail}. Команда уже ведёт следующий шаг.`, provenance: "template" }
      : { text: `${detail}. Our team is already handling the next step.`, provenance: "template" };
  }
  if (detail && !persisted) return renderUnpersistedHumanNeededDetailReply(language, detail);
  if (isSerbianLanguage(language)) return { text: serbianText(language,
    "Naš tim već prati sledeći korak i proveriće ovaj detalj.",
    "Наш тим већ прати следећи корак и провериће овај детаљ.",
  ), provenance: "template" };
  return isRussianLanguage(language)
    ? { text: "Команда уже ведёт следующий шаг и проверит эту деталь.", provenance: "template" }
    : { text: "Our team is already handling the next step and will review that detail.", provenance: "template" };
}

/** Keep a later Human Needed reply contextual without claiming an unproven write. */
function renderUnpersistedHumanNeededDetailReply(language: string, detail: string): TelegramRenderedReply {
  const lower = detail.toLocaleLowerCase();
  const kind = /(?:sofa|диван|sofe)/u.test(lower)
    ? "sofa"
    : /(?:carpet|ков[её]р|tepih)/u.test(lower)
    ? "carpet"
    : /(?:commercial|офис|poslovn)/u.test(lower)
    ? "commercial"
    : /(?:date|дат|datum)/u.test(lower)
    ? "date"
    : "detail";
  if (isSerbianLanguage(language)) {
    const latin = kind === "sofa" ? "Naš tim će proveriti stanje sofe i fleke."
      : kind === "carpet" ? "Naš tim će proveriti materijal tepiha."
      : kind === "commercial" ? "Naš tim će proveriti detalje poslovnog prostora."
      : kind === "date" ? "Naš tim će proveriti željeni datum."
      : "Naš tim će proveriti ovaj detalj.";
    const cyrillic = kind === "sofa" ? "Наш тим ће проверити стање софе и флеке."
      : kind === "carpet" ? "Наш тим ће проверити материјал тепиха."
      : kind === "commercial" ? "Наш тим ће проверити детаље пословног простора."
      : kind === "date" ? "Наш тим ће проверити жељени датум."
      : "Наш тим ће проверити овај детаљ.";
    return { text: serbianText(language, latin, cyrillic), provenance: "template" };
  }
  if (isRussianLanguage(language)) {
    const text = kind === "sofa" ? "Команда проверит состояние дивана и пятна."
      : kind === "carpet" ? "Команда проверит материал ковра."
      : kind === "commercial" ? "Команда проверит детали коммерческого помещения."
      : kind === "date" ? "Команда проверит желаемую дату."
      : "Команда проверит эту деталь.";
    return { text, provenance: "template" };
  }
  const text = kind === "sofa" ? "Our team will review the sofa condition and stains."
    : kind === "carpet" ? "Our team will review the carpet material."
    : kind === "commercial" ? "Our team will review the commercial-space details."
    : kind === "date" ? "Our team will review the requested date."
    : "Our team will review that detail.";
  return { text, provenance: "template" };
}

/** Direct answer after the first legitimate handoff; never starts a second one. */
export function renderHumanNeededAlreadyHandedOffReply(language: string): TelegramRenderedReply {
  if (isSerbianLanguage(language)) return { text: serbianText(language,
    "Da, zahtev je već prosleđen našem timu. Tim će videti i ovu poruku.",
    "Да, захтев је већ прослеђен нашем тиму. Тим ће видети и ову поруку.",
  ), provenance: "template" };
  return isRussianLanguage(language)
    ? { text: "Да, заявку уже передали команде. Команда увидит и это сообщение.", provenance: "template" }
    : { text: "Yes, your request has already been passed to our team. The team will see this message too.", provenance: "template" };
}

/** A reserved lead is terminal for automated customer-turn processing. */
export function renderReservedAcknowledgementReply(language: string): TelegramRenderedReply {
  if (isSerbianLanguage(language)) return { text: serbianText(language,
    "Hvala. Termin je već rezervisan; naš tim će se javiti ako bude potrebno još nešto.",
    "Хвала. Термин је већ резервисан; наш тим ће се јавити ако буде потребно још нешто.",
  ), provenance: "template" };
  return isRussianLanguage(language)
    ? { text: "Пожалуйста. Время уже зарезервировано; команда напишет, если понадобится что-то ещё.", provenance: "template" }
    : { text: "You’re welcome. Your time is already reserved; our team will message if anything else is needed.", provenance: "template" };
}

export function renderStaleSlotReply(language: string): TelegramRenderedReply {
  if (isSerbianLanguage(language)) return { text: serbianText(language,
    "Ta opcija više nije dostupna. Pošaljite poruku i proveriću nove termine.",
    "Та опција више није доступна. Пошаљите поруку и проверићу нове термине.",
  ), provenance: "template" };
  return isRussianLanguage(language)
    ? { text: "Этот вариант больше недоступен. Напишите, и я проверю новое свободное время.", provenance: "template" }
    : { text: "That option is no longer available. Send me a message and I’ll check fresh times.", provenance: "template" };
}

export function renderNoAvailabilityReply(language: string, reason: "nonworking_day" | "requested_date_unavailable" | "requested_time_unavailable" = "requested_date_unavailable"): TelegramRenderedReply {
  if (reason === "nonworking_day") {
    if (isSerbianLanguage(language)) return { text: serbianText(language,
      "Nedeljom ne radimo. Možemo proveriti drugi datum.",
      "Недељом не радимо. Можемо проверити други датум.",
    ), provenance: "template" };
    return isRussianLanguage(language)
      ? { text: "По воскресеньям мы не работаем. Можем проверить другую дату.", provenance: "template" }
      : { text: "We do not work on Sundays. We can check another date.", provenance: "template" };
  }
  if (isSerbianLanguage(language)) return { text: serbianText(language,
    reason === "requested_time_unavailable" ? "U traženo vreme nema slobodnog termina u naredne dve nedelje. Možemo proveriti drugi period." : "Na traženi datum nema slobodnog termina u naredne dve nedelje. Možemo proveriti drugi datum.",
    reason === "requested_time_unavailable" ? "У тражено време нема слободног термина у наредне две недеље. Можемо проверити други период." : "На тражени датум нема слободног термина у наредне две недеље. Можемо проверити други датум.",
  ), provenance: "template" };
  return isRussianLanguage(language)
    ? { text: reason === "requested_time_unavailable" ? "В указанное время в ближайшие две недели свободных слотов нет. Можем проверить другой период." : "На выбранную дату в ближайшие две недели свободных слотов нет. Можем проверить другую дату.", provenance: "template" }
    : { text: reason === "requested_time_unavailable" ? "There are no free slots in that requested time over the next two weeks. We can check another time range." : "There are no free slots on that requested date over the next two weeks. We can check another date.", provenance: "template" };
}

export function renderNewAddressDivider(language: string): TelegramRenderedReply {
  return { text: isRussianLanguage(language) ? "Новый адрес уборки" : "New cleaning location", provenance: "template" };
}

/** A technical retry is not a customer handoff and never asks for all facts again. */
export function renderTechnicalResendReply(language: string): TelegramRenderedReply {
  if (isSerbianLanguage(language)) return { text: serbianText(language,
    "Poslednja poruka nije mogla bezbedno da se obradi. Sve ranije potvrđene detalje smo sačuvali. Pošaljite poslednju poruku još jednom.",
    "Последња порука није могла безбедно да се обради. Сачували смо све раније потврђене детаље. Пошаљите последњу поруку још једном.",
  ), provenance: "template" };
  return isRussianLanguage(language)
    ? { text: "Последнее сообщение не удалось безопасно обработать. Все ранее подтверждённые детали сохранены. Пожалуйста, отправьте последнее сообщение ещё раз.", provenance: "template" }
    : { text: "Your last message could not be processed safely. We kept the details already confirmed. Please send that last message again.", provenance: "template" };
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
    "Mogu da pomognem oko čišćenja. Šta biste želeli da organizujete?",
    "Могу да помогнем око чишћења. Шта бисте желели да организујете?",
  );
  return isRussianLanguage(language)
    ? "Помогу с уборкой. Что вы хотите уточнить или организовать?"
    : "I can help with the cleaning. What would you like to arrange?";
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
  const date = new Intl.DateTimeFormat(locale, {
    timeZone: "Europe/Belgrade", weekday: "long", day: "numeric", month: "long",
  }).format(new Date(input.start));
  const time = new Intl.DateTimeFormat(locale, {
    timeZone: "Europe/Belgrade", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(input.start));
  const quote = `${new Intl.NumberFormat(locale).format(input.quoteAmountRsd)} RSD`;
  if (isRussianLanguage(input.language)) return `${team} приедет ${russianArrivalDate(date)}, в ${time}. Стоимость: ${quote}.`;
  if (isSerbianCyrillic(input.language)) return `${team} долази ${serbianArrivalDate(date, true)}, у ${time}. Цена: ${quote}.`;
  if (isSerbianLanguage(input.language)) return `${team} dolazi ${serbianArrivalDate(date, false)}, u ${time}. Cena: ${quote}.`;
  return `${team} will arrive on ${date}, at ${time}. The price: ${quote}.`;
}

function russianArrivalDate(date: string): string {
  const inflected = date
    .replace(/^воскресенье/iu, "в воскресенье")
    .replace(/^понедельник/iu, "в понедельник")
    .replace(/^вторник/iu, "во вторник")
    .replace(/^среда/iu, "в среду")
    .replace(/^четверг/iu, "в четверг")
    .replace(/^пятница/iu, "в пятницу")
    .replace(/^суббота/iu, "в субботу");
  return inflected;
}

function serbianArrivalDate(date: string, cyrillic: boolean): string {
  const replacements = cyrillic
    ? [["недеља", "недељу"], ["среда", "среду"], ["субота", "суботу"]]
    : [["nedelja", "nedelju"], ["sreda", "sredu"], ["subota", "subotu"]];
  const inflectedWeekday = replacements.reduce((value, [from, to]) => value.replace(new RegExp(`^${from}`, "iu"), to), date);
  const inflected = cyrillic
    ? inflectedWeekday.replace(/август/iu, "августа")
    : inflectedWeekday.replace(/avgust/iu, "avgusta");
  return `u ${inflected}`;
}

function formatRsdAmount(language: string, amountRsd: number): string {
  const locale = isRussianLanguage(language)
    ? "ru-RU"
    : isSerbianCyrillic(language)
    ? "sr-Cyrl-RS"
    : isSerbianLanguage(language)
    ? "sr-Latn-RS"
    : "en-US";
  return `${new Intl.NumberFormat(locale).format(amountRsd)} RSD`;
}

function escapePlainText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
