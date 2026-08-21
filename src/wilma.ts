/**
 * Wilma-klient med rollstöd.
 *
 * Ett vårdnadshavarkonto har en roll per barn, och varje roll har sin egen
 * inkorg under sitt prefix (`/!0425002`). Klienter som bara använder den roll
 * inloggningen råkar landa på ser därför bara ett av barnen.
 *
 * Anropen är samma som Wilmas egen webbklient gör. Ingen officiell API finns
 * för vårdnadshavare, så det här kan sluta fungera när Visma ändrar något.
 */

export interface Child {
  /** Namn som det står i Wilma. */
  name: string;
  /** Rollprefix, t.ex. "/!0425002". */
  prefix: string;
  school: string;
  className: string;
}

export interface MessageSummary {
  id: number;
  subject: string;
  sender: string;
  /** "YYYY-MM-DD HH:MM" som Wilma ger det. */
  timestamp: string;
  unread: boolean;
}

export interface MessageBody extends MessageSummary {
  text: string;
}

export interface Exam {
  /** ISO-datum, "2026-10-07". */
  date: string;
  /** Ämnesnamn som Wilma skriver det, t.ex. "Matematik". */
  subject: string;
  /** Gruppkod, t.ex. "MA MA71". */
  group: string;
  teachers: string[];
}

export class WilmaError extends Error {}
export class WilmaAuthError extends WilmaError {}
export class WilmaMfaError extends WilmaAuthError {}

export class Wilma {
  private cookies = new Map<string, string>();
  private loggedIn = false;

  constructor(
    private readonly baseUrl: string,
    private readonly username: string,
    private readonly password: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  // --- HTTP -----------------------------------------------------------------

  private cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private storeCookies(response: Response): void {
    // getSetCookie() finns i Node 20+ och ger varje Set-Cookie för sig.
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(";");
      const eq = pair?.indexOf("=") ?? -1;
      if (!pair || eq <= 0) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      // Max-Age=0 betyder att servern rensar kakan.
      if (/;\s*max-age=0\b/i.test(raw) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      redirect: "manual",
      headers: {
        "User-Agent": "wilma-tldr/1.0",
        Accept: "application/json, text/html",
        ...(this.cookies.size ? { Cookie: this.cookieHeader() } : {}),
        ...(init.headers ?? {}),
      },
    });
    this.storeCookies(response);
    return response;
  }

  /** Som request(), men loggar in igen om sessionen gått ut (25 min inaktivitet). */
  private async authed(path: string): Promise<Response> {
    if (!this.loggedIn) await this.login();
    let response = await this.request(path);
    const bounced =
      response.status === 302 ||
      response.status === 303 ||
      (response.status === 403 && !path.includes("/messages/"));
    if (bounced) {
      this.loggedIn = false;
      this.cookies.clear();
      await this.login();
      response = await this.request(path);
    }
    return response;
  }

  // --- Inloggning ----------------------------------------------------------

  async login(): Promise<void> {
    // Steg 1: SessionID i kroppen, Wilma2LoginID som kaka. De två är parade
    // (samma cnf.kid i JWT:n) — skickas inte kakan med blir inloggningen nekad.
    const index = await this.request("/index_json");
    if (!index.ok) throw new WilmaAuthError(`index_json gav ${index.status}`);
    const sessionId = ((await index.json()) as { SessionID?: string }).SessionID;
    if (!sessionId) throw new WilmaAuthError("Inget SessionID från index_json.");

    // Steg 2: logga in som webbklienten gör.
    const login = await this.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        Login: this.username,
        Password: this.password,
        SESSIONID: sessionId,
      }).toString(),
    });

    const location = login.headers.get("location") ?? "";
    if (/loginfailed/i.test(location)) {
      throw new WilmaAuthError(
        "Wilma nekade inloggningen (fel användarnamn eller lösenord). " +
          "Uppdatera nyckelringen: security add-generic-password -U -s wilma-tldr " +
          `-a '${this.username}' -w`,
      );
    }
    if (/mfa/i.test(location) || /mfa-required/i.test(await this.peek(login))) {
      throw new WilmaMfaError(
        "Kontot kräver engångskod (MFA). Det stöds inte än — flödet är " +
          "POST /api/v1/accounts/me/mfa/otp/check.",
      );
    }
    if (!this.cookies.has("Wilma2SID")) {
      throw new WilmaAuthError(
        `Ingen Wilma2SID-kaka efter inloggning (status ${login.status}, location "${location}").`,
      );
    }
    this.loggedIn = true;
  }

  private async peek(response: Response): Promise<string> {
    try {
      return (await response.clone().text()).slice(0, 400);
    } catch {
      return "";
    }
  }

  // --- Barn ----------------------------------------------------------------

  /**
   * Läser rollerna från startsidan. Varje barn har en panelrubrik med prefix,
   * namn, skola och klass.
   */
  async children(): Promise<Child[]> {
    const response = await this.authed("/");
    const html = await response.text();

    const found = new Map<string, Child>();

    const panel =
      /<a[^>]*href="(\/!\d+)\/?"[^>]*>\s*([^<]+?)\s*<small>\s*([^<]*?)\s*<\/small>\s*<span[^>]*>\s*,?\s*([^<]*?)\s*<\/span>/g;
    for (const m of html.matchAll(panel)) {
      const [, prefix, name, school, className] = m;
      if (prefix && name) {
        found.set(prefix, {
          prefix,
          name: decodeEntities(name),
          school: decodeEntities(school ?? ""),
          className: decodeEntities(className ?? ""),
        });
      }
    }

    // Reserv: rollväljaren i menyn ger prefix och namn men ingen skola/klass.
    if (found.size === 0) {
      const menu = /<li[^>]*>\s*<a[^>]*href="(\/!\d+)\/?"[^>]*>\s*([^<]+?)\s*<\/a>/g;
      for (const m of html.matchAll(menu)) {
        const [, prefix, name] = m;
        if (prefix && name) {
          found.set(prefix, { prefix, name: decodeEntities(name), school: "", className: "" });
        }
      }
    }

    if (found.size === 0) {
      throw new WilmaError("Hittade inga barn på startsidan — layouten kan ha ändrats.");
    }
    return [...found.values()];
  }

  /** Matchar ett barn på förnamn, helt namn eller prefix. */
  async resolveChild(needle: string): Promise<Child> {
    const kids = await this.children();
    const want = needle.trim().toLowerCase();
    const hit =
      kids.find((k) => k.prefix === needle) ??
      kids.find((k) => k.name.toLowerCase() === want) ??
      kids.find((k) => k.name.toLowerCase().split(/\s+/)[0] === want) ??
      kids.find((k) => k.name.toLowerCase().includes(want));
    if (!hit) {
      throw new WilmaError(
        `Hittade inget barn som matchar "${needle}". Finns: ${kids.map((k) => k.name).join(", ")}.`,
      );
    }
    return hit;
  }

  // --- Meddelanden ---------------------------------------------------------

  async messages(prefix: string, limit = 10): Promise<MessageSummary[]> {
    const response = await this.authed(`${prefix}/messages/list/index_json`);
    if (!response.ok) throw new WilmaError(`Meddelandelistan gav ${response.status}.`);
    const data = (await response.json()) as {
      Messages?: Array<{
        Id: number;
        Subject: string;
        Sender: string;
        TimeStamp: string;
        Status?: number;
      }>;
    };
    return (data.Messages ?? []).slice(0, limit).map((m) => ({
      id: m.Id,
      subject: m.Subject,
      sender: m.Sender,
      timestamp: m.TimeStamp,
      unread: m.Status === 1,
    }));
  }

  /**
   * Elevfoto. Odokumenterad endpoint som ger en liten JPEG per roll.
   * Saknas fotot svarar Wilma inte med en bild — då returneras null.
   */
  async photo(prefix: string): Promise<Uint8Array | null> {
    const response = await this.authed(`${prefix}/photo`);
    const type = response.headers.get("content-type") ?? "";
    if (!response.ok || !type.startsWith("image/")) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength > 0 ? bytes : null;
  }

  /**
   * Prov ur Wilmas provkalender ("Kokeet").
   *
   * `/exams/calendar/index_json` svarar HTML med content-type application/json,
   * så vi läser HTML:en direkt: en tabell per prov, datumet i <strong>.
   */
  async exams(prefix: string, past = false): Promise<Exam[]> {
    const response = await this.authed(`${prefix}/exams/calendar${past ? "/past" : ""}`);
    if (!response.ok) throw new WilmaError(`Provkalendern gav ${response.status}.`);
    const html = await response.text();

    const exams: Exam[] = [];
    for (const table of html.split(/<table[^>]*class="[^"]*table-grey[^"]*"[^>]*>/i).slice(1)) {
      const rawDate = /<strong>\s*([^<]+?)\s*<\/strong>/i.exec(table)?.[1];
      if (!rawDate) continue;

      // "Ke 7.10.2026" -> 2026-10-07. Veckodagen räknas ur datumet vid
      // presentation, så vi slipper översätta finska förkortningar.
      const dmy = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(rawDate);
      if (!dmy) continue;
      const [, d, m, y] = dmy;
      const date = `${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;

      // Cellen efter datumet: "MA MA71 : Matematik".
      const afterDate = table.slice(table.indexOf("</strong>"));
      const cell = /<td[^>]*>([\s\S]*?)<\/td>/i.exec(afterDate.slice(afterDate.indexOf("</td>")))?.[1] ?? "";
      const plain = stripTags(cell).replace(/\s+/g, " ").trim();
      const split = plain.indexOf(":");
      const group = split === -1 ? "" : plain.slice(0, split).trim();
      const subject = (split === -1 ? plain : plain.slice(split + 1)).trim();

      const teachers = [...table.matchAll(/class="[^"]*profile-link[^"]*"[^>]*>([^<]+)<\/a>/gi)].map(
        (t) => decodeEntities(t[1]!.trim()),
      );

      exams.push({ date, subject: decodeEntities(subject), group: decodeEntities(group), teachers });
    }
    return exams.sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Meddelandetexten. Wilma ger bara HTML här — JSON-varianten som finns
   * dokumenterad svarar 403 på den här installationen.
   */
  async read(prefix: string, id: number): Promise<MessageBody> {
    const response = await this.authed(`${prefix}/messages/${id}`);
    if (!response.ok) throw new WilmaError(`Meddelande ${id} gav ${response.status}.`);
    const html = await response.text();

    const subject = /<title>([^<]*)<\/title>/i
      .exec(html)?.[1]
      ?.replace(/\s*-\s*Wilma\s*$/i, "")
      .trim();

    return {
      id,
      subject: decodeEntities(subject ?? ""),
      sender: fieldFromTable(html, ["lähettäjä", "avsändare", "sender"]),
      timestamp: fieldFromTable(html, ["lähetetty", "skickat", "sent"]),
      unread: false,
      text: extractBody(html),
    };
  }
}

// --- HTML-hjälpare ---------------------------------------------------------

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    auml: "ä",
    ouml: "ö",
    aring: "å",
    Auml: "Ä",
    Ouml: "Ö",
    Aring: "Å",
    rsquo: "’",
    lsquo: "‘",
    ldquo: "”",
    rdquo: "”",
    ndash: "–",
    mdash: "—",
    hellip: "…",
  };
  return text
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => named[name] ?? whole);
}

function stripTags(html: string): string {
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    // Länkadressen är ofta hela poängen med raden — veckoplaneringen ligger i en
    // länk vars text bara säger "Vecka 35". Adressen i parentes, inte i <>, för
    // annars stryker taggrensningen nedan den som om den var en tagg.
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, label: string) => {
      const shown = label.replace(/<[^>]+>/g, "").trim();
      return !shown || shown === href ? ` ${href} ` : ` ${shown} (${href}) `;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Klipper ut en div med balanserade taggar, från en startposition. */
function sliceBalancedDiv(html: string, openTagStart: number): string {
  const afterOpen = html.indexOf(">", openTagStart);
  if (afterOpen === -1) return "";
  let depth = 1;
  const scanner = /<div\b[^>]*>|<\/div\s*>/gi;
  scanner.lastIndex = afterOpen + 1;
  for (let m = scanner.exec(html); m; m = scanner.exec(html)) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(afterOpen + 1, m.index);
  }
  return html.slice(afterOpen + 1);
}

/** Brödtexten ligger i div.ckeditor; annars faller vi tillbaka på panelen. */
function extractBody(html: string): string {
  const ck = /<div[^>]*class="[^"]*\bckeditor\b[^"]*"[^>]*>/i.exec(html);
  if (ck) {
    const body = stripTags(sliceBalancedDiv(html, ck.index));
    if (body) return body;
  }

  const panel = /<div[^>]*class="[^"]*\bpanel-body\b[^"]*"[^>]*>/i.exec(html);
  if (panel) {
    const text = stripTags(sliceBalancedDiv(html, panel.index));
    // Allt efter tidsstämpeln är brödtext; före den ligger metadatatabellen.
    const parts = text.split(/\d{1,2}\.\d{1,2}\.\d{4}\s*(?:klo\s*)?\d{1,2}[.:]\d{2}/);
    return (parts.length > 1 ? parts[parts.length - 1] : text)!
      .replace(/Vastaa viestin lähettäjälle|Svara avsändaren/gi, "")
      .trim();
  }
  return "";
}

/** Plockar ett värde ur Wilmas "Etikett: värde"-tabell. */
function fieldFromTable(html: string, labels: string[]): string {
  for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...(row[1] ?? "").matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)].map(
      (c) => stripTags(c[1] ?? ""),
    );
    if (cells.length < 2) continue;
    const label = (cells[0] ?? "").replace(/:\s*$/, "").toLowerCase();
    if (labels.includes(label)) return cells[1] ?? "";
  }
  return "";
}
