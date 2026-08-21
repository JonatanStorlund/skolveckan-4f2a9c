import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { SYSTEM_PROMPT, referenceBlock } from "./prompt.js";

export const ItemKind = z.enum([
  "ta_med",
  "deadline",
  "ingen_skola",
  "andrad_tid",
  "evenemang",
  "betalning",
  "laxa",
  "bokning",
  "info",
]);

export const ItemSchema = z.object({
  text: z.string().describe("Swedish imperative or plain statement, max 10 words"),
  text_fi: z.string().describe("The same line in Finnish, reading naturally to a Finnish parent"),
  kind: ItemKind,
  date: z.string().describe("YYYY-MM-DD, or empty string when no date can be determined"),
  date_label: z.string().describe('Short Swedish label, e.g. "tis 26.8". Empty if undated.'),
  date_label_fi: z.string().describe('Finnish label, e.g. "ti 26.8.". Empty if undated.'),
  time: z.string().describe('Clock time if stated, e.g. "08:15-12:00". Empty otherwise.'),
  note: z.string().describe("One short Swedish clarifying line, max 15 words. Empty when unneeded."),
  note_fi: z.string().describe("The same clarification in Finnish. Empty when unneeded."),
  quote: z.string().describe("Verbatim snippet from the original message, original language"),
});

export const TldrSchema = z.object({
  language_in: z.enum(["sv", "fi", "en", "other"]),
  subject: z.string().describe("Max 6 words: class, group, teacher or trip concerned. Empty if unclear."),
  items: z.array(ItemSchema),
  uncertain: z
    .array(
      z.object({
        sv: z.string().describe("Short Swedish line about something ambiguous"),
        fi: z.string().describe("The same line in Finnish"),
      }),
    )
    .describe("Anything ambiguous or contradictory — never turned into a confident item"),
});

export type Tldr = z.infer<typeof TldrSchema>;
export type Item = z.infer<typeof ItemSchema>;

/**
 * Extrahering mot ett strikt schema är precis vad en liten modell är bra på, så
 * arbetsmodellen är den billigaste. Kvaliteten hålls uppe av valideringen nedan,
 * inte av prislappen: faller ett svar körs just det meddelandet om en gång på
 * räddningsmodellen.
 */
const WORK_MODEL = "claude-haiku-4-5";
const RESCUE_MODEL = "claude-sonnet-5";

/** Haiku 4.5 känner inte `output_config.effort` och svarar 400 om det skickas. */
const supportsEffort = (model: string): boolean => !model.startsWith("claude-haiku");

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

export class MissingKeyError extends Error {}

export interface ExtractOptions {
  /** När meddelandet skickades — referens för alla relativa uttryck. */
  sentAt: Date;
  /** Nu, bara för att bedöma vad som hunnit passera. */
  now?: Date;
  household?: string[];
}

export interface Usage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Uppskattning i US-dollar, för att kunna se kostnaden i loggen. */
  costUsd: number;
}

/** $ per miljon tokens (in/ut), för loggens skattning. */
const PRICES: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-sonnet-5": { in: 3, out: 15 },
};

/** Ett ställe, så validering och helgvakt inte kan vara oense. */
export const WEEKEND_WORDS = /lördag|söndag|lauantai|sunnuntai|helg|viikonlopp|weekend/i;

const normalise = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Fel som är värda att köra om på en starkare modell. Allt som kan lagas i kod
 * lagas i kod i stället — en omkörning kostar pengar.
 */
interface Violation {
  /** Index i result.items, eller -1 för fel som inte hör till en post. */
  index: number;
  problem: string;
}

/**
 * Lagar det som går att laga i kod. Skilt från violations() med flit: en
 * funktion som heter "violations" ska rapportera, inte redigera i smyg.
 *
 * En not eller datumetikett på bara ett språk blankas på båda sidor — renderaren
 * räknar ändå fram etiketten ur datumet, och en riktig läxa är för värdefull att
 * kasta för ett kosmetiskt fält.
 */
function repair(result: Tldr): void {
  for (const item of result.items) {
    if (Boolean(item.note.trim()) !== Boolean(item.note_fi.trim())) {
      item.note = "";
      item.note_fi = "";
    }
    if (Boolean(item.date_label.trim()) !== Boolean(item.date_label_fi.trim())) {
      item.date_label = "";
      item.date_label_fi = "";
    }
  }
}

function violations(result: Tldr, source: string): Violation[] {
  const problems: Violation[] = [];
  const haystack = normalise(source);

  result.items.forEach((item, index) => {
    const label = item.text || item.text_fi || "(namnlös)";
    const add = (problem: string) => problems.push({ index, problem: `"${label}": ${problem}` });

    if (!item.text.trim() || !item.text_fi.trim()) {
      add("saknar text på båda språken");
    }
    if (item.date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(item.date) || Number.isNaN(Date.parse(item.date))) {
        add(`ogiltigt datum "${item.date}"`);
      } else {
        const weekday = new Date(`${item.date}T00:00:00Z`).getUTCDay();
        const namesWeekend = WEEKEND_WORDS.test(item.quote) || WEEKEND_WORDS.test(item.text);
        if ((weekday === 0 || weekday === 6) && !namesWeekend) {
          add(`${item.date} är en helgdag men inget nämner helgen`);
        }
      }
    }
    // Citatet ska gå att hitta i källan. Fångar påhitt billigare än någon modell.
    const quote = normalise(item.quote);
    if (quote.length > 8 && !haystack.includes(quote)) {
      add("citatet finns inte i källtexten");
    }
  });

  for (const line of result.uncertain) {
    if (!line.sv.trim() || !line.fi.trim()) {
      problems.push({ index: -1, problem: "oklarhet saknar ett av språken" });
    }
  }

  return problems;
}

async function callModel(
  model: string,
  message: string,
  options: ExtractOptions,
): Promise<{ result: Tldr; usage: Usage }> {
  const { sentAt, now = new Date(), household = [] } = options;

  const response = await getClient().messages.parse({
    model,
    max_tokens: 8000,
    output_config: {
      // Effort finns inte på Haiku; skickas det svarar API:et 400.
      // Räddningen körs bara när valideringen fallit, så den ska tänka ordentligt.
      ...(supportsEffort(model) ? { effort: "high" as const } : {}),
      format: zodOutputFormat(TldrSchema),
    },
    // Stabil prefix först, volatila datum sist. Obs: Haiku 4.5 cachar först från
    // 4096 tokens och reglerna är kortare än så, så brytpunkten är verkningslös
    // på arbetsmodellen. Den står kvar för räddningsmodellen och för dagen då
    // reglerna växer.
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: `${referenceBlock(sentAt, now)}${
          household.length
            ? `\n\nHOUSEHOLD FACTS (treat as true; drop lines these rule out):\n${household
                .map((fact) => `- ${fact}`)
                .join("\n")}`
            : ""
        }

Wilma-meddelande:
<meddelande>
${message}
</meddelande>`,
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Modellen avbröt förfrågan (refusal). Meddelandet kunde inte behandlas.");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error(`Svaret klipptes av max_tokens (${model}) — meddelandet är för långt.`);
  }
  const parsed = response.parsed_output;
  if (!parsed) throw new Error("Kunde inte tolka svaret från modellen.");

  const price = PRICES[model] ?? { in: 0, out: 0 };
  const inputTokens = response.usage.input_tokens ?? 0;
  const outputTokens = response.usage.output_tokens ?? 0;
  const cacheReadTokens = response.usage.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = response.usage.cache_creation_input_tokens ?? 0;

  return {
    result: parsed,
    usage: {
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      // Cacheskrivning kostar 1.25x, läsning 0.1x — annars stämmer inte siffran.
      costUsd:
        (inputTokens * price.in +
          cacheWriteTokens * price.in * 1.25 +
          cacheReadTokens * price.in * 0.1 +
          outputTokens * price.out) /
        1_000_000,
    },
  };
}

export interface ExtractResult extends Tldr {
  usage: Usage[];
  /** Poster som föll på valideringen även efter omkörning, och därför släpptes. */
  dropped: string[];
}

export async function extract(message: string, options: ExtractOptions): Promise<ExtractResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new MissingKeyError(
      "ANTHROPIC_API_KEY saknas. Lägg den i .env eller exportera den innan du kör.",
    );
  }

  const usage: Usage[] = [];
  let { result, usage: first } = await callModel(WORK_MODEL, message, options);
  usage.push(first);

  repair(result);
  let problems = violations(result, message);
  if (problems.length) {
    console.warn(
      `  ${WORK_MODEL} gav ${problems.length} problem, kör om på ${RESCUE_MODEL}:\n` +
        problems.map((p) => `    - ${p.problem}`).join("\n"),
    );
    const rescue = await callModel(RESCUE_MODEL, message, options);
    usage.push(rescue.usage);
    result = rescue.result;
    repair(result);
    problems = violations(result, message);
  }

  // Kvarstående problem släpps per index — texten går inte att matcha på, den
  // kan innehålla citattecken och två poster kan ha samma lydelse.
  const dropped: string[] = [];
  if (problems.length) {
    const badIndexes = new Set(problems.map((p) => p.index).filter((i) => i >= 0));
    result = {
      ...result,
      items: result.items.filter((item, index) => {
        if (!badIndexes.has(index)) return true;
        dropped.push(item.text || item.text_fi || `post ${index}`);
        return false;
      }),
      uncertain: result.uncertain.filter((line) => line.sv.trim() && line.fi.trim()),
    };
  }

  // Sortering är en presentationsregel — genomdriv den i kod.
  const items = [...result.items].sort((a, b) => {
    if (a.date && b.date) return a.date.localeCompare(b.date);
    if (a.date) return -1;
    if (b.date) return 1;
    return 0;
  });

  return { ...result, items, usage, dropped };
}

/** Sammanfattar en körnings kostnad för loggen. */
export function summariseUsage(all: Usage[]): string {
  const total = all.reduce(
    (sum, u) => ({
      input: sum.input + u.inputTokens,
      output: sum.output + u.outputTokens,
      cached: sum.cached + u.cacheReadTokens,
      cost: sum.cost + u.costUsd,
    }),
    { input: 0, output: 0, cached: 0, cost: 0 },
  );
  const models = [...new Set(all.map((u) => u.model))].join(", ") || "inga anrop";
  return (
    `${all.length} modellanrop (${models}) — ${total.input} in, ${total.output} ut, ` +
    `${total.cached} ur cachen, ca $${total.cost.toFixed(4)}`
  );
}
