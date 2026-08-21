import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Extraktionsreglerna bor i rules/extraction.md — en sanning, två konsumenter:
 * webbappen (via den här filen) och Claude Code-skillen (som läser filen direkt).
 */
export const SYSTEM_PROMPT = readFileSync(
  path.join(here, "..", "rules", "extraction.md"),
  "utf8",
).trim();

interface DateParts {
  iso: string;
  weekdayEn: string;
  weekdaySv: string;
}

function describe(date: Date): DateParts {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Helsinki",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";

  return {
    iso: `${get("year")}-${get("month")}-${get("day")}`,
    weekdayEn: get("weekday"),
    weekdaySv: new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Helsinki",
      weekday: "long",
    }).format(date),
  };
}

/**
 * Två datum med skilda roller, och det är hela poängen.
 *
 * "Imorgon" i ett meddelande betyder dagen efter att det SKICKADES, inte dagen
 * efter i dag. Att blanda ihop de två gav fyra poster på en lördag: ett
 * meddelande från 12.8 som sa "imorgon" lästes mot 21.8 och blev 22.8.
 */
export function referenceBlock(sentAt: Date, now: Date = sentAt): string {
  const sent = describe(sentAt);
  const today = describe(now);

  const lines = [
    `MESSAGE SENT: ${sent.iso}, ${sent.weekdayEn} (${sent.weekdaySv}).`,
    `Resolve every relative expression in the message against THIS date — "imorgon",` +
      ` "på tisdag", "nästa vecka", "inkommande vecka", "ensi maanantaina".`,
  ];

  if (today.iso !== sent.iso) {
    lines.push(
      `TODAY: ${today.iso}, ${today.weekdayEn} (${today.weekdaySv}). The message is` +
        ` ${Math.round(
          (Date.parse(`${today.iso}T00:00:00Z`) - Date.parse(`${sent.iso}T00:00:00Z`)) / 86400000,
        )} day(s) old. Use today only to judge what has already passed; never to resolve a relative expression.`,
    );
  }

  return lines.join("\n");
}
