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
  "info",
]);

export const ItemSchema = z.object({
  text: z.string().describe("Swedish imperative or plain statement, max 10 words"),
  kind: ItemKind,
  date: z.string().describe("YYYY-MM-DD, or empty string when no date can be determined"),
  date_label: z.string().describe('Short Swedish label, e.g. "tis 26.8". Empty if undated.'),
  time: z.string().describe('Clock time if stated, e.g. "08:15-12:00". Empty otherwise.'),
  quote: z.string().describe("Verbatim snippet from the original message, original language"),
});

export const TldrSchema = z.object({
  language_in: z.enum(["sv", "fi", "en", "other"]),
  subject: z.string().describe("Max 6 words: class, group, teacher or trip concerned. Empty if unclear."),
  items: z.array(ItemSchema),
  uncertain: z.array(z.string()).describe("Short Swedish lines about anything ambiguous or contradictory"),
});

export type Tldr = z.infer<typeof TldrSchema>;

const MODEL = "claude-opus-5";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

export class MissingKeyError extends Error {}

export async function extract(message: string, now = new Date()): Promise<Tldr> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new MissingKeyError(
      "ANTHROPIC_API_KEY saknas. Lägg den i .env eller exportera den innan du startar servern.",
    );
  }

  const response = await getClient().messages.parse({
    model: MODEL,
    max_tokens: 8000,
    output_config: {
      effort: "high",
      format: zodOutputFormat(TldrSchema),
    },
    // Stabil prefix först (cachas), volatilt referensdatum sist.
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: `${referenceBlock(now)}

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

  const parsed = response.parsed_output;
  if (!parsed) throw new Error("Kunde inte tolka svaret från modellen.");

  // Sortering är en presentationsregel — genomdriv den i kod istället för att
  // lita på att modellen håller den.
  const items = [...parsed.items].sort((a, b) => {
    if (a.date && b.date) return a.date.localeCompare(b.date);
    if (a.date) return -1;
    if (b.date) return 1;
    return 0;
  });

  return { ...parsed, items };
}
