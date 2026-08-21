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
import { Wilma, WilmaError, type Child, type Exam, type HomeworkEntry } from "./wilma.js";
import {
  extract,
  summariseUsage,
  TransportError,
  WEEKEND_WORDS,
  type Usage,
} from "./extract.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const statePath = path.join(root, "data", "oversikt.json");
const photoDir = path.join(root, "site", "photos");
const householdPath = path.join(root, "config", "household.json");

/** Hur långt bak vi bryr oss. Äldre meddelanden extraheras aldrig. */
const LOOKBACK_DAYS = 14;
/** Tak per körning, så en första körning inte extraherar hundratals meddelanden. */
const MAX_NEW_PER_RUN = 12;
/** Hur länge en odaterad post får leva innan den städas bort. */
const UNDATED_TTL_DAYS = 21;
/** Hur många meddelanden per barn vi tittar på. */
const INBOX_LIMIT = 25;
/** Tak på anslag per körning. Anslagstavlan är mest permanent referensmaterial. */
const MAX_NOTICES_PER_RUN = 3;
/** Tak på läxposter per körning. Första körningen har en hel veckas dagbok. */
const MAX_HOMEWORK_PER_RUN = 8;
/** Tak på hämtad dokumenttext, så ett långt dokument inte sväller prompten. */
const DOC_CHARS = 4000;

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
  /** Källor som getts upp. Renderas på sidan — förlorad post är förälderns sak. */
  abandoned?: string[];
  /** Misslyckade försök per källa ("m123" meddelande, "n45" anslag). */
  attempts?: Record<string, number>;
  messageCount: number;
  seen: number[];
  /** Lästa anslag. Egen lista: anslags-id kan kollidera med meddelande-id. */
  seenNotices?: number[];
  /** Lästa läxposter, nycklade kurs|datum|text. */
  seenHomework?: string[];
  /** Antal svar per meddelande vid senaste läsning. Ändras det har någon svarat. */
  replies?: Record<string, number>;
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
  if (Number.isNaN(a) || Number.isNaN(b)) {
    // Tyst NaN gjorde att allt filtrerades bort och sidan stämplades om som
    // färsk fast ingenting lästs. Hellre ett högt fel.
    throw new Error(`Kan inte räkna dagar mellan "${fromIso}" och "${toIso}".`);
  }
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

/**
 * Fakta om hemmet som meddelandena inte känner till — t.ex. att ett barn inte
 * går på eftis, så att eftis-info aldrig hamnar på det barnets lista.
 */
async function loadHousehold(): Promise<Record<string, string[]>> {
  try {
    const raw = JSON.parse(await readFile(householdPath, "utf8")) as {
      children?: Record<string, string[]>;
    };
    return raw.children ?? {};
  } catch {
    return {};
  }
}

async function loadState(today: string, file: string): Promise<State | null> {
  try {
    const state = JSON.parse(await readFile(file, "utf8")) as State;
    // Ett semantiskt trasigt addedOn hade fått merge() att kasta utanför all
    // felhantering, varje dygn, utan väg tillbaka annat än att rensa cachen.
    const repair = (rows: { addedOn?: string }[]) => {
      for (const row of rows) {
        if (!row.addedOn || !/^\d{4}-\d{2}-\d{2}$/.test(row.addedOn)) row.addedOn = today;
      }
    };
    repair(state.shared ?? []);
    repair(state.sharedUncertain ?? []);
    for (const child of state.children ?? []) {
      repair(child.items ?? []);
      repair(child.uncertain ?? []);
    }
    return state;
  } catch {
    return null;
  }
}

/**
 * Veckoplaneringen — där läxorna står — ligger som regel i ett Google-dokument
 * som läraren länkar till. Delade dokument har en publik textexport, så den
 * hämtas och läggs efter meddelandet innan extraheringen.
 */
async function followDocs(links: string[]): Promise<string> {
  const parts: string[] = [];
  for (const link of links) {
    const id = /docs\.google\.com\/document\/d\/([A-Za-z0-9_-]+)/.exec(link)?.[1];
    if (!id) continue;
    try {
      const response = await fetch(`https://docs.google.com/document/d/${id}/export?format=txt`, {
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        console.warn(`  dokument ${id} gav ${response.status} — hoppar över.`);
        continue;
      }
      // Ingen smart trimning: förra försöket klippte bort just läxorna.
      // 4000 tecken Haiku-indata kostar under en tiondels cent.
      const text = (await response.text()).slice(0, DOC_CHARS).trim();
      if (text) parts.push(`\n\n--- Länkat dokument (${link}) ---\n${text}`);
    } catch (error) {
      console.warn(`  kunde inte hämta ${link}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return parts.join("");
}

/** "2026-08-21 11:11" -> "2026-08-21". Kastar om Wilma byter format. */
function dayOf(timestamp: string): string {
  const day = (timestamp.split(" ")[0] ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(`Oväntat tidsformat från Wilma: "${timestamp}".`);
  }
  return day;
}

/** Det körningen behöver utifrån. Injicerbart så att main() går att provköra. */
export interface Deps {
  wilma: Pick<
    Wilma,
    "children" | "messages" | "exams" | "photo" | "read" | "notices" | "readNotice" | "homework"
  >;
  extract: typeof extract;
  now?: Date;
  statePath?: string;
  photoDir?: string;
}

export async function run(deps: Deps): Promise<State> {
  const wilma = deps.wilma;
  const extractOne = deps.extract;
  const stateFile = deps.statePath ?? statePath;
  const photos = deps.photoDir ?? photoDir;

  const now = deps.now ?? new Date();
  const today = isoToday(now);
  const previous = await loadState(today, stateFile);
  // Ett meddelande som aldrig kan lyckas — för långt för max_tokens, säg — låg
  // tidigare och köptes om varje dygn i all evighet.
  const attempts: Record<string, number> = { ...(previous?.attempts ?? {}) };
  const MAX_ATTEMPTS = 3;
  const bumpAttempt = (key: string) => {
    attempts[key] = (attempts[key] ?? 0) + 1;
    if (attempts[key] >= MAX_ATTEMPTS) {
      console.warn(`  ${key} har fallit ${attempts[key]} gånger — ger upp om den.`);
    }
  };
  const exhausted = (key: string) => (attempts[key] ?? 0) >= MAX_ATTEMPTS;

  const household = await loadHousehold();
  const seen = new Set(previous?.seen ?? []);
  // Ett meddelande som gett en post är läst, även om seen-listan tappat det.
  for (const item of [
    ...(previous?.shared ?? []),
    ...(previous?.sharedUncertain ?? []),
    ...(previous?.children ?? []).flatMap((c) => [...c.items, ...c.uncertain]),
  ]) {
    if (typeof item.messageId === "number" && item.messageId > 0) seen.add(item.messageId);
  }

  const children = await wilma.children();
  if (children.length === 0) throw new Error("Wilma gav inga barn.");

  // Steg 1: inkorg, prov och foto per barn. Inga modellanrop här.
  const inboxes = new Map<string, Awaited<ReturnType<Wilma["messages"]>>>();
  const exams = new Map<string, Exam[]>();
  await mkdir(photos, { recursive: true });

  for (const child of children) {
    inboxes.set(child.prefix, await wilma.messages(child.prefix, INBOX_LIMIT));
    exams.set(child.prefix, await wilma.exams(child.prefix));

    const photo = await wilma.photo(child.prefix);
    if (photo) await writeFile(path.join(photos, `${slugOf(child)}.jpg`), photo);
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
    .filter(({ id, message }) => {
      try {
        return daysBetween(dayOf(message.timestamp), today) <= LOOKBACK_DAYS;
      } catch (error) {
        console.warn(`  [${id}] hoppar över: ${error instanceof Error ? error.message : error}`);
        return false;
      }
    })
    .filter(({ id, message }) => {
      if (exhausted(`m${id}`)) return false;
      // Ett svar i en tråd vi redan läst är nytt innehåll: läraren kan ha
      // föreslagit en mötestid eller besvarat en ledighetsansökan.
      const before = previous?.replies?.[String(id)] ?? 0;
      if (seen.has(id)) return message.replies > before;
      return true;
    })
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
  const usage: Usage[] = [];
  // Skilda listor med flit: publiceringsbeslutet hör till meddelandena. Delade
  // räknare gjorde att sex anslagsfel kunde stoppa sex lyckade meddelanden.
  const msgFailures: string[] = [];
  const failedIds: string[] = [];
  let transportFailures = 0;
  const noticeFailures: string[] = [];
  const freshItems = new Map<string, Item[]>();  // nyckel: prefix eller "shared"
  const freshUnclear = new Map<string, Unclear[]>();
  const push = <T>(map: Map<string, T[]>, key: string, values: T[]) =>
    map.set(key, [...(map.get(key) ?? []), ...values]);

  for (const { id, prefix, message } of toExtract) {
    try {
      const body = await wilma.read(prefix, id);
      if (!body.text.trim()) {
        console.warn(`Meddelande ${id} ("${message.subject}") hade ingen text — hoppar över.`);
        seen.add(id);
        continue;
      }

      const attached = await followDocs(body.links);
      if (attached) console.log(`  [${id}] följde ${body.links.length} länk(ar) till dokument`);

      const recipients = owners.get(id) ?? [];
      const target = recipients.length > 1 ? "shared" : prefix;
      // Ett meddelande till flera barn får allas fakta; då kan modellen stryka
      // det som inte gäller något av dem.
      const facts = children
        .filter((child) => recipients.includes(child.prefix))
        .flatMap((child) => {
          const slug = slugOf(child);
          return (household[slug] ?? []).map((fact) => `${child.name.split(/\s+/)[0]}: ${fact}`);
        });

      const sentAt = new Date(`${dayOf(message.timestamp)}T12:00:00+03:00`);
      const result = await extractOne(body.text + attached, { sentAt, now, household: facts });
      usage.push(...result.usage);
      if (result.dropped.length) {
        console.warn(`  [${id}] släppte ${result.dropped.length} post(er): ${result.dropped.join("; ")}`);
      }

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
    } catch (error) {
      // Meddelandet läggs medvetet INTE i seen: nästa körning får försöka igen.
      // Men de som redan lyckats ska inte kastas bort med det.
      msgFailures.push(`[${id}] ${message.subject}: ${error instanceof Error ? error.message : error}`);
      // Transportfel kan lyckas i morgon och ska inte kosta budget. Källfel —
      // för långt, refusal, otolkbart svar — kommer aldrig att lyckas.
      if (error instanceof TransportError || error instanceof WilmaError) transportFailures += 1;
      else failedIds.push(`m${id}`);
      console.error(`  [${id}] FEL, hoppar över: ${error instanceof Error ? error.message : error}`);
    }
  }

  for (const [label, list] of [
    ["meddelande", msgFailures],
    ["anslag", noticeFailures],
  ] as const) {
    if (list.length) console.error(`\n${list.length} ${label} kunde inte läsas:\n  ${list.join("\n  ")}`);
  }
  // Systemiskt betyder transportfel hela vägen: nätet eller API:et är nere, och
  // i morgon kan det gå. Ett enda otolkbart meddelande är INTE systemiskt — att
  // räkna i stället för att klassificera lät ett sådant frysa sidan för evigt.
  const systemic =
    toExtract.length >= 2 &&
    msgFailures.length === toExtract.length &&
    transportFailures === msgFailures.length;

  for (const key of failedIds) bumpAttempt(key);

  if (systemic) {
    throw new Error(
      `Samtliga ${toExtract.length} meddelanden föll på transportfel — publicerar inget.`,
    );
  }

  // Uppgivna källor ska synas i varje körning, inte bara den gång de gavs upp.
  const abandoned = Object.entries(attempts)
    .filter(([, n]) => n >= MAX_ATTEMPTS)
    .map(([key]) => key);
  if (abandoned.length) {
    console.warn(
      `\n${abandoned.length} källa/källor har getts upp efter ${MAX_ATTEMPTS} försök: ` +
        `${abandoned.join(", ")}. Det syns på sidan.`,
    );
  }

  // Anslagstavlan. Mest permanenta blanketter och instruktioner, så bara
  // dagsaktuella anslag läses — resten skulle kosta tokens utan att säga något.
  const seenNotices = new Set(previous?.seenNotices ?? []);
  // Härled på samma sätt som seen, så listan inte kan glida ifrån innehållet.
  for (const item of (previous?.children ?? []).flatMap((c) => [...c.items, ...c.uncertain])) {
    if (typeof item.messageId === "number" && item.messageId < 0) seenNotices.add(-item.messageId);
  }
  let noticeBudget = MAX_NOTICES_PER_RUN;

  for (const child of children) {
    let notices: Awaited<ReturnType<Wilma["notices"]>> = [];
    try {
      notices = await wilma.notices(child.prefix);
    } catch (error) {
      console.warn(`  anslagstavlan för ${child.name}: ${error instanceof Error ? error.message : error}`);
      continue;
    }

    // Skär listan FÖRE loopen: annars räknade bara lyckade försök mot taket och
    // tjugo trasiga anslag kunde betala för fyrtio modellanrop.
    const candidates = notices.filter((notice) => {
      if (!notice.date || seenNotices.has(notice.id) || exhausted(`n${notice.id}`)) return false;
      const age = daysBetween(notice.date, today);
      // Nedre gräns också: ett anslag kan inte vara publicerat i framtiden, och
      // ett framtida avsändningsdatum ger modellen en orimlig referens.
      return age >= 0 && age <= LOOKBACK_DAYS;
    });

    for (const notice of candidates.slice(0, noticeBudget)) {
      noticeBudget -= 1;
      try {
        const body = await wilma.readNotice(child.prefix, notice.id);
        if (!body.text.trim()) {
          seenNotices.add(notice.id);
          continue;
        }
        const attached = await followDocs(body.links);
        const sentAt = new Date(`${notice.date}T12:00:00+03:00`);
        const facts = (household[slugOf(child)] ?? []).map(
          (fact) => `${child.name.split(/\s+/)[0]}: ${fact}`,
        );
        const result = await extractOne(
          `Anslag på skolans anslagstavla: ${notice.title}\n\n${body.text}${attached}`,
          { sentAt, now, household: facts },
        );
        usage.push(...result.usage);
        push(
          freshItems,
          child.prefix,
          result.items.map((item) => ({
            kind: item.kind,
            date: item.date,
            time: item.time,
            sv: { text: item.text, note: item.note, dateLabel: item.date_label },
            fi: { text: item.text_fi, note: item.note_fi, dateLabel: item.date_label_fi },
            quote: item.quote,
            // Negativt id skiljer anslag från meddelanden i sammanslagningen.
            messageId: -notice.id,
            addedOn: today,
          })),
        );
        push(
          freshUnclear,
          child.prefix,
          result.uncertain.map((u) => ({
            sv: u.sv,
            fi: u.fi,
            messageId: -notice.id,
            addedOn: today,
          })),
        );
        seenNotices.add(notice.id);
        console.log(
          `  anslag [${notice.id}] ${notice.title.slice(0, 50)} → ${result.items.length} poster (${child.name})`,
        );
      } catch (error) {
        noticeFailures.push(`anslag [${notice.id}]: ${error instanceof Error ? error.message : error}`);
        if (!(error instanceof TransportError || error instanceof WilmaError)) {
          failedIds.push(`n${notice.id}`);
        }
      }
    }
  }

  // Helgvakt: skolan har inte lektioner på lördag eller söndag, så ett datum
  // som landar där är en feltolkning. Datumet tas bort, posten behålls odaterad.
  for (const list of freshItems.values()) {
    for (const item of list) {
      if (!item.date) continue;
      const weekday = new Date(`${item.date}T00:00:00Z`).getUTCDay();
      if ((weekday !== 0 && weekday !== 6) || WEEKEND_WORDS.test(item.quote)) continue;
      console.warn(`  helgdatum ${item.date} på "${item.sv.text}" — datumet tas bort`);
      item.date = "";
      item.sv.dateLabel = "";
      item.fi.dateLabel = "";
    }
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

  // Läxor ur kursdagböckerna. Nellies lärare lägger dem i veckoplaneringen som
  // redan följs; Colins står bara här.
  const seenHomework = new Set(previous?.seenHomework ?? []);
  const noHomework = /^(?=.{0,140}$)(?:.*\b(?:ingen läxa|inga läxor|läxfritt|ei läksyä|ei kotitehtäviä)\b)/i;
  let homeworkBudget = MAX_HOMEWORK_PER_RUN;

  for (const child of children) {
    let entries: HomeworkEntry[] = [];
    try {
      entries = await wilma.homework(child.prefix);
    } catch (error) {
      console.warn(`  läxor för ${child.name}: ${error instanceof Error ? error.message : error}`);
      continue;
    }

    const fresh = entries.filter((entry) => {
      const id = `${entry.course}|${entry.date}|${entry.text}`;
      if (seenHomework.has(id) || exhausted(`h${id}`)) return false;
      const age = daysBetween(entry.date, today);
      if (age < 0 || age > LOOKBACK_DAYS) return false;
      // "Ei läksyä!" är ett svar, inte en uppgift — och gratis att sålla i kod.
      if (noHomework.test(entry.text)) {
        seenHomework.add(id);
        return false;
      }
      return true;
    });

    for (const entry of fresh.slice(0, homeworkBudget)) {
      homeworkBudget -= 1;
      const id = `${entry.course}|${entry.date}|${entry.text}`;
      try {
        const sentAt = new Date(`${entry.date}T12:00:00+03:00`);
        const facts = (household[slugOf(child)] ?? []).map(
          (fact) => `${child.name.split(/\s+/)[0]}: ${fact}`,
        );
        const result = await extractOne(
          `Kursdagbok, ${entry.course}, lektion ${entry.date}:\n\n${entry.text}`,
          { sentAt, now, household: facts },
        );
        usage.push(...result.usage);
        push(
          freshItems,
          child.prefix,
          result.items.map((item) => ({
            kind: item.kind === "info" ? "laxa" : item.kind,
            // Kursdagbokens datum är lektionens; läxan hör till nästa lektion om
            // modellen inte hittat något annat datum i texten.
            date: item.date || entry.date,
            time: item.time,
            sv: { text: item.text, note: item.note, dateLabel: item.date_label },
            fi: { text: item.text_fi, note: item.note_fi, dateLabel: item.date_label_fi },
            quote: item.quote,
            messageId: 0,
            addedOn: today,
          })),
        );
        seenHomework.add(id);
        console.log(`  läxa ${entry.date} ${entry.course} → ${result.items.length} poster (${child.name})`);
      } catch (error) {
        noticeFailures.push(`läxa ${entry.course} ${entry.date}: ${error instanceof Error ? error.message : error}`);
        if (!(error instanceof TransportError || error instanceof WilmaError)) failedIds.push(`h${id}`);
      }
    }
  }

  const state: State = {
    stamp: today,
    messageCount: [...owners.keys()].length,
    seen: [...seen].sort((a, b) => a - b),
    seenNotices: [...seenNotices].sort((a, b) => a - b),
    seenHomework: [...seenHomework].sort(),
    replies: Object.fromEntries(
      [...owners.keys()].map((id) => {
        const prefix = owners.get(id)![0]!;
        const message = (inboxes.get(prefix) ?? []).find((m) => m.id === id);
        return [String(id), message?.replies ?? 0];
      }),
    ),
    attempts,
    abandoned,
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

  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);

  const total = state.children.reduce((sum, c) => sum + c.items.length, 0) + state.shared.length;
  console.log(
    `data/oversikt.json — ${state.children.length} barn, ${total} poster, ` +
      `${state.children.reduce((s, c) => s + c.exams.length, 0)} prov, stamp ${state.stamp}`,
  );
  console.log(summariseUsage(usage));

  return state;
}

async function main(): Promise<void> {
  const baseUrl = process.env.WILMA_BASE_URL;
  const username = process.env.WILMA_USERNAME;
  const password = process.env.WILMA_PASSWORD;
  if (!baseUrl || !username || !password) {
    throw new Error("WILMA_BASE_URL, WILMA_USERNAME och WILMA_PASSWORD måste vara satta.");
  }
  // Kontrolleras här, inte vid första extraheringen: annars loggar vi in, hämtar
  // två inkorgar, provkalendrar och foton och faller först då.
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY måste vara satt.");
  }

  await run({ wilma: new Wilma(baseUrl, username, password), extract });
}

// Bara när filen körs direkt — testerna importerar run() utan att starta något.
if (process.argv[1] && /daily\.[tj]s$/.test(process.argv[1])) {
  await main();
}
