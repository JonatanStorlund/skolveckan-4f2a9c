---
name: wilma
description: Hämta Wilma-meddelanden per barn och koka ner dem till vad föräldern faktiskt måste göra — några rader per barn på svenska, med datum uträknade och citat ur originalet. Använd när användaren frågar efter nya Wilma-meddelanden, vad som händer i skolan, vad barnen behöver ta med, eller ber om en översikt för ett eller flera barn.
---

# Wilma TL;DR

Läraren skriver 700 ord om höstlöv och gruppens utveckling. Föräldern behöver fyra
rader — och behöver veta vilket barn de gäller.

## Viktigt: ett barn, en inkorg

Ett vårdnadshavarkonto har en roll per barn, och **varje barn har sin egen inkorg**.
Meddelande-id:n är rollspecifika, så `wilma_read` behöver alltid veta vilket barn.

Samma id i två barns listor betyder att meddelandet gick till hela skolan eller
kommunen. Läs det **en gång** och redovisa det under *Båda barnen* — inte två
gånger.

## Arbetsgång

1. **Läs reglerna.** Öppna `rules/extraction.md` i projektroten. Det är den
   normerande specifikationen för extraheringen. Samma fil driver webbappen, så
   den är alltid i takt.

2. **`wilma_children`** om du inte redan vet vilka barn som finns.

3. **`wilma_messages`** — utan `child` för alla barn, med `child` när användaren
   nämner ett namn. Standard är 10 per barn.

4. **Välj vilka som ska läsas.**
   - Utan närmare instruktion: alla olästa. Finns inga olästa, ta de 3 senaste per
     barn och säg att inget är oläst.
   - Nämner användaren ett barn, en klass eller ett ämne: filtrera på det.
   - Id som förekommer hos flera barn läses en gång.

5. **`wilma_read`** med `child` och `id` för varje valt meddelande. Läs hela — det
   praktiska ligger nästan alltid inbakat mitt i prosan, inte i slutet.

6. **`wilma_exams`** när frågan rör prov, förhör, veckan som kommer, eller en
   allmän översikt. Prov står inte i meddelandena — de finns bara i
   provkalendern, så en översikt utan `wilma_exams` missar dem.

7. **Extrahera enligt `rules/extraction.md`.** Kort sagt: bara det som står i
   meddelandet, dagens datum som referens för "på tisdag", obligatoriskt citat per
   rad, oklarheter separerade i stället för gissade.

## Utdataformat

Gemensamt först, sedan ett avsnitt per barn. Har ett barn inget att göra, skriv det
på en rad i stället för att utelämna barnet.

```
Båda barnen
  🕒 Skoldagen slutar kl. 12.15              tis 25.8

Colin · Oxhamns skola, 7A
  ✍️ Gör dietanmälan igen, även om ni gjort den förra året
  ℹ️ Mobiler samlas in under första lektionen, återfås vid dagens slut

Nellie · Bonäs skola, 2b
  📍 Skolfotografering                       tor–fre 10–11.9
  🎒 Töm plastfickan hemma, lägg tillbaka den i väskan
  ⚠️ Oklart: föräldramöte i höst, datum inte bestämt ännu
```

Ikoner: 🎒 ta med · ✍️ deadline · 🚫 ingen skola · 🕒 ändrad tid · 📍 evenemang ·
💳 betalning · 📝 prov · ℹ️ info.

Prov redovisas med ämne och datum, och läggs sist i barnets avsnitt — de kräver
inget nu, men de ska gå att se. Har ett barn inga prov, skriv det på en rad.

Regler för utdata:

- **Svenska alltid**, även när meddelandet är på finska. Egennamn behålls som de står.
- **Datum utskrivna**, aldrig "på tisdag". Räkna ut dem mot dagens datum.
- **Förbrukat är inte aktuellt.** Gäller tiderna en vecka som redan gått, ta inte
  upp dem som kommande — nämn på en rad att de är förbrukade, och behåll bara det
  som återkommer (rutiner, vanor).
- **Citaten visas inte som standard** — de finns för din egen kontroll av varje rad.
  Visa dem om användaren frågar "var står det?" eller verkar tvivla på en rad.
- **Villkorat innehåll märks ut.** Gäller en rad bara vissa elever (hemspråk,
  valfria ämnen, specialkost), skriv villkoret i raden i stället för att påstå att
  det gäller barnet.
- **Inget att göra är ett svar.** "Inget att göra — bara hälsningar och klassinfo"
  slår framtvingade punkter.
- **Oklarheter sist**, under `⚠️ Oklart:`, en rad per sak. Hitta aldrig på ett
  datum för att slippa den raden.

## Att skicka meddelanden och markera som läst

Den här servern är läsbara-bara. Den kan inte skicka meddelanden, svara eller
markera något som läst — säg det rakt ut om användaren ber om det, i stället för
att leta efter en väg runt. Ett oläst meddelande är förälderns egen påminnelse.

## Om det inte fungerar

- *"Wilma nekade inloggningen"* — fel lösenord i nyckelringen:
  `security add-generic-password -U -s wilma-tldr -a "$WILMA_USERNAME" -w`
- *"Kontot kräver engångskod (MFA)"* — stöds inte än. Säg det rakt ut.
- *"Hittade inga barn på startsidan"* — Wilma har ändrat sin HTML. Rollväljaren
  parsas i `src/wilma.ts` (`children()`).
