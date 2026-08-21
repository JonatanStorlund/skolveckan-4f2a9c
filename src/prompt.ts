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

/** Referensdatum som eget block — volatilt, ligger efter cache-brytpunkten. */
export function referenceBlock(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Helsinki",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
  }).formatToParts(now);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";

  const iso = `${get("year")}-${get("month")}-${get("day")}`;
  const weekday = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Helsinki",
    weekday: "long",
  }).format(now);

  return `Reference date (Europe/Helsinki): ${iso}, ${get("weekday")} (${weekday}).`;
}
