/**
 * Provkörning av dagens körning med attrapper.
 *
 * Skrivet efter att två fel i main() sluppit igenom — ett tidsdödzonsfel som
 * hade dödat varje körning — eftersom tsc inte ser dem och sidtesterna testar
 * den renderade sidan, inte orkestreringen. Här körs den faktiska koden.
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { run, type Deps } from "../src/daily.js";
import { SourceError, TransportError, type ExtractResult } from "../src/extract.js";

const results: string[] = [];
let failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push(`  PASS  ${name}`);
  } catch (error) {
    results.push(`  FAIL  ${name}\n        ${(error as Error).message.split("\n")[0]}`);
    failed += 1;
  }
}

const CHILD = { name: "Testbarn Ett", prefix: "/!1", school: "Testskolan", className: "3a" };
const NOW = new Date("2026-08-21T09:00:00+03:00");

interface StubOptions {
  messages?: { id: number; subject: string; timestamp: string }[];
  notices?: { id: number; title: string; date: string }[];
  readThrows?: boolean;
  homework?: { course: string; date: string; text: string }[];
  extractThrows?: boolean;
  transportThrows?: boolean;
  items?: number;
}

function stub(options: StubOptions = {}) {
  const calls = { extract: 0, read: 0, readNotice: 0 };
  const messages = options.messages ?? [
    { id: 101, subject: "Info vecka 35", timestamp: "2026-08-20 14:00" },
  ];

  const deps = {
    now: NOW,
    wilma: {
      children: async () => [CHILD],
      messages: async () => messages.map((m) => ({ ...m, sender: "Läraren", unread: true, replies: 0 })),
      exams: async () => [
        { date: "2026-10-07", subject: "Matematik", group: "MA", teachers: ["MSt"] },
      ],
      photo: async () => null,
      read: async (_p: string, id: number) => {
        calls.read += 1;
        if (options.readThrows) throw new Error("Wilma svarade 500");
        return {
          id,
          subject: "Info",
          sender: "Läraren",
          timestamp: "2026-08-20 14:00",
          unread: true,
          replies: 0,
          text: "Ta med gymnastikkläder på tisdag.",
          links: [],
        };
      },
      notices: async () => options.notices ?? [],
      homework: async () => options.homework ?? [],
      readNotice: async () => {
        calls.readNotice += 1;
        return { title: "Anslag", text: "Simhallen stängd på torsdag.", links: [] };
      },
    },
    extract: async (): Promise<ExtractResult> => {
      calls.extract += 1;
      if (options.transportThrows) throw new TransportError("API:et svarade inte");
      if (options.extractThrows) throw new SourceError("för långt för max_tokens");
      return {
        language_in: "sv",
        subject: "",
        items: Array.from({ length: options.items ?? 1 }, (_, i) => ({
          text: `Post ${i}`,
          text_fi: `Kohta ${i}`,
          kind: "ta_med" as const,
          date: "2026-08-25",
          date_label: "tis 25.8",
          date_label_fi: "ti 25.8.",
          time: "",
          note: "",
          note_fi: "",
          quote: "gymnastikkläder",
        })),
        uncertain: [],
        usage: [],
        dropped: [],
      };
    },
  } as unknown as Deps;

  return { deps, calls };
}

async function tempPaths() {
  const dir = await mkdtemp(path.join(tmpdir(), "skolveckan-"));
  return { statePath: path.join(dir, "oversikt.json"), photoDir: path.join(dir, "photos") };
}

// Det här testet hade fångat tidsdödzonsfelet: koden kraschade så fort ett
// meddelande passerade fönstret, långt före något modellanrop.
await check("en körning med ett meddelande i fönstret går igenom", async () => {
  const { deps, calls } = stub();
  const state = await run({ ...deps, ...(await tempPaths()) });
  assert.equal(calls.extract, 1, "extraheringen kördes inte");
  assert.equal(state.children.length, 1);
  assert.equal(state.children[0]!.items.length, 1);
  assert.deepEqual(state.seen, [101]);
  assert.equal(state.stamp, "2026-08-21");
});

await check("tillståndet skrivs och kan läsas tillbaka", async () => {
  const paths = await tempPaths();
  const { deps } = stub();
  await run({ ...deps, ...paths });
  const written = JSON.parse(await readFile(paths.statePath, "utf8"));
  assert.equal(written.stamp, "2026-08-21");
  assert.ok(Array.isArray(written.seen));
});

await check("andra körningen gör noll modellanrop", async () => {
  const paths = await tempPaths();
  const first = stub();
  await run({ ...first.deps, ...paths });
  const second = stub();
  await run({ ...second.deps, ...paths });
  assert.equal(second.calls.extract, 0, `andra körningen anropade modellen ${second.calls.extract} gånger`);
});

await check("gamla meddelanden extraheras aldrig", async () => {
  const { deps, calls } = stub({
    messages: [{ id: 900, subject: "Gammalt", timestamp: "2026-06-01 09:00" }],
  });
  await run({ ...deps, ...(await tempPaths()) });
  assert.equal(calls.extract, 0, "ett meddelande utanför fönstret lästes");
});

await check("en trasig tidsstämpel dödar inte körningen", async () => {
  const { deps, calls } = stub({
    messages: [
      { id: 101, subject: "Bra", timestamp: "2026-08-20 14:00" },
      { id: 102, subject: "Trasig", timestamp: "ingen-tid-alls" },
    ],
  });
  const state = await run({ ...deps, ...(await tempPaths()) });
  assert.equal(calls.extract, 1, "det goda meddelandet extraherades inte");
  assert.deepEqual(state.seen, [101]);
});

// Ett enda oläsbart meddelande fick tidigare frysa sidan för alltid: "allt föll"
// och "det här meddelandet går inte att läsa" gick inte att skilja på, och
// avbrottet skedde före skrivningen så budgeten kunde aldrig räknas upp.
await check("ett oläsbart meddelande fryser inte sidan", async () => {
  const paths = await tempPaths();
  const { deps } = stub({ extractThrows: true });
  const state = await run({ ...deps, ...paths });
  assert.equal(state.attempts?.m101, 1, "budgeten räknades inte upp");
  assert.equal(state.seen.includes(101), false, "ett fallet meddelande markerades som läst");
});

await check("oläsbart meddelande ges upp efter tre dygn och sidan går vidare", async () => {
  const paths = await tempPaths();
  for (let day = 1; day <= 3; day += 1) {
    const { deps } = stub({ extractThrows: true });
    const state = await run({ ...deps, ...paths });
    assert.equal(state.attempts?.m101, day, `dag ${day}: budgeten står på ${state.attempts?.m101}`);
  }
  // Fjärde dygnet ska det inte ens försökas — och sidan publiceras som vanligt.
  const fourth = stub({ extractThrows: true });
  const state = await run({ ...fourth.deps, ...paths });
  assert.equal(fourth.calls.extract, 0, "en uppgiven källa köptes igen");
  assert.deepEqual(state.abandoned, ["m101"], "uppgiven källa syns inte i tillståndet");
});

await check("transportfel hela vägen publicerar inget", async () => {
  const paths = await tempPaths();
  const { deps } = stub({
    messages: [
      { id: 101, subject: "Ett", timestamp: "2026-08-20 14:00" },
      { id: 102, subject: "Två", timestamp: "2026-08-20 15:00" },
    ],
    transportThrows: true,
  });
  await assert.rejects(() => run({ ...deps, ...paths }), /transportfel/);
  // Inget tillstånd skrivet, och ingen budget bränd — i morgon kan nätet vara uppe.
  await assert.rejects(() => readFile(paths.statePath, "utf8"));
});

await check("ett enskilt fel spar de andra", async () => {
  const { deps, calls } = stub({
    messages: [
      { id: 101, subject: "Ett", timestamp: "2026-08-20 14:00" },
      { id: 102, subject: "Två", timestamp: "2026-08-20 15:00" },
    ],
  });
  let n = 0;
  const flaky = {
    ...deps,
    extract: async (...args: unknown[]) => {
      n += 1;
      if (n === 1) throw new Error("modellen föll en gång");
      return (deps.extract as unknown as (...a: unknown[]) => Promise<ExtractResult>)(...args);
    },
  } as unknown as Deps;
  const state = await run({ ...flaky, ...(await tempPaths()) });
  assert.equal(n, 2, "båda meddelandena försöktes inte");
  assert.equal(state.children[0]!.items.length, 1, "det lyckade meddelandet tappades");
  // Listan sorteras nyast först, så 102 är den som faller. Den får inte hamna
  // i seen — den ska försökas igen i morgon.
  assert.equal(state.seen.includes(102), false, "ett fallet meddelande markerades som läst");
  assert.equal(state.seen.includes(101), true, "det lyckade meddelandet saknas i seen");
});

await check("anslag inom fönstret läses, äldre hoppas över", async () => {
  const { deps, calls } = stub({
    messages: [],
    notices: [
      { id: 5001, title: "Nytt anslag", date: "2026-08-18" },
      { id: 5002, title: "Gammalt", date: "2025-09-01" },
    ],
  });
  const state = await run({ ...deps, ...(await tempPaths()) });
  assert.equal(calls.readNotice, 1, `läste ${calls.readNotice} anslag, förväntade 1`);
  assert.deepEqual(state.seenNotices, [5001]);
});

await check("anslag med datum i framtiden läses aldrig", async () => {
  const { deps, calls } = stub({
    messages: [],
    notices: [{ id: 5003, title: "Framtid", date: "2026-09-19" }],
  });
  await run({ ...deps, ...(await tempPaths()) });
  assert.equal(calls.readNotice, 0, "ett anslag daterat i framtiden lästes");
});

await check("prov hämtas utan modellanrop", async () => {
  const { deps, calls } = stub({ messages: [] });
  const state = await run({ ...deps, ...(await tempPaths()) });
  assert.equal(calls.extract, 0, "prov kostade modellanrop");
  assert.equal(state.children[0]!.exams.length, 1);
});

await check("läxor ur kursdagboken blir poster", async () => {
  const { deps, calls } = stub({
    messages: [],
    homework: [
      { course: "MA MA71", date: "2026-08-20", text: "s.12 Kortläxa u.16-19" },
      // "Ingen läxa" ska sållas i kod, gratis, utan modellanrop.
      { course: "BI BI71", date: "2026-08-20", text: "ingen läxa denna gång!" },
    ],
  });
  const state = await run({ ...deps, ...(await tempPaths()) });
  assert.equal(calls.extract, 1, `förväntade 1 modellanrop, fick ${calls.extract}`);
  assert.equal(state.children[0]!.items.length, 1);
  assert.equal(state.seenHomework?.length, 2, "den sållade posten ska också märkas som sedd");
});

await check("läxor läses inte om nästa körning", async () => {
  const paths = await tempPaths();
  const homework = [{ course: "MA MA71", date: "2026-08-20", text: "s.12 Kortläxa" }];
  await run({ ...stub({ messages: [], homework }).deps, ...paths });
  const second = stub({ messages: [], homework });
  await run({ ...second.deps, ...paths });
  assert.equal(second.calls.extract, 0, "läxan köptes en andra gång");
});

await check("ett nytt svar i en tråd gör den läsvärd igen", async () => {
  const paths = await tempPaths();
  const msg = { id: 101, subject: "Ansökan om ledighet", timestamp: "2026-08-20 14:00" };
  const first = stub({ messages: [msg] });
  await run({ ...first.deps, ...paths });

  // Samma meddelande, men läraren har svarat: replies 0 -> 1.
  const answered = stub({ messages: [msg] });
  const deps = {
    ...answered.deps,
    wilma: {
      ...(answered.deps as { wilma: Record<string, unknown> }).wilma,
      messages: async () => [{ ...msg, sender: "Läraren", unread: false, replies: 1 }],
    },
  } as unknown as Deps;
  await run({ ...deps, ...paths });
  assert.equal(answered.calls.extract, 1, "svaret i tråden lästes inte");
});

console.log(results.join("\n"));
console.log(failed ? `\n${failed} test föll.` : `\nAlla ${results.length} test gick igenom.`);
if (failed) process.exitCode = 1;
