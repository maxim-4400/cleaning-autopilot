import type { CleaningTeam, ClientData } from "@/lib/contracts/domain";

export type BusyInterval = { start: string; end: string };
export type SchedulableSlot = { team: CleaningTeam; start: string; end: string; bufferEnd: string };

const timeZone = "Europe/Belgrade";
const teams: readonly CleaningTeam[] = ["team_a", "team_b"];
const dayMs = 86_400_000;

export class SchedulingEngine {
  durationMinutes(data: Pick<ClientData, "cleaningType" | "areaM2">): number {
    if (!data.cleaningType || !data.areaM2) throw new Error("Cleaning type and area are required for scheduling");
    const rawMinutes = (data.areaM2 / (data.cleaningType === "standard" ? 25 : 15)) * 60;
    return Math.max(120, Math.ceil(rawMinutes / 30) * 30);
  }

  findSlots(input: {
    clientData: ClientData;
    now: Date;
    busyByTeam: Record<CleaningTeam, BusyInterval[]>;
    /** A precise customer request such as "after 19:00" applies every day. */
    minimumLocalStartMinutes?: number;
    /** "Later" applies after the last displayed option on its offered day. */
    minimumStartOnPreferredDate?: string;
    /** Internal fallback ranking needs the same calendar snapshot, not a re-query. */
    limit?: number;
  }): SchedulableSlot[] {
    if (!input.clientData.preferredDate) return [];
    const durationMinutes = this.durationMinutes(input.clientData);
    if (durationMinutes + 30 > 12 * 60) throw new Error("cleaning_duration_exceeds_workday");
    const requestedDate = parseDate(input.clientData.preferredDate);
    const today = localDate(input.now);
    const firstDate = Math.max(requestedDate, today);
    const minStart = requestedDate === today
      ? ceilToGrid(new Date(input.now.getTime() + (input.clientData.urgency === "same_day" ? 120 : 0) * 60_000))
      : undefined;
    const slots: SchedulableSlot[] = [];

    for (let date = firstDate; date <= requestedDate + 13; date += 1) {
      if (new Date(Date.UTC(1970, 0, 1) + date * dayMs).getUTCDay() === 0) continue;
      for (let minute = 8 * 60; minute < 20 * 60; minute += 30) {
        const start = zonedDateTimeToUtc(date, minute);
        const end = new Date(start.getTime() + durationMinutes * 60_000);
        const bufferEnd = new Date(end.getTime() + 30 * 60_000);
        if (
          localDate(end) !== date || localDate(bufferEnd) !== date || localMinutes(bufferEnd) > 20 * 60 ||
          (minStart && start < minStart) ||
          (input.minimumLocalStartMinutes !== undefined && localMinutes(start) < input.minimumLocalStartMinutes) ||
          (date === requestedDate && input.minimumStartOnPreferredDate && start < new Date(input.minimumStartOnPreferredDate)) ||
          !withinRequestedWindow(input.clientData.preferredTimeWindow, localMinutes(start))
        ) continue;
        for (const team of teams) {
          if (!input.busyByTeam[team].some((busy) => overlaps(start, bufferEnd, new Date(busy.start), new Date(busy.end)))) {
            slots.push({ team, start: start.toISOString(), end: end.toISOString(), bufferEnd: bufferEnd.toISOString() });
          }
        }
      }
    }
    return slots.sort((a, b) => a.start.localeCompare(b.start) || a.team.localeCompare(b.team)).slice(0, input.limit ?? 3);
  }
}

function withinRequestedWindow(window: ClientData["preferredTimeWindow"], minute: number): boolean {
  if (!window) return true;
  if (window === "morning") return minute >= 8 * 60 && minute < 12 * 60;
  if (window === "midday") return minute >= 12 * 60 && minute < 16 * 60;
  return minute >= 16 * 60 && minute < 20 * 60;
}

function parseDate(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error("Invalid preferred date");
  return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / dayMs);
}

function localDate(date: Date): number {
  const parts = partsFor(date);
  return Math.floor(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / dayMs);
}

function localMinutes(date: Date): number {
  const parts = partsFor(date);
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function partsFor(date: Date): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

function zonedDateTimeToUtc(date: number, minutes: number): Date {
  const local = new Date(date * dayMs);
  const desiredUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), Math.floor(minutes / 60), minutes % 60);
  let candidate = new Date(desiredUtc);
  for (let i = 0; i < 2; i += 1) {
    const parts = partsFor(candidate);
    const actual = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    candidate = new Date(candidate.getTime() + desiredUtc - actual);
  }
  return candidate;
}

function ceilToGrid(date: Date): Date {
  return new Date(Math.ceil(date.getTime() / (30 * 60_000)) * 30 * 60_000);
}

function overlaps(start: Date, end: Date, busyStart: Date, busyEnd: Date): boolean {
  return start < busyEnd && busyStart < end;
}
