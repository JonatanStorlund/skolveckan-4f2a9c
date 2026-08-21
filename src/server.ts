import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { extract, MissingKeyError } from "./extract.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "..", "public");

/** Minimal .env-läsare — inget behov av ett paket för fem rader. */
async function loadEnv(): Promise<void> {
  try {
    const raw = await readFile(path.join(here, "..", ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (!key || process.env[key]) continue;
      process.env[key] = rawValue!.trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // Ingen .env — miljövariabler kan vara satta ändå.
  }
}

const MAX_BODY = 200_000; // ~200 kB räcker för vilket lärarbrev som helst

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("Meddelandet är för långt."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      const html = await readFile(path.join(publicDir, "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.method === "POST" && req.url === "/api/tldr") {
      const body = await readBody(req);
      let message: unknown;
      try {
        message = (JSON.parse(body) as { message?: unknown }).message;
      } catch {
        json(res, 400, { error: "Ogiltig JSON." });
        return;
      }
      if (typeof message !== "string" || message.trim().length < 10) {
        json(res, 400, { error: "Klistra in ett meddelande först." });
        return;
      }

      const started = Date.now();
      const result = await extract(message);
      console.log(`tldr: ${result.items.length} ärenden, ${Date.now() - started} ms`);
      json(res, 200, result);
      return;
    }

    json(res, 404, { error: "Not found" });
  } catch (error) {
    if (error instanceof MissingKeyError) {
      json(res, 503, { error: error.message });
      return;
    }
    if (error instanceof Anthropic.AuthenticationError) {
      json(res, 502, { error: "API-nyckeln avvisades av Anthropic." });
      return;
    }
    if (error instanceof Anthropic.RateLimitError) {
      json(res, 429, { error: "Rate limit — försök igen om en stund." });
      return;
    }
    if (error instanceof Anthropic.APIError) {
      console.error(error);
      json(res, 502, { error: `API-fel ${error.status ?? ""}: ${error.message}` });
      return;
    }
    console.error(error);
    json(res, 500, { error: error instanceof Error ? error.message : "Okänt fel." });
  }
});

await loadEnv();
const port = Number(process.env.PORT ?? 4173);
server.listen(port, "127.0.0.1", () => {
  console.log(`wilma-tldr: http://127.0.0.1:${port}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("Varning: ANTHROPIC_API_KEY är inte satt — sammanfattning kommer att misslyckas.");
  }
});
