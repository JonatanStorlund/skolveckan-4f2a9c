---
name: wilma
description: Hämta Wilma-meddelanden och koka ner dem till vad föräldern faktiskt måste göra — 3-5 rader på svenska, med datum uträknade och citat ur originalet. Använd när användaren frågar efter nya Wilma-meddelanden, vad som händer i skolan, vad barnen behöver ta med, eller ber om en sammanfattning av ett skolmeddelande.
---

# Wilma TL;DR

Läraren skriver 700 ord om höstlöv och gruppens utveckling. Föräldern behöver fyra
rader. Den här skillen hämtar meddelandena och gör den omvandlingen.

## Arbetsgång

1. **Läs reglerna.** Öppna `rules/extraction.md` i projektroten. Det är den
   normerande specifikationen för extraheringen — följ den till punkt och pricka.
   Samma fil driver webbappen, så den är alltid i takt.

2. **Hämta listan.** `get_messages` med `folder: "inbox"`. Standard är de 10
   senaste; fler bara om användaren ber om det.

3. **Välj vilka som ska läsas.**
   - Utan närmare instruktion: alla olästa. Finns inga olästa, ta de 3 senaste och
     säg att inget är oläst.
   - Ber användaren om "nya" eller "den senaste": följ det.
   - Nämner användaren ett barn, en klass eller ett ämne: filtrera på avsändare
     och ämnesrad.

4. **Läs varje valt meddelande** med `get_message`. Läs hela — det praktiska ligger
   nästan alltid inbakat mitt i prosan, inte i slutet.

5. **Extrahera enligt `rules/extraction.md`.** Kort sagt: bara det som står i
   meddelandet, dagens datum som referens för "på tisdag", obligatoriskt citat per
   rad, oklarheter separerade i stället för gissade.

6. **Markera som läst** — bara om användaren uttryckligen ber om det. Gör det
   aldrig av eget initiativ; ett oläst meddelande är förälderns egen påminnelse.

## Utdataformat

Ett block per meddelande. Är det bara ett, hoppa över rubriken.

```
3B · Annika (klassföreståndare) · 21.8
  🎒 Ta med ytterkläder och stövlar        tis 26.8, buss 08:15
  📍 Utflykt till Nanoq-museet, 5 € kontant  tis 26.8
  ✍️ Returnera tillståndslappen            fre 29.8
  🚫 Ingen skola, fortbildningsdag         mån 1.9
```

Ikoner: 🎒 ta med · ✍️ deadline · 🚫 ingen skola · 🕒 ändrad tid · 📍 evenemang ·
💳 betalning · ℹ️ info.

Regler för utdata:

- **Svenska alltid**, även när meddelandet är på finska. Egennamn behålls som de står.
- **Datum utskrivna**, aldrig "på tisdag". Räkna ut dem mot dagens datum.
- **Citaten visas inte som standard** — de finns för din egen kontroll av varje rad.
  Visa dem om användaren frågar "var står det?" eller verkar tvivla på en rad.
- **Inget att göra är ett svar.** Skriv "Inget att göra — bara hälsningar och
  klassinfo" i stället för att pressa fram punkter.
- **Oklarheter sist**, under `⚠️ Oklart:`, en rad per sak. Hitta aldrig på ett
  datum för att slippa den raden.
- Har flera meddelanden samma ärende, slå ihop och nämn att det stod i två.

## Kalenderfrågor

Frågar användaren om schema, lov eller lektionstider — inte om meddelanden — använd
`get_schedule` eller `get_week_schedule` i stället, och svara kort på svenska.

## Att skicka meddelanden

`send_message` och `reply_to_message` skriver på riktigt till skolan i användarens
namn. Använd dem bara på uttrycklig begäran, och visa alltid mottagare, ämne och
hela texten för godkännande innan du skickar.

## Om det inte fungerar

- *"Authentication error"* — lösenordet i nyckelringen är fel eller utgånget:
  `security add-generic-password -U -s wilma-tldr -a "$WILMA_USERNAME" -w`
- *Kräver ditt konto engångskod?* Servern stöder inte MFA. Säg det rakt ut i stället
  för att försöka runt det.
