/**
 * Renderar site/oversikt.html ur data/oversikt.json.
 *
 * Två saker att veta om upplägget:
 *
 * 1. SV och FI kommer ur samma post, så en rad kan inte finnas på ett språk och
 *    saknas på det andra. STRINGS-tabellen genereras, och site/build.mjs vaktar
 *    pariteten.
 * 2. Posterna placeras i fack både här och i webbläsaren. Här, för att sidan ska
 *    vara läsbar utan JS; i webbläsaren, för att "denna vecka" ska betyda den här
 *    veckan även dagen efter att sidan byggdes.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

const data = JSON.parse(readFileSync(path.join(root, "data", "oversikt.json"), "utf8"));
const css = readFileSync(path.join(here, "style.css"), "utf8").trimEnd();

/**
 * En textetikett i stället för en emoji. 12,8 px emoji var tre likadana fläckar,
 * och den kostade hela första kolumnen — nu börjar titeln längst till vänster.
 *
 * `palette` grupperar slagen i sex färger; fler hade blivit fruktsallad.
 */
const TAGS = {
  ta_med: { sv: "Ta med", fi: "Mukaan", palette: "bring" },
  laxa: { sv: "Läxa", fi: "Läksy", palette: "home" },
  deadline: { sv: "Deadline", fi: "Määräaika", palette: "do" },
  bokning: { sv: "Boka tid", fi: "Varaa aika", palette: "do" },
  betalning: { sv: "Betalning", fi: "Maksu", palette: "bring" },
  andrad_tid: { sv: "Tid", fi: "Aika", palette: "time" },
  ingen_skola: { sv: "Ledigt", fi: "Vapaa", palette: "time" },
  evenemang: { sv: "Händelse", fi: "Tapahtuma", palette: "event" },
  prov: { sv: "Prov", fi: "Koe", palette: "event" },
  info: { sv: "Info", fi: "Tieto", palette: "info" },
};

/**
 * Två meddelanden om samma sak ger två poster med olika ordalydelse:
 * "Skoldag kl. 8.15-12.00 måndag till onsdag" och "Skoldag kl. 8.15-12
 * måndag-onsdag". Exakt textnyckel ser dem som skilda. Här jämförs innehållet.
 */
const words = (s) =>
  new Set(
    String(s)
      .toLowerCase()
      .replace(/[\d.:]+/g, " ")
      .replace(/[^a-zåäöü\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );

function nearDuplicate(a, b) {
  if (a.kind !== b.kind || a.date !== b.date) return false;
  const x = words(a.sv.text);
  const y = words(b.sv.text);
  if (x.size === 0 || y.size === 0) return false;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  // Jaccard över 0,5 betyder att raderna säger samma sak med andra ord.
  return shared / (x.size + y.size - shared) > 0.5;
}

/** Behåll den senaste versionen av varje sak — högst messageId är nyast. */
function dedupe(items) {
  const kept = [];
  for (const item of items) {
    const clash = kept.findIndex((other) => nearDuplicate(other, item));
    if (clash === -1) {
      kept.push(item);
      continue;
    }
    if ((item.messageId ?? 0) > (kept[clash].messageId ?? 0)) kept[clash] = item;
  }
  return kept;
}

/** Grupper med ett enda slag: rubriken säger vad raderna är. */
const SINGLE_KIND_GROUPS = new Set(["exams", "booking"]);

function tagMarkup(kind) {
  const tag = TAGS[kind] ?? TAGS.info;
  const k = key(tag.sv, tag.fi, "tag");
  return `<span class="tag-kind" data-tag="${tag.palette}" data-t="${k}">${esc(tag.sv)}</span>`;
}

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

const js = (s) => JSON.stringify(String(s ?? "")).replace(/</g, "\\u003c");

// --- Strängtabellen byggs upp medan markupen skrivs -----------------------

const strings = { sv: {}, fi: {} };
let counter = 0;

function key(sv, fi, hint = "t") {
  const name = `${hint}${counter++}`;
  strings.sv[name] = sv ?? "";
  strings.fi[name] = fi ?? "";
  return name;
}

function text(tag, cls, sv, fi, hint) {
  // Båda eller inget: en not som bara finns på ett språk blir en tom rad för den
  // som läser det andra.
  if (!sv || !fi) return "";
  const k = key(sv, fi, hint);
  return `<${tag}${cls ? ` class="${cls}"` : ""} data-t="${k}">${esc(sv)}</${tag}>`;
}

// --- Datum ---------------------------------------------------------------

const SV_DAYS = ["sön", "mån", "tis", "ons", "tor", "fre", "lör"];
const FI_DAYS = ["su", "ma", "ti", "ke", "to", "pe", "la"];

const weekdayOf = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();

function dateLabels(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const wd = weekdayOf(iso);
  return { sv: `${SV_DAYS[wd]} ${d}.${m}`, fi: `${FI_DAYS[wd]} ${d}.${m}.` };
}

/**
 * Rullande sju dagar, inte "till och med söndag".
 *
 * Kalenderveckan låter riktigare men blir tom just när man behöver den: på en
 * fredag hamnar hela nästa veckas läxor utanför, och veckoplaneringen kommer
 * på fredagar. Sju dagar framåt innehåller alltid det som är nära.
 */
const TODAY = data.stamp;
const WEEK_END = (() => {
  const end = new Date(`${TODAY}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 7);
  return end.toISOString().slice(0, 10);
})();

/** Samma indelning som webbläsaren gör; här bara för utgångsläget. */
function bucketOf(item) {
  if (item.date && item.date < TODAY) return "past";
  if (item.kind === "laxa") return "laxor";
  if (item.kind === "bokning") return "booking";
  if (!item.date) return "info";
  // info hamnar alltid i dropdownen, även daterad: en upplysning är inte en
  // uppgift, och de var halva sidans volym.
  if (item.kind === "info") return "info";
  if (item.date <= WEEK_END) return "week";
  return "later";
}

// --- Poster --------------------------------------------------------------

/** Rad i en fällbar låda: bara texten och datumet. Ingen etikett, ingen not. */
function plainMarkup(item) {
  const k = key(item.sv.text, item.fi.text, "i");
  let when = "";
  if (item.date) {
    const l = dateLabels(item.date);
    const wk = key(item.sv.dateLabel || l.sv, item.fi.dateLabel || l.fi, "w");
    when = `<span class="meta"><span class="when" data-t="${wk}">${esc(item.sv.dateLabel || l.sv)}</span></span>`;
  }
  return (
    `<li data-kind="${esc(item.kind)}"${item.date ? ` data-date="${esc(item.date)}"` : ""}>` +
    `<span class="what" data-t="${k}">${esc(item.sv.text)}</span>${when}</li>`
  );
}

function itemMarkup(item) {
  const k = key(item.sv.text, item.fi.text, "i");

  const label = `<span class="what" data-t="${k}">${esc(item.sv.text)}</span>`;

  const bits = [];
  if (item.date) {
    const l = dateLabels(item.date);
    const wk = key(item.sv.dateLabel || l.sv, item.fi.dateLabel || l.fi, "w");
    bits.push(`<span class="when" data-t="${wk}">${esc(item.sv.dateLabel || l.sv)}</span>`);
    bits.push(`<span class="rel" data-date="${esc(item.date)}"></span>`);
  }
  if (item.time) {
    const tk = key(item.time, item.time, "w");
    bits.push(`<span class="at" data-t="${tk}">${esc(item.time)}</span>`);
  }
  // Etiketten sist i raden, så den hamnar längst till höger även när datumet
  // och den relativa texten radbryter. Utelämnas i engrupper: där upprepar den
  // bara rubriken och beskattar textkolumnen via subgrid.
  if (!SINGLE_KIND_GROUPS.has(bucketOf(item))) bits.push(tagMarkup(item.kind));
  const note = text("p", "note", item.sv.note, item.fi.note, "n");

  return (
    `<li data-kind="${esc(item.kind)}"${item.date ? ` data-date="${esc(item.date)}"` : ""}>` +
    `${label}<span class="meta">${bits.join("")}</span>${note}</li>`
  );
}

function examItem(exam) {
  const l = dateLabels(exam.date);
  const k = key(exam.subject, exam.subject, "e");
  const wk = key(l.sv, l.fi, "w");
  return (
    `<li data-kind="prov" data-date="${esc(exam.date)}">` +
    `<span class="what" data-t="${k}">${esc(exam.subject)}</span>` +
    `<span class="meta"><span class="when" data-t="${wk}">${esc(l.sv)}</span>` +
    `<span class="rel" data-date="${esc(exam.date)}"></span></span></li>`
  );
}

function group(name, labelSv, labelFi, rows, extra = "") {
  const hidden = rows.length === 0 && name !== "week" ? " hidden" : "";
  return (
    `      <section class="group" data-group="${name}"${hidden}>\n` +
    `        ${text("h3", "glabel", labelSv, labelFi, "g")}\n` +
    `        <ul>${rows.join("")}</ul>\n${extra}` +
    `      </section>`
  );
}

/**
 * Närhetssteg. Samma trappa i renderaren och i webbläsaren, så chipet har samma
 * färg före och efter att skriptet kört.
 */
function proximity(days) {
  if (days < 0) return "past";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days <= 3) return "near";
  if (days <= 7) return "week";
  return "later";
}

/** Dagsrubrik i samma form som webbläsaren bygger, för läsbarhet utan JS. */
function dayHeadMarkup(iso) {
  const l = dateLabels(iso);
  const days = Math.round(
    (Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${TODAY}T00:00:00Z`)) / 86400000,
  );
  const state = proximity(days);
  const relSv = days === 0 ? "idag" : days === 1 ? "imorgon" : `om ${days} dagar`;
  const relFi = days === 0 ? "tänään" : days === 1 ? "huomenna" : `${days} päivän päästä`;
  const dk = key(l.sv, l.fi, "d");
  const rk = key(relSv, relFi, "d");
  return (
    `<li class="dayhead" data-prox="${state}" data-t="${dk}">${esc(l.sv)}` +
    `<span class="dayrel" data-state="${state}" data-t="${rk}">${esc(relSv)}</span></li>`
  );
}

/** Tak på veckan: sidan finns för att vara kort. Resten hamnar i dropdownen. */
const WEEK_LIMIT = 4;
/** Tak på lådorna. Utan tak blir de en andra sida i stället för ett uppslag. */
const DRAWER_LIMIT = 6;

function childMarkup(child, first) {
  const buckets = { week: [], booking: [], laxor: [], later: [], exams: [], info: [] };
  const items = dedupe(child.items);

  const weekAll = items
    .filter((item) => bucketOf(item) === "week")
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const weekItems = weekAll.slice(0, WEEK_LIMIT);
  const overflow = weekAll.slice(WEEK_LIMIT);
  let lastDate = null;
  for (const item of weekItems) {
    if (item.date !== lastDate) {
      lastDate = item.date;
      buckets.week.push(dayHeadMarkup(item.date));
    }
    buckets.week.push(itemMarkup(item));
  }

  // Lådorna får enkla rader; veckan, prov och framåt behåller etiketterna.
  items.forEach((item) => {
    const bucket = bucketOf(item);
    if (bucket === "past" || bucket === "week") return;
    buckets[bucket].push(bucket === "info" || bucket === "laxor" ? plainMarkup(item) : itemMarkup(item));
  });
  for (const item of overflow) buckets.info.push(plainMarkup(item));
  buckets.info = buckets.info.slice(0, DRAWER_LIMIT);
  buckets.laxor = buckets.laxor.slice(0, DRAWER_LIMIT);
  child.exams.forEach((exam) => buckets.exams.push(examItem(exam)));

  // hidden som standard: JS visar den som stämmer. Tvärtom gav två motsägande
  // rader under en fylld lista när skriptet inte kördes.
  const emptyKey = key(
    "Inget på gång den närmaste veckan",
    "Ei mitään lähimmän viikon aikana",
    "g",
  );
  const hintKey = key(
    "Inget eget den här veckan — se Gäller båda längst ner",
    "Ei omia tällä viikolla — katso Koskee molempia alhaalta",
    "g",
  );
  const emptyWeek =
    `        <p class="empty" data-t="${emptyKey}"${weekItems.length ? " hidden" : ""}>` +
    `${esc(strings.sv[emptyKey])}</p>\n` +
    `        <p class="empty shared-hint" data-t="${hintKey}" hidden>${esc(strings.sv[hintKey])}</p>\n`;

  const laxorSection =
    buckets.laxor.length === 0
      ? ""
      : `      <details class="group" data-group="laxor">\n` +
        `        <summary>${text("span", "glabel", "Läxor", "Läksyt", "g")}` +
        ` <span class="count">${buckets.laxor.length}</span></summary>\n` +
        `        <ul>${buckets.laxor.join("")}</ul>\n` +
        `      </details>`;

  const infoSection =
    buckets.info.length === 0
      ? ""
      : `      <details class="group" data-group="info">\n` +
        `        <summary>${text("span", "glabel", "Bra att veta", "Hyvä tietää", "g")}` +
        ` <span class="count">${buckets.info.length}</span></summary>\n` +
        `        <ul>${buckets.info.join("")}</ul>\n` +
        `      </details>`;

  return [
    `    <section class="kid" data-kid="${esc(child.slug)}"${first ? "" : " hidden"}>`,
    `      <h2 class="sr-only">${esc(child.name)}</h2>`,
    `      <p class="where">${esc(child.school)} · ${esc(child.className)}</p>`,
    group("week", "Närmaste veckan", "Lähin viikko", buckets.week, emptyWeek),
    group("booking", "Boka tid", "Varaa aika", buckets.booking),
    group("later", "Viktiga datum", "Tärkeät päivät", buckets.later),
    group("exams", "Prov", "Kokeet", buckets.exams),
    laxorSection,
    infoSection,
    `    </section>`,
  ]
    .filter(Boolean)
    .join("\n");
}

function sharedMarkup(shared) {
  const live = shared.filter((item) => !item.date || item.date >= TODAY);
  if (live.length === 0) return "";
  const rows = live.map((item) => {
    const k = key(item.sv.text, item.fi.text, "s");
    const bits = [`<span class="what" data-t="${k}">${esc(item.sv.text)}</span>`];
    // Ett .meta-spann, inte två: två fick etiketten att radbryta till en egen
    // rad med ett hål till vänster, och gjorde bandets rad dubbelt så hög.
    const metaBits = [];
    if (item.date) {
      const l = dateLabels(item.date);
      const wk = key(item.sv.dateLabel || l.sv, item.fi.dateLabel || l.fi, "w");
      metaBits.push(`<span class="when" data-t="${wk}">${esc(item.sv.dateLabel || l.sv)}</span>`);
      metaBits.push(`<span class="rel" data-date="${esc(item.date)}"></span>`);
    }
    metaBits.push(tagMarkup(item.kind ?? "info"));
    bits.push(`<span class="meta">${metaBits.join("")}</span>`);
    const note = text("p", "note", item.sv.note, item.fi.note, "n");
    return (
      `<li data-kind="${esc(item.kind ?? "info")}"${item.date ? ` data-date="${esc(item.date)}"` : ""}>` +
      `${bits.join("")}${note}</li>`
    );
  });

  return (
    `  <section class="shared">\n` +
    `    ${text("p", "tag", "Gäller båda", "Koskee molempia", "s")}\n` +
    `    <ul>${rows.join("")}</ul>\n  </section>`
  );
}

// --- Sidan ---------------------------------------------------------------

const photoDir = path.join(here, "photos");
const photos = new Map(
  readdirSync(photoDir)
    .filter((f) => f.endsWith(".jpg"))
    .map((f) => [path.basename(f, ".jpg"), readFileSync(path.join(photoDir, f)).toString("base64")]),
);

const stampKey = key(`Uppdaterad ${data.stamp}`, `Päivitetty ${data.stamp}`, "hdr");
const titleKey = key("Skolveckan hemma", "Kouluviikko kotona", "hdr");
const langKey = key("Språk", "Kieli", "hdr");
const pickerKey = key("Barn", "Lapset", "hdr");
const abandonedCount = (data.abandoned ?? []).length;
const abandonedKey = key(
  abandonedCount === 1
    ? "En källa kunde inte läsas och har getts upp — kolla Wilma själv."
    : `${abandonedCount} källor kunde inte läsas och har getts upp — kolla Wilma själv.`,
  abandonedCount === 1
    ? "Yhtä lähdettä ei voitu lukea ja se on hylätty — tarkista Wilma itse."
    : `${abandonedCount} lähdettä ei voitu lukea ja ne on hylätty — tarkista Wilma itse.`,
  "hdr",
);
const staleKey = key(
  "Sidan har inte uppdaterats på flera dygn — körningen kan ha slutat fungera.",
  "Sivua ei ole päivitetty useaan päivään — ajo voi olla rikki.",
  "hdr",
);

const faces = data.children
  .map(
    (child, i) =>
      `    <img class="face" data-kid="${esc(child.slug)}" alt="" src="data:image/jpeg;base64,${photos.get(child.slug) ?? ""}"${i === 0 ? "" : " hidden"} />`,
  )
  .join("\n");

const options = data.children
  .map((child) => `      <option value="${esc(child.slug)}">${esc(child.name)}</option>`)
  .join("\n");

const panels = data.children.map((child, i) => childMarkup(child, i === 0)).join("\n\n");
const shared = sharedMarkup(data.shared);

const table = (entries) =>
  Object.entries(entries)
    .map(([k, v]) => `        ${k}: ${js(v)},`)
    .join("\n");

const page = `<title>Skolveckan hemma</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  rel="stylesheet"
  href="https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@600&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap"
/>

<style>
${css}
</style>

<div class="board">
  <header>
    <p class="eyebrow" data-t="${stampKey}">${esc(strings.sv[stampKey])}</p>
    <div class="lang" role="group" data-t-label="${langKey}" aria-label="Språk">
      <button type="button" data-lang="sv" aria-pressed="true">SV</button>
      <button type="button" data-lang="fi" aria-pressed="false">FI</button>
    </div>
    <h1 class="sr-only" data-t="${titleKey}">Skolveckan hemma</h1>
  </header>

  <p class="stale" id="stale" data-t="${staleKey}" hidden></p>
${
  abandonedCount
    ? `  <p class="stale" data-t="${abandonedKey}">${esc(strings.sv[abandonedKey])}</p>`
    : ""
}

  <div class="picker" data-kid="${esc(data.children[0]?.slug ?? "")}">
${faces}
    <label class="sr-only" for="kid" data-t="${pickerKey}">Barn</label>
    <select id="kid" disabled>
${options}
    </select>
  </div>

  <noscript>
    <p class="empty">Utan JavaScript visas bara det första barnet.</p>
  </noscript>

  <div class="panels">
${panels}
  </div>

${shared}
</div>

<script>
  (function () {
    const STAMP = ${js(data.stamp)};
    const STRINGS = {
      sv: {
${table(strings.sv)}
      },
      fi: {
${table(strings.fi)}
      },
    };
    const WORDS = {
      sv: {
        days: ["sön", "mån", "tis", "ons", "tor", "fre", "lör"],
        today: "idag",
        tomorrow: "imorgon",
        yesterday: "igår",
        inDays: (n) => \`om \${n} dagar\`,
        agoDays: (n) => \`\${n} dagar sedan\`,
      },
      fi: {
        days: ["su", "ma", "ti", "ke", "to", "pe", "la"],
        today: "tänään",
        tomorrow: "huomenna",
        yesterday: "eilen",
        inDays: (n) => \`\${n} päivän päästä\`,
        agoDays: (n) => \`\${n} päivää sitten\`,
      },
    };

    const LANG_KEY = "skolveckan.lang";
    const KID_KEY = "skolveckan.kid";

    const store = {
      get(key, fallback) {
        try {
          const raw = localStorage.getItem(key);
          return raw === null ? fallback : raw;
        } catch (e) {
          return fallback;
        }
      },
      set(key, value) {
        try {
          localStorage.setItem(key, value);
        } catch (e) {
          /* privat läge — sidan fungerar, den minns bara inte */
        }
      },
    };

    const iso = (d) =>
      \`\${d.getFullYear()}-\${String(d.getMonth() + 1).padStart(2, "0")}-\${String(d.getDate()).padStart(2, "0")}\`;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayIso = iso(today);

    // Rullande sju dagar — se kommentaren i render.mjs om varför inte kalendervecka.
    const weekEnd = new Date(today);
    weekEnd.setDate(weekEnd.getDate() + 7);
    const weekEndIso = iso(weekEnd);

    const daysFrom = (isoDate) => Math.round((new Date(isoDate + "T00:00:00") - today) / 86400000);

    /** En trappa, tre användare. Samma steg som proximity() i render.mjs. */
    function proximity(days) {
      if (days < 0) return "past";
      if (days === 0) return "today";
      if (days === 1) return "tomorrow";
      if (days <= 3) return "near";
      if (days <= 7) return "week";
      return "later";
    }

    /**
     * Vilket fack en post hör till I DAG. Renderaren placerade den en gång, men
     * sidan lever vidare i dagar — därför räknas facket om vid varje visning.
     */
    function bucketFor(li) {
      const date = li.dataset.date;
      // Passerat först: ett prov som varit ska gömmas som allt annat som varit.
      if (date && date < todayIso) return "past";
      if (li.dataset.kind === "prov") return "exams";
      if (li.dataset.kind === "laxa") return "laxor";
      if (li.dataset.kind === "bokning") return "booking";
      // Speglar bucketOf() i render.mjs. Avvek de, flyttade omgrupperingen
      // tillbaka det renderaren just hade sorterat bort.
      if (li.dataset.kind === "info") return "info";
      if (!date) return "info";
      if (date <= weekEndIso) return "week";
      return "later";
    }

    /* Inom en dag: packa väskan före läxan. Ordningen speglar morgonen. */
    const KIND_RANK = ["ta_med", "laxa", "betalning", "deadline", "andrad_tid", "ingen_skola", "evenemang", "bokning", "info"];
    const rankOf = (li) => {
      const i = KIND_RANK.indexOf(li.dataset.kind);
      return i === -1 ? KIND_RANK.length : i;
    };

    function regroup(panel, words) {
      const groups = {
        week: panel.querySelector('.group[data-group="week"]'),
        booking: panel.querySelector('.group[data-group="booking"]'),
        later: panel.querySelector('.group[data-group="later"]'),
        exams: panel.querySelector('.group[data-group="exams"]'),
        laxor: panel.querySelector('details[data-group="laxor"]'),
        info: panel.querySelector('details[data-group="info"]'),
      };

      for (const li of panel.querySelectorAll("li[data-kind]")) {
        const target = bucketFor(li);
        if (target === "past") {
          li.hidden = true;
          continue;
        }
        li.hidden = false;
        const list = groups[target] && groups[target].querySelector("ul");
        if (list && li.parentElement !== list) list.append(li);
      }

      // Dagsrubriker byggs av JS, så de aldrig blir gamla.
      const weekList = groups.week && groups.week.querySelector("ul");
      if (weekList) {
        for (const old of [...weekList.querySelectorAll("li.dayhead")]) old.remove();
        const live = [...weekList.querySelectorAll("li[data-kind]")].filter((li) => !li.hidden);
        live.sort(
          (a, b) =>
            (a.dataset.date || "").localeCompare(b.dataset.date || "") || rankOf(a) - rankOf(b),
        );
        // Taket sätts HÄR, inte bara vid rendering: omgrupperingen kör vid varje
        // visning och tog annars tillbaka precis det renderaren sorterat bort.
        const WEEK_LIMIT = 4;
        const infoList = groups.info && groups.info.querySelector("ul");
        const shown = live.slice(0, WEEK_LIMIT);
        if (infoList) for (const li of live.slice(WEEK_LIMIT)) infoList.append(li);

        let lastDate = null;
        for (const li of shown) {
          weekList.append(li);
          if (li.dataset.date !== lastDate) {
            lastDate = li.dataset.date;
            const head = document.createElement("li");
            head.className = "dayhead";
            const parts = lastDate.split("-").map(Number);
            const wd = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])).getUTCDay();
            head.textContent = words.days[wd] + " " + parts[2] + "." + parts[1];
            const days = daysFrom(lastDate);
            head.dataset.prox = proximity(days);
            const rel =
              days === 0
                ? words.today
                : days === 1
                  ? words.tomorrow
                  : days > 0
                    ? words.inDays(days)
                    : null;
            if (rel) {
              const span = document.createElement("span");
              span.className = "dayrel";
              // Tillståndet är det som gör i dag och imorgon typografiskt högre —
              // utan det såg "idag" ut precis som "om 20 dagar".
              span.dataset.state = proximity(days);
              span.textContent = rel;
              head.append(span);
            }
            weekList.insertBefore(head, li);
          }
        }
        const sharedBand = document.querySelector(".shared");
        const sharedLive =
          Boolean(sharedBand) &&
          !sharedBand.hidden &&
          [...sharedBand.querySelectorAll("li")].some((li) => !li.hidden);
        const plain = groups.week.querySelector(".empty:not(.shared-hint)");
        const hint = groups.week.querySelector(".empty.shared-hint");
        if (plain) plain.hidden = shown.length > 0 || sharedLive;
        if (hint) hint.hidden = shown.length > 0 || !sharedLive;
      }

      for (const name of ["booking", "later", "exams"]) {
        const g = groups[name];
        if (!g) continue;
        g.hidden = ![...g.querySelectorAll("li[data-kind]")].some((li) => !li.hidden);
      }
      for (const name of ["laxor", "info"]) {
        const g = groups[name];
        if (!g) continue;
        const live = [...g.querySelectorAll("li[data-kind]")].filter((li) => !li.hidden);
        g.hidden = live.length === 0;
        const count = g.querySelector(".count");
        if (count) count.textContent = String(live.length);
      }
    }

    function renderDates(words) {
      for (const el of document.querySelectorAll(".rel[data-date]")) {
        const days = daysFrom(el.dataset.date);
        const state = proximity(days);
        const row = el.closest("li");
        if (row && !row.classList.contains("dayhead")) row.dataset.prox = state;
        el.textContent =
          days === 0
            ? words.today
            : days === 1
              ? words.tomorrow
              : days === -1
                ? words.yesterday
                : days < 0
                  ? words.agoDays(Math.abs(days))
                  : words.inDays(days);
        el.dataset.state = state;
      }
    }

    const stale = document.getElementById("stale");
    // Fredagsbygge läst på måndag är -3 och helt normalt — sidan byggs på
    // fredagar just därför. Varna först vid fyra dygn.
    if (stale) stale.hidden = daysFrom(STAMP) > -4;

    function setLang(lang) {
      const tableFor = STRINGS[lang] || STRINGS.sv;
      const words = WORDS[lang] || WORDS.sv;
      for (const el of document.querySelectorAll("[data-t]")) {
        const value = tableFor[el.dataset.t];
        if (typeof value === "string") el.textContent = value;
      }
      for (const el of document.querySelectorAll("[data-t-label]")) {
        const value = tableFor[el.dataset.tLabel];
        if (typeof value === "string") el.setAttribute("aria-label", value);
      }
      document.documentElement.lang = lang;
      renderDates(words);
      // Bandet först: regroup() läser dess synlighet för att avgöra om den tomma
      // veckan ska peka nedåt, så ordningen är inte valfri.
      const shared = document.querySelector(".shared");
      if (shared) {
        for (const li of shared.querySelectorAll("li[data-date]")) {
          li.hidden = li.dataset.date < todayIso;
        }
        shared.hidden = ![...shared.querySelectorAll("li")].some((li) => !li.hidden);
      }
      for (const panel of document.querySelectorAll("section.kid")) regroup(panel, words);
      for (const button of document.querySelectorAll(".lang button")) {
        button.setAttribute("aria-pressed", String(button.dataset.lang === lang));
      }
      store.set(LANG_KEY, lang);
    }

    for (const button of document.querySelectorAll(".lang button")) {
      button.addEventListener("click", () => setLang(button.dataset.lang));
    }

    const savedLang = store.get(LANG_KEY, null);
    const guess = (navigator.language || "sv").toLowerCase().startsWith("fi") ? "fi" : "sv";
    setLang(savedLang === "fi" || savedLang === "sv" ? savedLang : guess);

    // --- Barnväljare ---
    const picker = document.querySelector(".picker");
    const select = document.getElementById("kid");
    // Avstängd i markupen, påslagen här: CSS kan inte stänga av en kontroll för
    // tangentbordet, så utan JS ska den vara genuint disabled.
    select.disabled = false;
    const faceList = [...document.querySelectorAll(".face")];
    const panels = [...document.querySelectorAll("section.kid")];
    const kids = panels.map((panel) => panel.dataset.kid);

    function setKid(kid) {
      for (const face of faceList) face.hidden = face.dataset.kid !== kid;
      for (const panel of panels) panel.hidden = panel.dataset.kid !== kid;
      picker.dataset.kid = kid;
      select.value = kid;
      store.set(KID_KEY, kid);
    }

    select.addEventListener("change", () => setKid(select.value));

    const savedKid = store.get(KID_KEY, null);
    setKid(kids.includes(savedKid) ? savedKid : kids[0]);

  })();
</script>
`;

writeFileSync(path.join(here, "oversikt.html"), page);

const counts = data.children
  .map((c) => {
    const b = { week: 0, later: 0, info: 0 };
    for (const item of c.items) {
      const bucket = bucketOf(item);
      if (bucket in b) b[bucket] += 1;
    }
    return `${c.name} ${b.week}v/${b.later}fram/${c.exams.length}prov/${b.info}info`;
  })
  .join(" · ");

console.log(`site/oversikt.html — ${Object.keys(strings.sv).length} texter x2 — ${counts}`);
