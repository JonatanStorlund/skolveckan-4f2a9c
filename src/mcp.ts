/**
 * MCP-server över Wilma, med ett verktyg per sak Claude behöver kunna göra.
 * Rollmedveten: varje barn har sin egen inkorg.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Wilma, WilmaError } from "./wilma.js";

const baseUrl = process.env.WILMA_BASE_URL;
const username = process.env.WILMA_USERNAME;
const password = process.env.WILMA_PASSWORD;

if (!baseUrl || !username || !password) {
  console.error("wilma-mcp: WILMA_BASE_URL, WILMA_USERNAME och WILMA_PASSWORD måste vara satta.");
  process.exit(78);
}

const wilma = new Wilma(baseUrl, username, password);
const server = new McpServer({ name: "wilma", version: "1.0.0" });

const text = (body: string) => ({ content: [{ type: "text" as const, text: body }] });

/** Fel ska nå modellen som läsbar text, inte som ett protokollfel. */
async function guard(work: () => Promise<string>) {
  try {
    return text(await work());
  } catch (error) {
    const message = error instanceof WilmaError ? error.message : String(error);
    return { ...text(`Fel: ${message}`), isError: true };
  }
}

server.registerTool(
  "wilma_children",
  {
    title: "Lista barn",
    description:
      "Listar vårdnadshavarens barn i Wilma med namn, skola och klass. Varje barn har en egen inkorg — börja här när du inte vet vilka barn som finns.",
    inputSchema: {},
  },
  async () =>
    guard(async () => {
      const kids = await wilma.children();
      return kids.map((k) => `${k.name} — ${k.school}, ${k.className} (${k.prefix})`).join("\n");
    }),
);

server.registerTool(
  "wilma_messages",
  {
    title: "Lista meddelanden",
    description:
      "Listar meddelanden i ett barns inkorg. Utan 'child' listas alla barn, ett avsnitt per barn. Samma meddelande-id hos flera barn betyder att det gick till hela skolan.",
    inputSchema: {
      child: z
        .string()
        .optional()
        .describe("Förnamn, helt namn eller rollprefix. Utlämnat: alla barn."),
      limit: z.number().int().min(1).max(50).optional().describe("Antal per barn, standard 10."),
      unread_only: z.boolean().optional().describe("Bara olästa."),
    },
  },
  async ({ child, limit, unread_only }) =>
    guard(async () => {
      const kids = child ? [await wilma.resolveChild(child)] : await wilma.children();
      const blocks: string[] = [];

      for (const kid of kids) {
        let list = await wilma.messages(kid.prefix, limit ?? 10);
        if (unread_only) list = list.filter((m) => m.unread);
        const header = `## ${kid.name} — ${kid.school}, ${kid.className}`;
        if (list.length === 0) {
          blocks.push(`${header}\n(inget${unread_only ? " oläst" : ""})`);
          continue;
        }
        blocks.push(
          `${header}\n` +
            list
              .map(
                (m) =>
                  `[${m.id}] ${m.subject}\n    ${m.sender} | ${m.timestamp}${m.unread ? " | OLÄST" : ""}`,
              )
              .join("\n"),
        );
      }
      return blocks.join("\n\n");
    }),
);

server.registerTool(
  "wilma_read",
  {
    title: "Läs meddelande",
    description:
      "Hämtar hela texten i ett meddelande. Ange vilket barns inkorg det ligger i — id:n är rollspecifika.",
    inputSchema: {
      child: z.string().describe("Förnamn, helt namn eller rollprefix."),
      id: z.number().int().describe("Meddelande-id från wilma_messages."),
    },
  },
  async ({ child, id }) =>
    guard(async () => {
      const kid = await wilma.resolveChild(child);
      const message = await wilma.read(kid.prefix, id);
      return [
        `Barn: ${kid.name} (${kid.school}, ${kid.className})`,
        `Ämne: ${message.subject}`,
        `Avsändare: ${message.sender}`,
        `Skickat: ${message.timestamp}`,
        "",
        message.text,
      ].join("\n");
    }),
);

await server.connect(new StdioServerTransport());
