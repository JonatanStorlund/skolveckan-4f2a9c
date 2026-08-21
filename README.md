# Wilma TL;DR

Klistra in ett Wilma-meddelande. Ut kommer det du faktiskt måste göra — 3–5 rader,
alltid på svenska, även när läraren skrivit på finska.

```
🎒 Ta med ytterkläder och stövlar          tis 26.8 08:15
📍 Utflykt till Nanoq-museet, 5 € kontant  tis 26.8
✍️ Returnera tillståndslappen              fre 29.8
🚫 Ingen skola, fortbildningsdag           mån 1.9
```

Varje rad bär med sig ett citat ur originalet, så du kan lita på raden utan att läsa
om brevet.

## Kom igång

```bash
npm install
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env     # nyckel från console.anthropic.com
npm start                                       # → http://127.0.0.1:4173
```

Servern lyssnar bara på `127.0.0.1` — inget ligger öppet mot nätet.

Rökprov från terminalen, utan webbläsare:

```bash
npm run try                       # kör fixtures/exempel-host.txt
npm run try -- min-fil.txt
```

## Ett klick från Wilma

Öppna appen, fäll ut *"Ett klick direkt från Wilma"* och dra bokmärket till
bokmärkesfältet. Sedan: öppna meddelandet i Wilma → markera texten → klicka
bokmärket. Texten följer med som URL-fragment till den lokala appen, som
sammanfattar direkt.

Bokmärket läser bara sidan du redan har öppen i din inloggade webbläsare. Inga
Wilma-uppgifter lagras, ingen inloggning automatiseras, ingen trafik går någon
annanstans än till din egen maskin och till Anthropics API.

## Hur det fungerar

| Fil | Ansvar |
| --- | --- |
| `rules/extraction.md` | Extraktionsreglerna — verktygets faktiska kärna, delad av båda vägarna |
| `src/wilma.ts` | Wilma-klienten: inloggning, roller per barn, meddelanden |
| `src/mcp.ts` | MCP-servern som Claude Code pratar med |
| `src/prompt.ts` | Läser reglerna och bygger systemprompten för webbappen |
| `src/extract.ts` | Anropet mot Claude, schema och sortering |
| `src/server.ts` | HTTP, `.env`, felöversättning till svenska |
| `public/index.html` | Gränssnittet och bokmärket |
| `fixtures/` | Testmeddelanden |

Modellen tvingas svara i ett schema (`output_config.format`) med ett fält per
faktum: `text`, `kind`, `date`, `date_label`, `time`, `quote`. Det som inte passar i
schemat kan inte smyga in i svaret som prosa.

Tre designval bär kvaliteten:

- **Referensdatum skickas in.** Servern skickar dagens datum och veckodag i
  Europe/Helsinki, så "på tisdag" blir `2026-08-26` och inte en gissning.
- **Citatet är obligatoriskt.** Varje rad måste peka på ordagrann text i
  originalet. Det gör påhitt dyrare för modellen än att hoppa över en rad.
- **Oklarheter separeras.** Motstridiga datum eller "senare i veckan" hamnar under
  *Oklart i meddelandet* i stället för att bli en självsäker rad.

Prompten ligger före cache-brytpunkten och referensdatumet efter, så
prompt-cachen träffar mellan anrop.

## Väg 2: Wilma-MCP i Claude Code

Hämtar meddelandena direkt ur Wilma, per barn. Ingen Anthropic-nyckel behövs här —
Claude är klienten och gör extraheringen själv.

### Ett barn, en inkorg

Ett vårdnadshavarkonto har **en roll per barn**, var och en med eget prefix
(`/!0425002`) och egen inkorg. En klient som bara använder den roll inloggningen
råkar landa på ser därför bara ett av barnen — vilket är precis vad som händer med
färdiga Wilma-klienter. `src/wilma.ts` läser rollväljaren från startsidan och
hämtar per roll.

Samma meddelande-id i två barns listor betyder att det gick till hela skolan.

### Inloggning

Lösenordet ligger i macOS-nyckelringen, aldrig i en fil. Kör en gång, i din egen
terminal så att prompten fungerar:

```bash
security add-generic-password -s wilma-tldr -a DIN_WILMA_ANVÄNDARE -w
```

Kommandot frågar efter lösenordet och ekar det inte. Byta senare: samma kommando
med `-U`. Användarnamn och skoladress är inte hemliga och står i `.mcp.json`.

### Använda

Starta om Claude Code så att MCP-servern plockas upp, och fråga sedan på svenska:

```
vad har kommit i Wilma?
vad behöver Nellie ta med nästa vecka?
```

Skillen i `.claude/skills/wilma/` hämtar, läser och kokar ner enligt samma regler
som webbappen, med ett avsnitt per barn.

### Verktyg

| Verktyg | Gör |
| --- | --- |
| `wilma_children` | Barnen med skola, klass och rollprefix |
| `wilma_messages` | Inkorgen per barn (alla barn om inget anges) |
| `wilma_read` | Hela texten i ett meddelande, för ett angivet barn |

Läs-bara med flit: servern kan inte skicka meddelanden, svara eller markera som
läst.

### Värt att veta

- **MFA stöds inte.** Kräver kontot engångskod misslyckas inloggningen med ett
  tydligt fel. Flödet är dokumenterat (`LoginResult: "mfa-required"` →
  `POST /api/v1/accounts/me/mfa/otp/check` → `Wilma2MFASID`, giltig 30 dagar).
- **Meddelandetexten hämtas som HTML.** Den dokumenterade JSON-varianten
  (`/messages/index_json/<id>`) svarar 403 på den här installationen; brödtexten
  ligger i `div.ckeditor`.
- **Inloggningen kräver en parad kaka.** `GET /index_json` ger både `SessionID` i
  kroppen och `Wilma2LoginID` som kaka, med samma `cnf.kid` i JWT:n. Skickas inte
  kakan med i `POST /login` nekas inloggningen — och curl tappar den tyst, eftersom
  sessionskakor inte skrivs till en cookie-jar-fil.
- **Oofficiell API.** Wilma har ingen öppen API för vårdnadshavare — det här är
  samma anrop som webbklienten gör. Det kan sluta fungera när Visma ändrar något.

## Övriga vägar in

- **E-postvidarebefordran.** Slå på notiser i Wilmas inställningar och se om ditt
  skoldistrikt skickar med själva texten eller bara "du har ett nytt meddelande".
  Följer texten med kan en IMAP-pollare mata extraheringen helt automatiskt — utan
  lagrade skoluppgifter. Inte byggt.
- **Push.** Wilma-appens push-registrering (`/api/v1/accounts/me/push-devices`)
  skulle ge notis i samma sekund ett meddelande kommer. Överkurs. Inte byggt.
