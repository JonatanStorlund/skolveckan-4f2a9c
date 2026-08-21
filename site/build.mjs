/**
 * Bygger en fristående sida av site/oversikt.html.
 *
 * Samma fil driver båda utgåvorna: artefakten på claude.ai (där runtime lägger
 * på html/head/body själv) och den publika sidan på GitHub Pages (som behöver
 * ett helt dokument). En källa, två mål — innehållet kan inte glida isär.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "oversikt.html"), "utf8");
const outDir = path.join(here, "..", "dist");

// Hissa upp det som hör i <head>; resten är sidans kropp.
const head = [];
let body = source;

const hoist = (pattern) => {
  body = body.replace(pattern, (match) => {
    head.push(match.trim());
    return "";
  });
};

hoist(/<title>[\s\S]*?<\/title>/i);
hoist(/<link\b[^>]*>/gi);
hoist(/<style>[\s\S]*?<\/style>/i);

const title = /<title>([^<]*)<\/title>/i.exec(source)?.[1] ?? "Skolveckan hemma";
const css = /<style>([\s\S]*?)<\/style>/i.exec(source)?.[1] ?? "";

// Språken bor i samma tabell just för att en text inte ska kunna glömmas bort på
// det ena språket. Bygget vaktar det: nyckelmängderna måste vara identiska.
const entriesOf = (lang) => {
  const start = source.indexOf(`      ${lang}: {`);
  const end = source.indexOf("\n      },", start);
  if (start === -1 || end === -1) throw new Error(`Hittade inte STRINGS.${lang}.`);
  const found = new Map();
  // Nycklarna kan vara citerade (genererad tabell) eller inte (handskriven).
  for (const m of source.slice(start, end).matchAll(/^ {8}"?(\w+)"?\s*:\s*(.*)$/gm)) {
    found.set(m[1], m[2].trim());
  }
  return found;
};
const sv = entriesOf("sv");
const fi = entriesOf("fi");

// Tom sträng på ena språket och text på det andra är inte paritet — det var en
// verklig lucka: en not fanns på finska och lyste tom på svenska.
// Whitespace räknas som tomt, precis som violations() i src/extract.ts gör.
const isEmpty = (value) => value === undefined || /^"\s*"\s*,?$/.test(value);
const missing = [
  ...[...sv.keys()].filter((k) => !fi.has(k)).map((k) => `fi saknar ${k}`),
  ...[...fi.keys()].filter((k) => !sv.has(k)).map((k) => `sv saknar ${k}`),
  ...[...sv.keys()]
    .filter((k) => fi.has(k) && isEmpty(sv.get(k)) !== isEmpty(fi.get(k)))
    .map((k) => `${k} är tom på ett språk men inte på det andra`),
];
if (missing.length) {
  console.error(`Språken har glidit isär:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}

// En dubblerad selektor är tyst: den senare vinner och kastar layouten om.
// Det var precis felet som satte datumchipet mellan ikonen och texten.
const cssBlocks = [...css.matchAll(/^ {2}([^@\s][^{]*?)\s*\{/gm)].map((m) => m[1].trim());
const seen = new Map();
const duplicates = [];
for (const selector of cssBlocks) {
  if (seen.has(selector)) duplicates.push(selector);
  else seen.set(selector, true);
}
if (duplicates.length) {
  console.error(`Dubblerade CSS-selektorer:\n  ${[...new Set(duplicates)].join("\n  ")}`);
  process.exit(1);
}

// Den mörka paletten står två gånger (media query + [data-theme]) eftersom CSS
// inte kan dela ett block mellan dem. Då ska en vakt se att de är lika.
const darkBlocks = [
  /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\}/.exec(css),
  /:root\[data-theme="dark"\] \{([\s\S]*?)\}/.exec(css),
].map((m) => (m ? m[1].replace(/\s+/g, " ").trim() : null));

if (darkBlocks[0] && darkBlocks[1] && darkBlocks[0] !== darkBlocks[1]) {
  const tokens = (block) => new Map(
    [...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
  );
  const a = tokens(darkBlocks[0]);
  const b = tokens(darkBlocks[1]);
  const diff = [...new Set([...a.keys(), ...b.keys()])]
    .filter((k) => a.get(k) !== b.get(k))
    .map((k) => `  ${k}: media=${a.get(k) ?? "(saknas)"} toggle=${b.get(k) ?? "(saknas)"}`);
  console.error(`De två mörka paletterna har glidit isär:\n${diff.join("\n")}`);
  process.exit(1);
}

const page = `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="description" content="Vad barnen behöver ha med sig och när, kokat ur veckans Wilma-meddelanden.">
<meta property="og:title" content="${title}">
<meta name="theme-color" content="#eaeeec" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#121917" media="(prefers-color-scheme: dark)">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text x='0' y='13' font-size='14'>%F0%9F%8E%92</text></svg>">
${head.join("\n")}
</head>
<body>
${body.trim()}
</body>
</html>
`;

mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "index.html"), page);
writeFileSync(path.join(outDir, "robots.txt"), "User-agent: *\nDisallow: /\n");
// Utan .nojekyll gömmer GitHub Pages filer som börjar med understreck.
writeFileSync(path.join(outDir, ".nojekyll"), "");

console.log(`dist/index.html — ${page.length} tecken, ${head.length} head-taggar, ${sv.size} texter x2`);
