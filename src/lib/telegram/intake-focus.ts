/**
 * Product guard for ordinary model-written intake follow-ups. A customer
 * should get one question, or one naturally related pair, rather than a
 * disguised version of the full booking form. Backend templates do not go
 * through this guard: they are already deterministic and scoped to missing
 * facts.
 */
export function isFocusedModelIntakeFollowup(reply: string): boolean {
  const request = requestedClause(reply);
  // A model can phrase the bad form dump as a statement rather than a direct
  // question (for example, just a comma-separated field list). Do not
  // fail-open on the absence of an interrogative trigger: three or more
  // intake topics still read as an enumeration, while short explanatory prose
  // with one or two topics remains natural.
  const fields = detectedFields(request ?? reply);
  // Backend templates such as quote disclosure can naturally mention price
  // category and today/date in the same explanatory sentence. Only a real
  // customer-directed request is subject to the stricter same-group pair
  // rule; a trigger-free 0–2-field explanation remains conversational.
  return request ? isFocusedFieldSet(fields) : fields.length < 3;
}

function isFocusedFieldSet(fields: IntakeField[]): boolean {
  if (fields.length <= 1) return true;
  if (fields.length !== 2) return false;
  return intakeFields.find((field) => field.id === fields[0])?.group === intakeFields.find((field) => field.id === fields[1])?.group;
}

function detectedFields(text: string): IntakeField[] {
  return intakeFields.filter((field) => field.pattern.test(text)).map((field) => field.id);
}

type IntakeField = "cleaningType" | "area" | "rooms" | "bathrooms" | "petHair" | "extras" | "location" | "date";
type IntakeGroup = "scope" | "layout" | "conditions" | "location_and_date";

const intakeFields: ReadonlyArray<{ id: IntakeField; group: IntakeGroup; pattern: RegExp }> = [
  { id: "cleaningType", group: "scope", pattern: /(?:тип уборки|вид уборки|(?<!\p{L})(?:standard|deep|regular)(?!\p{L})|обычн|генеральн|стандардн|детаљн|(?<!\p{L})detaljn\p{L}*(?!\p{L}))/iu },
  { id: "area", group: "scope", pattern: /(?:площад|m2|m²|метр|površin|kvadrat)/iu },
  { id: "rooms", group: "layout", pattern: /(?:комнат|(?<!\p{L})rooms?(?!\p{L})|(?<!\p{L})soba\p{L}*(?!\p{L}))/iu },
  { id: "bathrooms", group: "layout", pattern: /(?:сануз|(?<!\p{L})bathrooms?(?!\p{L})|купатил|(?<!\p{L})kupatil\p{L}*(?!\p{L}))/iu },
  { id: "petHair", group: "conditions", pattern: /(?:шерст|(?<!\p{L})pet\s+hair(?!\p{L})|(?<!\p{L})dlak\p{L}*(?!\p{L}))/iu },
  { id: "extras", group: "conditions", pattern: /(?:окн|духовк|балкон|террас|(?<!\p{L})extras?(?!\p{L})|дополнительн|(?<!\p{L})dodatn\p{L}*\s+uslug\p{L}*(?!\p{L}))/iu },
  { id: "location", group: "location_and_date", pattern: /(?:адрес|район|(?<!\p{L})district(?!\p{L})|(?<!\p{L})deo\s+grada(?!\p{L})|(?<!\p{L})kraj\s+grada(?!\p{L}))/iu },
  { id: "date", group: "location_and_date", pattern: /(?:дата|(?<!\p{L})date(?!\p{L})|сегодня|(?<!\p{L})today(?!\p{L})|датум|(?<!\p{L})danas(?!\p{L})|(?<!\p{L})sutra(?!\p{L})|(?<!\p{L})vikend(?!\p{L}))/iu },
];

/**
 * Find only the actual interrogative/requested tail, so known facts in a
 * natural preamble do not count as a second topic. Unicode letter lookarounds
 * intentionally distinguish Russian "нужны" from adjective forms such as
 * "нужным".
 */
function requestedClause(reply: string): string | undefined {
  const matches = [...reply.matchAll(/(?:какая|какой|какие|сколько|есть\s+ли|(?<!\p{L})нужны(?:\s+ли)?(?!\p{L})|(?<!\p{L})нужно\s+уточнить(?!\p{L})|осталось\s+уточнить|уточните|укажите|перечислите|подскажите|what|which|how\s+many|is\s+there|do\s+you\s+need|i\s+(?:still\s+)?need\s+to\s+(?:clarify|confirm)|please\s+(?:provide|share|tell)|da\s+li|koliko|ima\s+li|treba\s+mi\s+da\s+(?:razjasnim|potvrdim)|potrebno\s+je\s+razjasniti|koji|који|колико|да\s+ли)[\s\S]*$/giu)];
  return matches.at(-1)?.[0];
}
