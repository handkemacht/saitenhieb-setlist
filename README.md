# Saitenhieb Setlist-Generator

Generiert aus der Gig-Historie der Band eine Setlist für eine gewünschte
Spielzeit. Statische Seite, kein Backend, kein Tracking.

**Live:** https://handkemacht.github.io/saitenhieb-setlist/

## Daten aktualisieren

1. Neues forScore-Backup (Backups-Panel → Backup erstellen, ohne Dateien)
   nach `data/forscore/` legen.
2. `python3 scripts/parse_forscore.py` → schreibt `public/data.json`.
3. Committen und pushen, die Action deployt.

Das Backup (`data/forscore/*.4sb`) ist gitignored und gehört nicht ins Repo:
es enthält die Gig-Namen und die Notenbilder. In `public/data.json` stehen nur
Datum und Songreihenfolge.

## Entwicklung

```bash
npm install
npm run dev      # lokaler Server
npm test         # Vitest
npm run build    # Typecheck + Build nach dist/
npm run demo     # druckt generierte Setlisten ins Terminal
```

Die Logik (`src/stats.ts`, `src/scorer.ts`) ist DOM-frei und getestet.
Wie der Scorer rechnet und warum die Konstanten so stehen, steht im Kopf von
`src/scorer.ts`. Die Projektvorgaben stehen in `CLAUDE.md`.
