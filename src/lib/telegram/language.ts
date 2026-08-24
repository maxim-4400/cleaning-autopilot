export type ReplyLocale = "en" | "ru" | "sr-Latn" | "sr-Cyrl";
export type ReplyLanguage = ReplyLocale;

export function isRussianLanguage(language: string): boolean {
  return language.trim().toLowerCase().split("-", 1)[0] === "ru";
}

export function isSerbianLanguage(language: string): boolean {
  return language.trim().toLowerCase().split("-", 1)[0] === "sr";
}

export function isSerbianCyrillic(language: string): boolean {
  return language.trim().toLowerCase() === "sr-cyrl";
}

/**
 * Chooses the language for one customer-facing turn without persisting it.
 * Unsupported or genuinely mixed text intentionally falls back to English so
 * a lead or conversation can never lock a later reply into an earlier
 * language. Common customer details such as `m²`, `m2` and `Vračar` are not a
 * language switch when the rest of the message is clearly Cyrillic.
 */
export function resolveReplyLanguage(message: string): ReplyLanguage {
  const normalized = message.normalize("NFKC").toLocaleLowerCase()
    .replace(/https?:\/\/\S+|www\.\S+|\b\S+@\S+\b|\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/giu, " ");
  const cyrillicLetters = (normalized.match(/[\u0400-\u052f]/g) ?? []).length;
  const latinLetters = (normalized.match(/[a-zčćšžđ]/g) ?? []).length;
  if (cyrillicLetters === 0 && latinLetters === 0) return "en";

  const tokens = normalized.match(/[\p{L}]+/gu) ?? [];
  const scores = {
    ru: score(tokens, russianVocabulary),
    srCyrl: score(tokens, serbianCyrillicVocabulary),
    srLatn: score(tokens, serbianLatinVocabulary),
    en: score(tokens, englishVocabulary),
  };
  const strongSerbianCyrillic = /[ђјљњћџ]/u.test(normalized);
  const strongRussian = /[ёйщъыьэюя]/u.test(normalized);
  const strongSerbianLatin = /[čćšžđ]/u.test(normalized);

  if (cyrillicLetters > 0) {
    const cyrillicLanguage = resolveCyrillicLanguage({
      tokens,
      scores,
      strongSerbianCyrillic,
      strongRussian,
    });
    // A Serbian district name or measurement notation is expected in a local
    // Russian/Serbian message. Require a clearly dominant Cyrillic signal so
    // an actual code-switch such as "Нужна cleaning" still stays unclassified.
    if (latinLetters > 0 && (cyrillicLanguage === "en" || cyrillicLetters < latinLetters * 2)) return "en";
    return cyrillicLanguage;
  }

  if (strongSerbianLatin && scores.en > 0) return "en";
  if (strongSerbianLatin) return "sr-Latn";
  if (scores.srLatn >= 2 && scores.srLatn >= scores.en + 1) return "sr-Latn";
  return "en";
}

function resolveCyrillicLanguage(input: {
  tokens: string[];
  scores: { ru: number; srCyrl: number; srLatn: number; en: number };
  strongSerbianCyrillic: boolean;
  strongRussian: boolean;
}): ReplyLanguage {
  const { tokens, scores, strongSerbianCyrillic, strongRussian } = input;
  if (strongSerbianCyrillic && strongRussian) return "en";
  if (strongSerbianCyrillic && scores.ru > 0) return "en";
  // Some harmless Serbian request words overlap with Russian (for example
  // "покажи"). Keep a clearly Russian multi-word message Russian rather
  // than treating that single overlap as a mixed-language turn.
  if (strongRussian && scores.srCyrl > 0 && scores.ru < scores.srCyrl + 2) return "en";
  if (strongSerbianCyrillic) return "sr-Cyrl";
  if (strongRussian) return "ru";
  if (scores.srCyrl >= 2 && scores.srCyrl >= scores.ru + 1 && scores.srCyrl >= scores.en + 1) return "sr-Cyrl";
  // Common short Russian turns are deliberately recognised. Serbian uses
  // the same alphabet for a few neutral words, so a single ambiguous word
  // still falls back to English unless it is clearly Russian.
  if (tokens.some((token) => serbianCyrillicClearShortTurns.has(token))) return "sr-Cyrl";
  if ((tokens.some((token) => russianClearShortTurns.has(token)) || scores.ru >= 2) && scores.ru >= scores.srCyrl + 1 && scores.ru >= scores.en + 1) return "ru";
  return "en";
}

/**
 * `resolveReplyLanguage` intentionally has a safe English fallback for text
 * that cannot be classified.  English is not, by itself, evidence that the
 * customer changed languages: short acknowledgements, dates and fragments
 * must keep the durable language of the current service request.
 */
export function isReplyLanguageConfident(message: string, language: ReplyLanguage): boolean {
  if (language !== "en") return true;
  const normalized = message.normalize("NFKC").toLocaleLowerCase();
  return /\b(?:hello|hi|thanks|thank you|please|cleaning|apartment|flat|bathroom|room|available|morning|afternoon|evening|today|tomorrow|weekend|yes|no)\b/u.test(normalized);
}

const serbianCyrillicVocabulary = new Set(["треба", "чишћење", "чишћења", "стан", "стана", "соба", "собе", "купатило", "купатила", "квадрата", "данас", "сутра", "термин", "термине", "покажи", "слободне", "увече", "поподне", "ујутру", "молим", "хвала"]);
const russianVocabulary = new Set(["привет", "здравствуйте", "добрый", "день", "нужна", "нужно", "хочу", "заказать", "заказ", "уборка", "уборку", "квартира", "квартиру", "комнат", "комнаты", "санузел", "сегодня", "завтра", "время", "слоты", "свободные", "покажи", "пожалуйста", "спасибо", "после", "ремонта", "первый", "второй", "третий", "вариант", "выходных", "выходные"]);
const russianClearShortTurns = new Set(["привет", "здравствуйте"]);
const serbianCyrillicClearShortTurns = new Set(["увече", "поподне", "ујутру"]);
const serbianLatinVocabulary = new Set(["treba", "ciscenje", "čišćenje", "čišćenja", "stan", "stana", "soba", "sobe", "kupatilo", "kupatila", "kvadrata", "danas", "sutra", "termin", "molim", "hvala"]);
const englishVocabulary = new Set(["cleaning", "flat", "apartment", "room", "bathroom", "today", "tomorrow", "please", "thanks", "available"]);

function score(tokens: string[], vocabulary: ReadonlySet<string>): number {
  return tokens.reduce((total, token) => total + Number(vocabulary.has(token)), 0);
}
