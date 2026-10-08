# Saitenhieb Setlist-Generator

Übergabedatei für Claude Code. Lies sie komplett, bevor du anfängst.

## Was gebaut wird

Eine öffentlich erreichbare, statische Website, auf der die Coverband **Saitenhieb**
eine Setlist für eine gewünschte Spielzeit generieren lässt. Grundlage sind die
historischen Setlisten der Band (63 Gigs, 2023–2026, aus forScore exportiert).
Der Nutzer kann einzelne Songs rauskicken (es rückt der wahrscheinlichste Song
für diese Position nach), Songs manuell einfügen und die Liste exportieren.

Sprache der Oberfläche: Deutsch. Eine Seite, keine Logins, kein Backend.

## Entscheidungen, die feststehen

| Thema | Entscheidung |
|---|---|
| Stack | Vite + TypeScript, Vanilla DOM (kein Framework). Vitest für die Logik. |
| Hosting | GitHub Pages über GitHub Action (`.github/workflows/deploy.yml`). `base` in `vite.config.ts` auf den Repo-Namen setzen. |
| Daten | `public/data.json`, erzeugt von `scripts/parse_forscore.py`. Wird committet. |
| Datenschutz | Gigs tragen nur Datum und Reihenfolge, **keine Namen**. Das forScore-Backup (`data/forscore/*.4sb`) ist gitignored und darf **nie** committet werden (enthält Gig-Namen und Notenbilder). |
| Spielzeiten | 1 h, 1,5 h, 2 h, 2,5 h, 3 h (Buttons). Spielzeit = Songlängen + Puffer pro Song (Default 30 s, einstellbar 0–90 s). Keine Pausenplanung. |
| Gewichtung | Abklingend: Gewicht eines Gigs = `0.5 ** (alter_in_monaten / halbwertszeit)`, Halbwertszeit Default 12 Monate, per Regler 3–36 Monate einstellbar. |
| Nachrücken | Score aus Position **und** Nachbarn (siehe Algorithmus). |
| Manuell einfügen | Suche im Song-Pool **oder** Freitext (dann ohne Statistik, Dauer Default 3:45, editierbar). |
| Export | Text kopieren, forScore-Setlist (`.4ss`) laden, Teilen-Link (Setlist in URL-Hash), Druckansicht (Print-CSS). |

## Datenmodell (`public/data.json`)

```jsonc
{
  "generated": "2026-10-08",
  "source": "Backup_2026-10-08.4sb",
  "songs": [
    { "id": "Avicii - Wake me up",      // = forScore-Dateiname ohne .pdf, stabil
      "file": "Avicii - Wake me up.pdf", // für den .4ss-Export
      "title": "Wake me up", "artist": "Avicii",
      "duration": 247,                   // Sekunden, null wenn in forScore nicht gepflegt (3 Songs)
      "plays": 62 }                      // ungewichtet, nur zur Anzeige
  ],
  "gigs": [
    { "id": "001", "date": "2023-02-13", "songs": ["George Ezra - Blame it on Me", "..."] }
  ]
}
```

113 Songs im Pool (106 davon je gespielt), 63 Gigs. Alle Statistiken werden
**im Browser** aus `gigs` berechnet, damit Halbwertszeit und Puffer live wirken.
Nichts vorberechnen, was von Reglern abhängt.

## Algorithmus

Ein einziger Scorer wird für beides benutzt: das Generieren und das Nachrücken.

### Begriffe

- `w(g)` Gewicht eines Gigs (siehe Gewichtung).
- `r = i / (N - 1)` relative Position eines Slots `i` in einer Liste mit `N` Songs (0 = Opener, 1 = Closer).
- Für jeden Song `s` aus den Gigs: Liste seiner Vorkommen `(w, r_occ)` und die
  gewichteten Nachbarzählungen `after[p][s]` (s folgte auf p) und `before[n][s]` (s stand vor n).

### Score eines Kandidaten `s` für Slot `i` mit Vorgänger `prev` und Nachfolger `next`

```
pop(s)   = Σ w(g) über alle Vorkommen                       // gewichtete Popularität
pos(s,r) = Σ w(g) · K((r - r_occ) / h)   mit K = Gauß, h = 0.08   // Dichte an dieser Position
           + ε (ε = 0.01 · pop(s), damit nie 0)
trans(s) = 1 + λ · ( after[prev][s] / Σ after[prev][*]  +  before[next][s] / Σ before[next][*] )
           λ = 2; fehlende Nachbarn (Listenanfang/-ende, Freitext-Songs) tragen 0 bei
score(s) = pos(s,r) · trans(s)
```

`pos` enthält bereits die Popularität (viele Vorkommen → hohe Dichte), deshalb
kein weiterer Pop-Faktor. Werte in Tests gegen die Erwartung prüfen:
`Jason Mraz - I'm Yours` muss bei r=0 klar vorn liegen (22× Opener),
`Robbie Williams - Angels` bei r=1 (14× Closer), `Avicii - Wake me up` bei r≈0.6.

### Harte Regeln

1. Keine Dopplungen: ein Song höchstens einmal in der Liste.
2. Kein gleicher Artist direkt hintereinander (Artist-Feld, case-insensitive). Nur
   wenn kein anderer Kandidat mit Score > 0 existiert, darf die Regel brechen.
3. In der Session rausgekickte Songs kommen nicht automatisch wieder (Blockliste,
   sichtbar und per Klick aufhebbar).
4. Songs ohne Dauer (`null`) zählen mit 225 s und werden in der UI markiert.

### Generieren

1. `N` schätzen: `N = round(zielsekunden / (ø Dauer der 40 populärsten Songs + Puffer))`.
2. Slots `0 … N-1` nacheinander füllen: für Slot `i` den Kandidaten mit höchstem
   Score wählen, `prev` = gerade gesetzter Song, `next` = unbekannt (0). Für den
   letzten Slot zusätzlich `r = 1` erzwingen, damit ein echter Closer kommt.
3. Gesamtzeit prüfen. Liegt sie > 2 min über dem Ziel: den Song mit dem niedrigsten
   Score aus der Mitte entfernen; liegt sie > 2 min darunter: an der Stelle mit der
   größten Dichtelücke einen weiteren Song einfügen. Maximal 5 Iterationen.
4. Button **„Neu würfeln“**: dieselbe Logik, aber Auswahl per Softmax über die
   Top-5-Kandidaten je Slot (Temperatur 0.7), damit Varianten entstehen. Der
   erste Aufruf ist immer deterministisch (argmax).

### Rauskicken → Nachrücken

Song an Slot `i` entfernen → Kandidat mit höchstem Score für genau diesen Slot
(`r`, `prev = liste[i-1]`, `next = liste[i+1]`) rückt an die Stelle. Vorher
`N` nicht ändern. Zusätzlich **„Alternativen“**: die Top-5 für diesen Slot mit
ihrem Score-Anteil anzeigen, der Nutzer kann statt des Vorschlags einen davon
wählen.

### Manuell einfügen

An Slot `i` einen Song aus dem Pool (Suche über Titel + Artist, fuzzy) oder als
Freitext (Titel, Artist optional, Dauer) **einfügen** (Liste wird länger) oder
**ersetzen**. Eingefügte Songs sind „gepinnt“ und werden von Neu-würfeln und
Nachrücken nie verdrängt. Pins per Klick lösbar.

### Weitere Interaktionen

- Drag & Drop zum Umsortieren (gepinnte Songs ebenso).
- Gesamtzeit live: reine Songzeit und Zeit mit Puffer, farbig gegen das Ziel
  (grün ±2 min, gelb ±5 min, sonst rot).
- Pro Song: Position, Titel, Artist, Dauer, kleines Badge „gespielt 27×“
  (ungewichtet), bei Nachrückern ein dezenter Hinweis „nachgerückt“.

## Export

- **Text kopieren**: `Saitenhieb · 2 h · 28 Songs · 106 min (+Puffer 120 min)`, dann
  `01. Artist – Titel  (3:42)` je Zeile.
- **forScore-Setlist (.4ss)**: XML gemäß forScore Open Setlist Format
  (https://forscore.co/developers-file-types/):
  ```xml
  <?xml version="1.0" encoding="UTF-8"?>
  <forScore kind="setlist" version="1.0" title="Saitenhieb 2h 2026-10-08">
    <score path="Avicii - Wake me up.pdf" title="Avicii - Wake me up"/>
    <placeholder title="Freitext-Song"/>
  </forScore>
  ```
  Pool-Songs als `<score path=file>`, Freitext-Songs als `<placeholder>`.
  Download als Blob mit MIME `application/octet-stream`, Dateiname
  `Saitenhieb_<Dauer>_<Datum>.4ss`.
- **Teilen-Link**: Zustand in `location.hash`: Song-IDs komprimiert (z. B.
  Index in der alphabetischen Pool-Liste, base64url), Freitext-Songs inline als
  `t:<titel>|<artist>|<sek>`, plus Puffer und Halbwertszeit. Beim Laden mit Hash
  die Liste wiederherstellen statt zu generieren.
- **Druck**: Print-Stylesheet, nur die nummerierte Liste groß und kontrastreich,
  Kopfzeile mit Datum und Gesamtzeit, keine Buttons.

## UI

- Mobile first, läuft auf iPhone/iPad in der Probe. Großes Touch-Ziel je Zeile
  (≥ 44 px), Swipe-nach-links = rauskicken wäre schön, ist aber optional.
- Dunkles Farbschema als Default (Bühne), helles per `prefers-color-scheme`.
- Oberer Bereich: Spielzeit-Buttons, „Generieren“, „Neu würfeln“; aufklappbar
  „Einstellungen“ mit Puffer- und Halbwertszeit-Regler. Darunter die Liste.
  Unten (sticky) die Zeitanzeige und die Export-Buttons.
- Keine UI-Bibliothek. Eine CSS-Datei mit Custom Properties.
- Kein Tracking, keine externen Requests außer dem eigenen `data.json`.

## Projektstruktur

```
.
├── CLAUDE.md
├── .gitignore               # data/forscore/ , node_modules, dist
├── index.html
├── vite.config.ts           # base: '/<repo-name>/'
├── package.json
├── src/
│   ├── main.ts              # Bootstrap, State, Rendering
│   ├── data.ts              # Laden + Typen für data.json
│   ├── stats.ts             # Gewichte, pos/trans-Tabellen (reine Funktionen)
│   ├── scorer.ts            # score(), generate(), replaceAt(), alternatives()
│   ├── export.ts            # text, 4ss, share-link, print
│   ├── ui/                  # DOM-Rendering, Drag & Drop, Suche
│   └── styles.css
├── tests/                   # Vitest: stats, scorer, export (4ss ist valides XML)
├── public/data.json
├── scripts/parse_forscore.py
├── data/forscore/           # gitignored, hier liegt das .4sb
└── .github/workflows/deploy.yml
```

## Daten aktualisieren (Workflow für Markus)

1. Neues forScore-Backup (Backups-Panel → Backup erstellen, **ohne** Dateien,
   reicht) nach `data/forscore/` legen.
2. `python3 scripts/parse_forscore.py` → schreibt `public/data.json`.
3. Committen und pushen, die Action deployt.

Das Skript existiert bereits und ist getestet. Es filtert nach dem
`composer`-Feld `Saitenhieb` (so sind die Band-Songs in forScore markiert),
nimmt nur Setlisten mit Namen `YYMMDD_…`, wirft gleichtägige Duplikate raus und
anonymisiert. Nicht umschreiben, höchstens erweitern.

## Arbeitsweise

- Zuerst `stats.ts` und `scorer.ts` mit Tests, dann UI. Die Logik muss ohne DOM
  testbar sein.
- Jeden Schritt mit `npm run build` prüfen; vor dem ersten Push ein lokales
  `npm run preview` auf dem Handy testen.
- Deutsch in UI-Texten und Commit-Messages, Code und Kommentare auf Englisch.
- Keine zusätzlichen Abhängigkeiten ohne Grund. Erlaubt: vite, typescript,
  vitest. Fuzzy-Suche selbst schreiben (einfaches Token-Matching reicht).
- Bei Unklarheiten im Algorithmus lieber eine Konstante einführen und oben in
  `scorer.ts` dokumentieren als nachfragen; die Werte (h, λ, ε, Temperatur)
  dürfen nach Gefühl nachjustiert werden, solange die Tests oben weiter gelten.

## Offene Punkte (vom Nutzer zu entscheiden, bis dahin Default)

- GitHub-Repo-Name/URL → steht in `git remote -v`; `base` daraus ableiten.
- Eigene Domain später via CNAME möglich, erst mal `<user>.github.io/<repo>/`.
