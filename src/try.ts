/**
 * Rökprov från terminalen: `npx tsx src/try.ts fixtures/exempel-host.txt`
 */
import { readFile } from "node:fs/promises";
import { extract } from "./extract.js";

const file = process.argv[2] ?? "fixtures/exempel-host.txt";
const message = await readFile(file, "utf8");
const result = await extract(message);

console.log(`\n${result.subject || "(inget ämne)"}  [in: ${result.language_in}]\n`);
for (const item of result.items) {
  const when = item.date_label ? `  (${item.date_label}${item.time ? " " + item.time : ""})` : "";
  console.log(`• ${item.text}${when}`);
  console.log(`  fi: ${item.text_fi}`);
  if (item.note) console.log(`  not: ${item.note}  /  ${item.note_fi}`);
  console.log(`    ↳ "${item.quote}"  [${item.kind}${item.date ? " " + item.date : ""}]`);
}
if (result.uncertain.length) {
  console.log("\nOklart:");
  for (const line of result.uncertain) console.log(`  ? ${line.sv}  /  ${line.fi}`);
}
console.log();
