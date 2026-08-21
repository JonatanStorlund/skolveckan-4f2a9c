/**
 * Dagens körning.
 *
 * Hämtar ur Wilma, extraherar BARA meddelanden som inte extraherats förut, slår
 * ihop med föregående tillstånd och skriver data/oversikt.json.
 *
 * Två skäl till att det är inkrementellt: en full omextrahering varje dygn kostar
 * i onödan, och den formulerar om samma meddelande olika från dag till dag så att
 * sidan ser förändrad ut utan att något hänt.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Wilma, type Child, type Exam } from "./wilma.js";
import { extract } from "./extract.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const statePath = path.join(root, "data", "oversikt.json");
const photoDir = path.join(root, "site", "photos");

/** Hur långt bak vi bryr oss. Äldre meddelanden extraheras aldrig. */
const LOOKBACK_DAYS = 30;
/** Tak per körning, så en första körning inte extraherar hundratals meddelanden. */
const MAX_NEW_PER_RUN = 12;
/** Hur länge en odaterad post får leva innan den städas bort. */
const UNDATED_TTL_DAYS = 21;
/** Hur många meddelanden per barn vi tittar på. */
const INBOX_LIMIT = 25;

export interface Localized {
  text: string;
  note: string;
  dateLabel: string;
}

export interface Item {
  kind: string;
  /** ISO-datum eller tom sträng. */
  date: string;
  time: string;
  sv: Localized;
  fi: Localized;
  quote: string;
  messageId: number;
  /** ISO-datum då posten först dök upp — styr städning av odaterade poster. */
  addedOn: string;
}

export interface Unclear {
  sv: string;
  fi: string;
  messageId: number;
  addedOn: string;
}

export interface ChildBlock {
  /** Gemensam nyckel för foto, panel och väljare: "colin". */
  slug: string;
  name: string;
  school: string;
  className: string;
  items: Item[];
  exams: Exam[];
  uncertain: Unclear[];
}

export interface State {
  stamp: string;
  messageCount: number;
  seen: number[];
  shared: Item[];
  sharedUncertain: Unclear[];
  children: ChildBlock[];
}

const isoToday = (now: Date): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Helsinki" }).format(now);

const slugOf = (child: Child): string =>
  (child.name.split(/\s+/)[0] ?? child.name).toLowerCase().replace(/[^a-zåäö0-9]/g, "");

function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

/**
 * Behåll poster som fortfarande angår någon: daterade fram till sin dag,
 * odaterade i UNDATED_TTL_DAYS. Annars växer sidan för evigt.
 */
function stillRelevant(item: Item, today: string): boolean {
  if (item.date) return item.date >= today;
  return daysBetween(item.addedOn, today) <= UNDATED_TTL_DAYS;
}

const unclearStillRelevant = (u: Unclear, today: string): boolean =>
  daysBetween(u.addedOn, today) <= UNDATED_TTL_DAYS;

async function loadState(): Promise<State | null> {
  try {
    return JSON.parse(await readFile(statePath, "utf8")) as State;
  } catch {
    return null;
  }
}

/** "2026-08-21 11:11" -> "2026-08-21" */
const dayOf = (timestamp: string): string => (timestamp.split(" ")[0] ?? "").trim();

async function main(): Promise<void> {
  const baseUrl = process.env.WILMA_BASE_URL;
  const username = process.env.WILMA_USERNAME;
  const password = process.env.WILMA_PASSWORD;
  if (!baseUrl || !username || !password) {
    throw new Error("WILMA_BASE_URL, WILMA_USERNAME och WILMA_PASSWORD måste vara satta.");
  }

  const now = new Date();
  const today = isoToday(now);
  const previous = await loadState();
  const seen = new Set(previous?.seen ?? []);

  const wilma = new Wilma(baseUrl, username, password);
  const children = await wilma.children();
  if (children.length === 0) throw new Error("Wilma gav inga barn.");

  // Steg 1: inkorg, prov och foto per barn. Inga modellanrop här.
  const inboxes = new Map<string, Awaited<ReturnType<Wilma["messages"]>>>();
  const exams = new Map<string, Exam[]>();
  await mkdir(photoDir, { recursive: true });

  for (const child of children) {
    inboxes.set(child.prefix, await wilma.messages(child.prefix, INBOX_LIMIT));
    exams.set(child.prefix, await wilma.exams(child.prefix));

    const photo = await wilma.photo(child.prefix);
    if (photo) await writeFile(path.join(photoDir, `${slugOf(child)}.jpg`), photo);
    else console.warn(`Inget foto för ${child.name} — behåller eventuellt tidigare.`);
  }

  // Steg 2: samma meddelande-id hos flera barn = hela skolan.
  const owners = new Map<number, string[]>();
  for (const child of children) {
    for (const message of inboxes.get(child.prefix) ?? []) {
      owners.set(message.id, [...(owners.get(message.id) ?? []), child.prefix]);
    }
  }

  // Steg 3: vad är nytt och färskt nog att bry sig om?
  const candidates = [...owners.keys()]
    .map((id) => {
      const prefix = owners.get(id)![0]!;
      const message = (inboxes.get(prefix) ?? []).find((m) => m.id === id)!;
      return { id, prefix, message };
    })
    .filter(({ message }) => {
      const day = dayOf(message.timestamp);
      return day !== "" && daysBetween(day, today) <= LOOKBACK_DAYS;
    })
    .filter(({ id }) => !seen.has(id))
    .sort((a, b) => b.message.timestamp.localeCompare(a.message.timestamp));

  const toExtract = candidates.slice(0, MAX_NEW_PER_RUN);
  if (candidates.length > toExtract.length) {
    console.log(
      `${candidates.length} nya meddelanden, extraherar ${toExtract.length} denna körning ` +
        `(resten nästa gång — taket finns för att en första körning inte ska läsa hela arkivet).`,
    );
  }
  console.log(`${toExtract.length} meddelanden att extrahera, ${seen.size} redan sedda.`);

  // Steg 4: extrahera. Enda steget som kostar något.
  const freshItems = new Map<string, Item[]>();  // nyckel: prefix eller "shared"
  const freshUnclear = new Map<string, Unclear[]>();
  const push = <T>(map: Map<string, T[]>, key: string, values: T[]) =>
    map.set(key, [...(map.get(key) ?? []), ...values]);

  for (const { id, prefix, message } of toExtract) {
    const body = await wilma.read(prefix, id);
    if (!body.text.trim()) {
      console.warn(`Meddelande ${id} ("${message.subject}") hade ingen text — hoppar över.`);
      seen.add(id);
      continue;
    }

    const result = await extract(body.text, now);
    const target = (owners.get(id) ?? []).length > 1 ? "shared" : prefix;

    push(
      freshItems,
      target,
      result.items.map((item) => ({
        kind: item.kind,
        date: item.date,
        time: item.time,
        sv: { text: item.text, note: item.note, dateLabel: item.date_label },
        fi: { text: item.text_fi, note: item.note_fi, dateLabel: item.date_label_fi },
        quote: item.quote,
        messageId: id,
        addedOn: today,
      })),
    );
    push(
      freshUnclear,
      target,
      result.uncertain.map((u) => ({ sv: u.sv, fi: u.fi, messageId: id, addedOn: today })),
    );

    seen.add(id);
    console.log(`  [${id}] ${message.subject} → ${result.items.length} poster (${target})`);
  }

  // Steg 5: slå ihop gammalt och nytt, städa det förbrukade.
  const merge = (old: Item[], fresh: Item[]): Item[] =>
    [...old.filter((item) => stillRelevant(item, today)), ...fresh]
      .filter(
        (item, index, all) =>
          all.findIndex((other) => other.messageId === item.messageId && other.sv.text === item.sv.text) ===
          index,
      )
      .sort((a, b) => {
        if (a.date && b.date) return a.date.localeCompare(b.date);
        if (a.date) return -1;
        if (b.date) return 1;
        return 0;
      });

  const mergeUnclear = (old: Unclear[], fresh: Unclear[]): Unclear[] =>
    [...old.filter((u) => unclearStillRelevant(u, today)), ...fresh].filter(
      (u, index, all) => all.findIndex((other) => other.sv === u.sv) === index,
    );

  const previousChild = (slug: string): ChildBlock | undefined =>
    previous?.children.find((c) => c.slug === slug);

  const state: State = {
    stamp: today,
    messageCount: [...owners.keys()].length,
    seen: [...seen].sort((a, b) => a - b),
    shared: merge(previous?.shared ?? [], freshItems.get("shared") ?? []),
    sharedUncertain: mergeUnclear(previous?.sharedUncertain ?? [], freshUnclear.get("shared") ?? []),
    children: children.map((child) => {
      const slug = slugOf(child);
      const before = previousChild(slug);
      return {
        slug,
        name: child.name.split(/\s+/)[0] ?? child.name,
        school: child.school,
        className: child.className,
        items: merge(before?.items ?? [], freshItems.get(child.prefix) ?? []),
        exams: (exams.get(child.prefix) ?? []).filter((exam) => exam.date >= today),
        uncertain: mergeUnclear(before?.uncertain ?? [], freshUnclear.get(child.prefix) ?? []),
      };
    }),
  };

  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

  const total = state.children.reduce((sum, c) => sum + c.items.length, 0) + state.shared.length;
  console.log(
    `data/oversikt.json — ${state.children.length} barn, ${total} poster, ` +
      `${state.children.reduce((s, c) => s + c.exams.length, 0)} prov, stamp ${state.stamp}`,
  );
}

await main();
