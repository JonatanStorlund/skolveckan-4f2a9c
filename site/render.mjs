/**
 * Renderar site/oversikt.html ur data/oversikt.json.
 *
 * Sidan var handskriven fram till nu. Poängen med att generera den är inte att
 * spara skrivande, utan att SV och FI kommer ur samma post: en rad kan inte
 * finnas på ett språk och saknas på det andra.
 *
 * STRINGS-tabellen och data-t-nycklarna behålls, så site/build.mjs kan fortsätta
 * vakta språkpariteten precis som förut.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

const data = JSON.parse(readFileSync(path.join(root, "data", "oversikt.json"), "utf8"));
const css = readFileSync(path.join(here, "style.css"), "utf8").trimEnd();

const ICONS = {
  ta_med: "🎒",
  deadline: "✍️",
  ingen_skola: "🚫",
  andrad_tid: "🕒",
  evenemang: "📍",
  betalning: "💳",
  info: "ℹ️",
  laxa: "📖",
  prov: "📝",
};

/** Poster man kan bli klar med förtjänar en kryssruta; ren information gör inte. */
const CHECKABLE = new Set(["ta_med", "deadline", "betalning", "laxa"]);

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

/** JS-strängliteral, säker att bädda in i <script>. */
const js = (s) => JSON.stringify(String(s ?? "")).replace(/</g, "\\u003c");

// --- Strängtabellen byggs upp medan markupen skrivs -----------------------

const strings = { sv: {}, fi: {} };
let counter = 0;

/** Registrerar ett textpar och returnerar dess data-t-nyckel. */
function key(sv, fi, hint = "t") {
  const name = `${hint}${counter++}`;
  strings.sv[name] = sv ?? "";
  strings.fi[name] = fi ?? "";
  return name;
}

/** Ett textelement med nyckel; utelämnas helt om texten är tom. */
function text(tag, cls, sv, fi, hint) {
  if (!sv && !fi) return "";
  const k = key(sv, fi, hint);
  const attrs = cls ? ` class="${cls}"` : "";
  return `<${tag}${attrs} data-t="${k}">${esc(sv)}</${tag}>`;
}

// --- Datum ---------------------------------------------------------------

const SV_DAYS = ["sön", "mån", "tis", "ons", "tor", "fre", "lör"];
const FI_DAYS = ["su", "ma", "ti", "ke", "to", "pe", "la"];

/** "2026-10-07" -> { sv: "ons 7.10", fi: "ke 7.10." } */
function dateLabels(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return {
    sv: `${SV_DAYS[weekday]} ${d}.${m}`,
    fi: `${FI_DAYS[weekday]} ${d}.${m}.`,
  };
}

// --- Delar ---------------------------------------------------------------

function itemMarkup(item, index, scope) {
  const icon = ICONS[item.kind] ?? "•";
  const checkable = CHECKABLE.has(item.kind);
  const rows = [];

  const k = key(item.sv.text, item.fi.text, "i");
  // Kryssrutans id måste överleva en omrendering, annars nollställs bocken.
  const id = `${scope}-${item.messageId}-${index}`;
  rows.push(`          <span class="icon">${icon}</span>`);
  rows.push(
    checkable
      ? `          <label class="what"><input type="checkbox" data-id="${esc(id)}" /><span data-t="${k}">${esc(item.sv.text)}</span></label>`
      : `          <span class="what" data-t="${k}">${esc(item.sv.text)}</span>`,
  );

  if (item.date || item.time) {
    const labels = item.date ? dateLabels(item.date) : null;
    const parts = [];
    if (labels) {
      const svLabel = item.sv.dateLabel || labels.sv;
      const fiLabel = item.fi.dateLabel || labels.fi;
      const wk = key(item.time ? `${svLabel} ${item.time}` : svLabel,
                     item.time ? `${fiLabel} ${item.time}` : fiLabel, "w");
      parts.push(`<span class="when" data-t="${wk}">${esc(svLabel)}${item.time ? " " + esc(item.time) : ""}</span>`);
      parts.push(`<span class="rel" data-date="${esc(item.date)}"></span>`);
    } else {
      const wk = key(item.time, item.time, "w");
      parts.push(`<span class="when" data-t="${wk}">${esc(item.time)}</span>`);
    }
    rows.push(`          <div class="meta">${parts.join("")}</div>`);
  }

  const note = text("p", "caveat", item.sv.note, item.fi.note, "n");
  if (note) rows.push(`          ${note}`);

  return `        <li${item.kind === "prov" ? ' class="exam"' : ""}>\n${rows.join("\n")}\n        </li>`;
}

function examMarkup(exam, index, slug) {
  const labels = dateLabels(exam.date);
  const k = key(`Prov: ${exam.subject}`, `Koe: ${exam.subject}`, "e");
  const wk = key(labels.sv, labels.fi, "w");
  return [
    `        <li class="exam">`,
    `          <span class="icon">${ICONS.prov}</span>`,
    `          <span class="what" data-t="${k}">Prov: ${esc(exam.subject)}</span>`,
    `          <div class="meta"><span class="when" data-t="${wk}">${esc(labels.sv)}</span>`,
    `            <span class="rel" data-date="${esc(exam.date)}"></span></div>`,
    `        </li>`,
  ].join("\n");
}

function childMarkup(child, first) {
  const items = child.items.map((item, i) => itemMarkup(item, i, child.slug));
  const exams = child.exams.map((exam, i) => examMarkup(exam, i, child.slug));

  if (items.length === 0 && exams.length === 0) {
    items.push(
      [
        `        <li>`,
        `          <span class="icon">${ICONS.info}</span>`,
        `          ${text("span", "what", "Inget att göra just nu", "Ei tehtävää juuri nyt", "i")}`,
        `        </li>`,
      ].join("\n"),
    );
  } else if (exams.length === 0) {
    exams.push(
      [
        `        <li class="exam">`,
        `          <span class="icon">${ICONS.prov}</span>`,
        `          ${text("span", "what", "Inga inbokade prov", "Ei sovittuja kokeita", "e")}`,
        `        </li>`,
      ].join("\n"),
    );
  }

  const unclear = child.uncertain.length
    ? [
        `      <div class="unclear">`,
        `        ${text("strong", "", "Oklart", "Epäselvää", "u")}`,
        ...child.uncertain.map((u) => `        ${text("p", "", u.sv, u.fi, "u")}`),
        `      </div>`,
      ].join("\n")
    : "";

  return [
    `    <section class="kid" data-kid="${esc(child.slug)}"${first ? "" : " hidden"}>`,
    `      <h2 class="sr-only">${esc(child.name)}</h2>`,
    `      <p class="where">${esc(child.school)} · ${esc(child.className)}</p>`,
    `      <ul>`,
    [...items, ...exams].join("\n"),
    `      </ul>`,
    unclear,
    `    </section>`,
  ]
    .filter(Boolean)
    .join("\n");
}

function sharedMarkup(shared) {
  if (shared.length === 0) return "";
  const rows = shared.map((item) => {
    const k = key(item.sv.text, item.fi.text, "s");
    const bits = [`      <p class="headline" data-t="${k}">${esc(item.sv.text)}</p>`];
    if (item.date) {
      const labels = dateLabels(item.date);
      const svLabel = item.sv.dateLabel || labels.sv;
      const fiLabel = item.fi.dateLabel || labels.fi;
      const wk = key(svLabel, fiLabel, "w");
      bits.push(`      <span class="when" data-t="${wk}">${esc(svLabel)}</span>`);
      bits.push(`      <span class="rel" data-date="${esc(item.date)}"></span>`);
    }
    const note = text("p", "note", item.sv.note, item.fi.note, "n");
    if (note) bits.push(`      ${note}`);
    return bits.join("\n");
  });

  return [
    `  <section class="shared">`,
    `    ${text("p", "tag", "Gäller båda", "Koskee molempia", "s")}`,
    rows.join("\n"),
    `  </section>`,
  ].join("\n");
}

/**
 * Strängtabellen skrivs med onoterade nycklar och "      }," som avslutning,
 * eftersom site/build.mjs letar efter just den formen när den kontrollerar att
 * svenska och finska har samma nycklar.
 */
const table = (entries) =>
  Object.entries(entries)
    .map(([k, v]) => `        ${k}: ${js(v)},`)
    .join("\n");

// --- Sidan ---------------------------------------------------------------

const photoDir = path.join(here, "photos");
const photos = new Map(
  readdirSync(photoDir)
    .filter((f) => f.endsWith(".jpg"))
    .map((f) => [
      path.basename(f, ".jpg"),
      readFileSync(path.join(photoDir, f)).toString("base64"),
    ]),
);

const stampSv = `Uppdaterad ${data.stamp} · ${data.messageCount} Wilma-meddelanden`;
const stampFi = `Päivitetty ${data.stamp} · ${data.messageCount} Wilma-viestiä`;
const stampKey = key(stampSv, stampFi, "hdr");
const titleKey = key("Skolveckan hemma", "Kouluviikko kotona", "hdr");
const langKey = key("Språk", "Kieli", "hdr");
const pickerKey = key("Barn", "Lapset", "hdr");
const staleKey = key(
  "Sidan har inte uppdaterats på flera dygn — den automatiska körningen kan ha slutat fungera.",
  "Sivua ei ole päivitetty useaan päivään — automaattinen ajo voi olla rikki.",
  "hdr",
);
const footKey = key(
  "Varje rad kommer ur ett Wilma-meddelande eller ur veckoplaneringen; inget är tillagt.",
  "Jokainen rivi tulee Wilma-viestistä tai viikkosuunnitelmasta; mitään ei ole lisätty.",
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

const page = `<title>Skolveckan hemma</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  rel="stylesheet"
  href="https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@500;600;700&family=IBM+Plex+Mono:wght@500&family=IBM+Plex+Sans:wght@400;500;600&display=swap"
/>

<style>
${css}
</style>

<div class="board">
  <header>
    <p class="eyebrow" data-t="${stampKey}">${esc(stampSv)}</p>
    <div class="lang" role="group" data-t-label="${langKey}" aria-label="Språk">
      <button type="button" data-lang="sv" aria-pressed="true">SV</button>
      <button type="button" data-lang="fi" aria-pressed="false">FI</button>
    </div>
    <h1 class="sr-only" data-t="${titleKey}">Skolveckan hemma</h1>
  </header>

  <p class="stale" id="stale" data-t="${staleKey}" hidden></p>

  <div class="picker" data-kid="${esc(data.children[0]?.slug ?? "")}">
${faces}
    <label class="sr-only" for="kid" data-t="${pickerKey}">Barn</label>
    <select id="kid">
${options}
    </select>
  </div>

  <div class="panels">
${panels}
  </div>

${sharedMarkup(data.shared)}

  <footer>
    <p data-t="${footKey}">${esc(strings.sv[footKey])}</p>
  </footer>
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
        today: "idag",
        tomorrow: "imorgon",
        yesterday: "igår",
        inDays: (n) => \`om \${n} dagar\`,
        agoDays: (n) => \`\${n} dagar sedan\`,
      },
      fi: {
        today: "tänään",
        tomorrow: "huomenna",
        yesterday: "eilen",
        inDays: (n) => \`\${n} päivän päästä\`,
        agoDays: (n) => \`\${n} päivää sitten\`,
      },
    };

    const LANG_KEY = "skolveckan.lang";
    const DONE_KEY = "skolveckan.done";
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
          /* privat läge — sidan fungerar ändå, den minns bara inte */
        }
      },
    };

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const daysFrom = (iso) =>
      Math.round((new Date(iso + "T00:00:00") - today) / 86400000);

    function renderDates(words) {
      for (const el of document.querySelectorAll(".rel[data-date]")) {
        const days = daysFrom(el.dataset.date);
        let label, state;
        if (days === 0) {
          label = words.today;
          state = "soon";
        } else if (days === 1) {
          label = words.tomorrow;
          state = "soon";
        } else if (days === -1) {
          label = words.yesterday;
          state = "past";
        } else if (days < 0) {
          label = words.agoDays(Math.abs(days));
          state = "past";
        } else {
          label = words.inDays(days);
          state = days <= 7 ? "soon" : "later";
        }
        el.textContent = label;
        el.dataset.state = state;
      }
    }

    // En död körning ska ange sig själv i stället för att se aktuell ut.
    const stale = document.getElementById("stale");
    if (stale) stale.hidden = daysFrom(STAMP) > -3;

    function setLang(lang) {
      const table = STRINGS[lang] || STRINGS.sv;
      for (const el of document.querySelectorAll("[data-t]")) {
        const value = table[el.dataset.t];
        if (typeof value === "string") el.textContent = value;
      }
      for (const el of document.querySelectorAll("[data-t-label]")) {
        const value = table[el.dataset.tLabel];
        if (typeof value === "string") el.setAttribute("aria-label", value);
      }
      renderDates(WORDS[lang] || WORDS.sv);
      document.documentElement.lang = lang;
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
    const faces = [...document.querySelectorAll(".face")];
    const panels = [...document.querySelectorAll("section.kid")];
    const kids = panels.map((panel) => panel.dataset.kid);

    function setKid(kid) {
      for (const face of faces) face.hidden = face.dataset.kid !== kid;
      for (const panel of panels) panel.hidden = panel.dataset.kid !== kid;
      picker.dataset.kid = kid;
      select.value = kid;
      store.set(KID_KEY, kid);
    }

    select.addEventListener("change", () => setKid(select.value));
    const savedKid = store.get(KID_KEY, null);
    setKid(kids.includes(savedKid) ? savedKid : kids[0]);

    // Avklarat sparas per läsare, oberoende av språk och av vilket barn som visas.
    let done = {};
    try {
      done = JSON.parse(store.get(DONE_KEY, "{}")) || {};
    } catch (e) {
      done = {};
    }
    for (const box of document.querySelectorAll('input[type="checkbox"][data-id]')) {
      if (done[box.dataset.id]) box.checked = true;
      box.addEventListener("change", () => {
        done[box.dataset.id] = box.checked;
        store.set(DONE_KEY, JSON.stringify(done));
      });
    }
  })();
</script>
`;

writeFileSync(path.join(here, "oversikt.html"), page);

const counts = data.children.map((c) => `${c.name}: ${c.items.length}+${c.exams.length}`).join(", ");
console.log(
  `site/oversikt.html — ${Object.keys(strings.sv).length} texter x2, ${counts}, ` +
    `${data.shared.length} gemensamma, stamp ${data.stamp}`,
);
