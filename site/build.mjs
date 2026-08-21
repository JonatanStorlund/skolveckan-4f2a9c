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

console.log(`dist/index.html — ${page.length} tecken, ${head.length} head-taggar`);
