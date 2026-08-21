/**
 * Kör sidans egna skript i en riktig DOM, med klockan ställd.
 *
 * Poängen: facken räknas om i webbläsaren, så en sida byggd på fredag måste
 * gruppera rätt även på måndag. Det går inte att kontrollera genom att läsa
 * markupen — det måste köras.
 */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";

const html = readFileSync(new URL("../dist/index.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];

/** Laddar sidan med en påhittad "i dag". */
function open(todayIso, { lang = "sv-FI" } = {}) {
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    url: "https://jonatanstorlund.github.io/skolveckan-4f2a9c/",
  });
  const { window } = dom;

  const Real = window.Date;
  const fixed = new Real(`${todayIso}T09:00:00`);
  class Fake extends Real {
    constructor(...args) {
      super(...(args.length ? args : [fixed.getTime()]));
    }
    static now() {
      return fixed.getTime();
    }
  }
  window.Date = Fake;
  Object.defineProperty(window.navigator, "language", { value: lang, configurable: true });

  window.eval(script);
  return window;
}

/** Vilka poster som syns i ett fack, för det barn som visas. */
function itemsIn(window, group, kid = null) {
  const panel = kid
    ? window.document.querySelector(`section.kid[data-kid="${kid}"]`)
    : [...window.document.querySelectorAll("section.kid")].find((p) => !p.hidden);
  const container =
    group === "info"
      ? panel.querySelector('details[data-group="info"]')
      : panel.querySelector(`.group[data-group="${group}"]`);
  if (!container) return [];
  return [...container.querySelectorAll("li[data-kind]")]
    .filter((li) => !li.hidden)
    .map((li) => ({ text: li.querySelector(".what,label span")?.textContent, date: li.dataset.date }));
}

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push(`  PASS  ${name}`);
  } catch (error) {
    results.push(`  FAIL  ${name}\n        ${error.message.split("\n")[0]}`);
    process.exitCode = 1;
  }
};

// --- Fredag 21.8: veckoplaneringens läxor ligger nästa vecka men är nära ---
check("fredag: nästa veckas poster hamnar i närmaste veckan", () => {
  const w = open("2026-08-21");
  // Rullande sju dagar, så tisdagen nästa vecka räknas som nära.
  const week = itemsIn(w, "week", "nellie");
  assert.ok(
    week.some((i) => i.date === "2026-08-25"),
    `nästa veckas post saknas i veckofacket: ${JSON.stringify(week)}`,
  );
});

check("läxor ligger i egen låda, inte i veckan", () => {
  const w = open("2026-08-21");
  // Läxorna var merparten av volymen; de hör ett tryck bort, inte i veckan.
  const week = itemsIn(w, "week", "nellie");
  const panel = w.document.querySelector('section.kid[data-kid="nellie"]');
  const drawer = panel.querySelector('details[data-group="laxor"]');
  assert.ok(drawer, "ingen läxlåda renderades");
  assert.equal(drawer.open, false, "läxlådan var öppen");
  const inDrawer = [...drawer.querySelectorAll('li[data-kind="laxa"]')].filter((li) => !li.hidden);
  assert.ok(inDrawer.length >= 2, `${inDrawer.length} läxor i lådan`);
  for (const li of panel.querySelectorAll('.group[data-group="week"] li[data-kind]')) {
    assert.notEqual(li.dataset.kind, "laxa", "en läxa ligger kvar i veckan");
  }
  assert.equal(Number(drawer.querySelector(".count").textContent), inDrawer.length);
});

check("fredag: inga poster i två fack samtidigt", () => {
  const w = open("2026-08-21");
  for (const panel of w.document.querySelectorAll("section.kid")) {
    const seen = new Set();
    for (const li of panel.querySelectorAll("li[data-kind]")) {
      const id = li.querySelector(".what,label span")?.textContent + "|" + (li.dataset.date ?? "");
      assert.ok(!seen.has(id), `duplicerad post: ${id}`);
      seen.add(id);
    }
  }
});

// --- Måndag 24.8: facken ska ha flyttat sig utan ombyggnad ---
check("måndag: tisdagens post är kvar i veckan, inte i framåt", () => {
  const w = open("2026-08-24");
  const week = itemsIn(w, "week", "nellie");
  const later = itemsIn(w, "later", "nellie");
  assert.ok(week.some((i) => i.date === "2026-08-25"), "tisdagen borde ligga i veckan");
  assert.ok(!later.some((i) => i.date === "2026-08-25"), "tisdagen dubblerades till framåt");
});

check("måndag: förbrukat göms utan att en körning behövts", () => {
  const w = open("2026-09-01");
  const visible = [...w.document.querySelectorAll("section.kid li[data-kind]")].filter(
    (li) => !li.hidden && li.dataset.date && li.dataset.date < "2026-09-01",
  );
  assert.equal(visible.length, 0, `${visible.length} passerade poster syns fortfarande`);
});

// --- Dagsrubriker ---
check("dagsrubriker byggs och är på rätt språk", () => {
  const sv = open("2026-08-21");
  const heads = [...sv.document.querySelectorAll('section.kid[data-kid="nellie"] li.dayhead')].map(
    (li) => li.textContent,
  );
  assert.ok(heads.length > 0, "inga dagsrubriker byggdes");
  assert.ok(
    heads.some((h) => /^tis 25\.8/.test(h)),
    `förväntade "tis 25.8" bland ${JSON.stringify(heads)}`,
  );

  const fi = open("2026-08-21", { lang: "fi-FI" });
  const fiHeads = [...fi.document.querySelectorAll('section.kid[data-kid="nellie"] li.dayhead')].map(
    (li) => li.textContent,
  );
  assert.ok(
    fiHeads.some((h) => /^ti 25\.8/.test(h)),
    `förväntade "ti 25.8" bland ${JSON.stringify(fiHeads)}`,
  );
});

check("dagsrubriker dubbleras inte när språket byts", () => {
  const w = open("2026-08-21");
  const before = w.document.querySelectorAll("li.dayhead").length;
  w.document.querySelector('.lang button[data-lang="fi"]').click();
  w.document.querySelector('.lang button[data-lang="sv"]').click();
  const after = w.document.querySelectorAll("li.dayhead").length;
  assert.equal(after, before, `${before} rubriker blev ${after} efter två språkbyten`);
});

// --- Prov och info ---
check("prov ligger i egen grupp oavsett hur långt bort de är", () => {
  const w = open("2026-08-21");
  const exams = itemsIn(w, "exams", "colin");
  assert.equal(exams.length, 2, `förväntade 2 prov, fick ${JSON.stringify(exams)}`);
  const week = itemsIn(w, "week", "colin");
  assert.ok(!week.some((i) => i.date === "2026-10-07"), "provet läckte in i veckofacket");
});

check("info ligger i en stängd dropdown med rätt antal", () => {
  const w = open("2026-08-21");
  const details = w.document.querySelector(
    'section.kid[data-kid="colin"] details[data-group="info"]',
  );
  assert.ok(details, "ingen info-dropdown");
  assert.equal(details.open, false, "dropdownen var öppen");
  const count = Number(details.querySelector(".count").textContent);
  assert.equal(count, itemsIn(w, "info", "colin").length, "antalet stämmer inte med innehållet");
});

// --- Språk och väljare ---
check("språkbytet växlar allt och minns valet", () => {
  const w = open("2026-08-21");
  const label = () => w.document.querySelector('.group[data-group="week"] .glabel').textContent;
  assert.equal(label(), "Närmaste veckan");
  w.document.querySelector('.lang button[data-lang="fi"]').click();
  assert.equal(label(), "Lähin viikko");
  assert.equal(w.localStorage.getItem("skolveckan.lang"), "fi");
});

check("barnväljaren byter panel och foto", () => {
  const w = open("2026-08-21");
  const select = w.document.getElementById("kid");
  select.value = "colin";
  select.dispatchEvent(new w.Event("change"));
  const shown = [...w.document.querySelectorAll("section.kid")].filter((p) => !p.hidden);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].dataset.kid, "colin");
  const face = [...w.document.querySelectorAll(".face")].filter((f) => !f.hidden);
  assert.equal(face.length, 1);
  assert.equal(face[0].dataset.kid, "colin");
});

check("inga kryssrutor finns kvar", () => {
  const w = open("2026-08-21");
  assert.equal(
    w.document.querySelectorAll('input[type="checkbox"]').length,
    0,
    "kryssrutor smög tillbaka",
  );
});

check("datumet står en gång per dag, inte en gång per rad", () => {
  const w = open("2026-08-21");
  const week = w.document.querySelector(
    'section.kid[data-kid="nellie"] .group[data-group="week"]',
  );
  const heads = [...week.querySelectorAll("li.dayhead")].length;
  assert.ok(heads > 0, "inga dagsrubriker");
  // Chipen finns kvar i DOM:en (posten kan flytta fack) men göms i veckofacket.
  const css = w.document.querySelector("style").textContent;
  assert.match(
    css,
    /\.group\[data-group="week"\] \.when[\s\S]{0,80}display: none/,
    "veckofackets datumchip göms inte",
  );
});

check("texten börjar längst till vänster, etiketten till höger", () => {
  const w = open("2026-08-21");
  const css = w.document.querySelector("style").textContent;
  const meta = [...css.matchAll(/\n  \.meta \{([^}]*)\}/g)];
  assert.equal(meta.length, 1, `${meta.length} .meta-regler — dubbletter kastar layouten`);
  assert.match(meta[0][1], /grid-column: 2/, "högerspalten sitter fel");
  const what = [...css.matchAll(/\n  \.what \{([^}]*)\}/g)];
  assert.equal(what.length, 1, "dubblerad .what-regel");
  assert.match(what[0][1], /grid-column: 1/, "texten börjar inte längst till vänster");
  assert.equal(w.document.querySelectorAll(".icon").length, 0, "ikonkolumnen finns kvar");
});

check("poster i blandade grupper har en färgkodad etikett", () => {
  const w = open("2026-08-21");
  // Engrupper (prov, boka tid) utelämnar etiketten med flit: rubriken säger
  // redan vad raderna är, och etiketten beskattade textkolumnen via subgrid.
  const mixed = [...w.document.querySelectorAll('.group[data-group="week"] li[data-kind]')];
  assert.ok(mixed.length > 0, "inga poster i veckofacket att kontrollera");
  for (const li of mixed) {
    const tag = li.querySelector(".tag-kind");
    assert.ok(tag, `post utan etikett: ${li.textContent.trim().slice(0, 40)}`);
    assert.ok(tag.dataset.tag, "etiketten saknar färgnyckel");
    assert.ok(tag.textContent.trim().length > 0, "tom etikett");
  }
  for (const group of ["exams", "booking"]) {
    for (const li of w.document.querySelectorAll(`.group[data-group="${group}"] li[data-kind]`)) {
      assert.equal(li.querySelector(".tag-kind"), null, `${group} upprepar sin rubrik som etikett`);
    }
  }
  const items = mixed;
  // Etiketten är sista barnet i .meta, så den hamnar längst till höger.
  const meta = items[0].querySelector(".meta");
  assert.equal(meta.lastElementChild.className, "tag-kind", "etiketten ligger inte sist");
  // Bandet ska ha ETT .meta-spann, inte två — två gav en radbruten etikett.
  const band = w.document.querySelector(".shared li");
  if (band) assert.equal(band.querySelectorAll(".meta").length, 1, "bandet har två .meta-spann");

  w.document.querySelector('.lang button[data-lang="fi"]').click();
  const fiTag = items[0].querySelector(".tag-kind").textContent;
  assert.ok(fiTag.length > 0, "etiketten tömdes vid språkbyte");
});

check("bokningar hamnar i eget fack, inte i dropdownen", () => {
  const w = open("2026-08-21");
  const panel = w.document.querySelector("section.kid");
  const booking = panel.querySelector('.group[data-group="booking"]');
  assert.ok(booking, "inget bokningsfack renderades");
});

// --- Åldersvarning ---
check("åldersvarningen är tyst i dag och syns efter tre dygn", () => {
  assert.equal(open("2026-08-21").document.getElementById("stale").hidden, true);
  assert.equal(open("2026-08-26").document.getElementById("stale").hidden, false);
});

check("relativa datum räknas om mot dagens datum", () => {
  // Måste vara en rad i veckan: lådornas rader visar med flit ingen relativ text.
  const w = open("2026-08-24");
  const rel = [...w.document.querySelectorAll(".rel[data-date]")].find(
    (el) => el.dataset.date === "2026-08-25",
  );
  assert.ok(rel, "hittade ingen relativ etikett på en veckorad");
  assert.equal(rel.textContent, "imorgon", `fick "${rel.textContent}"`);
});

check("inga helgdatum finns kvar i datan", () => {
  const w = open("2026-08-21");
  const weekend = [...w.document.querySelectorAll("li[data-date]")]
    .map((li) => li.dataset.date)
    .filter((d) => [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()));
  assert.deepEqual([...new Set(weekend)], [], "helgdaterade poster kvar");
});

check("passerade prov göms som allt annat passerat", () => {
  const w = open("2026-10-20");
  const visible = [...w.document.querySelectorAll('li[data-kind="prov"]')].filter((li) => !li.hidden);
  const past = visible.filter((li) => li.dataset.date < "2026-10-20");
  assert.deepEqual(
    past.map((li) => li.dataset.date),
    [],
    "ett prov som varit syns fortfarande",
  );
});

check("gemensamma bandet göms när dess datum passerat", () => {
  const w = open("2026-10-20");
  const shared = w.document.querySelector(".shared");
  if (!shared) return;
  const visible = [...shared.querySelectorAll("li")].filter((li) => !li.hidden);
  assert.equal(visible.length, 0, "passerad gemensam post syns fortfarande");
  assert.equal(shared.hidden, true, "tomt band tar fortfarande plats");
});

check("tomma veckan pekar på bandet redan vid första laddningen", () => {
  // Ordningsbuggen: bandet gömdes efter regroup, så puffen pekade på en sektion
  // som inte fanns förrän någon råkade byta språk.
  const w = open("2026-08-26");
  for (const panel of w.document.querySelectorAll("section.kid")) {
    const week = panel.querySelector('.group[data-group="week"]');
    const live = [...week.querySelectorAll("li[data-kind]")].filter((li) => !li.hidden);
    if (live.length > 0) continue;
    const hint = week.querySelector(".empty.shared-hint");
    const shared = w.document.querySelector(".shared");
    const bandLive = shared && !shared.hidden;
    assert.equal(
      hint.hidden,
      !bandLive,
      `puffen mot bandet är ${hint.hidden ? "gömd" : "synlig"} men bandet är ${bandLive ? "synligt" : "gömt"}`,
    );
  }
});

console.log(results.join("\n"));
console.log(
  process.exitCode
    ? `\n${results.filter((r) => r.includes("FAIL")).length} test föll.`
    : `\nAlla ${results.length} test gick igenom.`,
);
