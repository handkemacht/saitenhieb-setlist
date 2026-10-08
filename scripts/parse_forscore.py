#!/usr/bin/env python3
"""
forScore-Backup (.4sb) -> public/data.json

Liest ein forScore-Backup, filtert die Saitenhieb-Setlisten heraus und schreibt
einen anonymisierten Datensatz (keine Gig-Namen, nur Datum + Reihenfolge).

Aufruf:
    python3 scripts/parse_forscore.py data/forscore/Backup.4sb
    python3 scripts/parse_forscore.py            # nimmt das neueste .4sb in data/forscore/

Containerformat (reverse-engineered, forScore 14/15):
    "<--4SBV02-->" dann beliebig viele Einträge:
        16 Zeichen  Länge des Namens (dezimal, rechtsbündig)
        16 Zeichen  Länge der Daten (dezimal, rechtsbündig)
        Name        (UTF-8)
        Daten       (meist gzip)
    Erster Eintrag = binary plist mit der gesamten Bibliothek:
        "<datei>.pdf|<feld>"  -> title, composer, minutes, seconds, keywords, ...
        "&SYS;setlists"       -> Liste der Setlist-Schlüssel
        "&SET;<name>"         -> Liste von {Title, FilePath, Identifier}
    Weitere Einträge = PNG-Thumbnails der Noten (werden ignoriert).
"""
import sys, re, json, gzip, plistlib, glob, os, collections, unicodedata
from datetime import date

BAND_COMPOSER = "Saitenhieb"          # composer-Feld, an dem die Band erkannt wird
EXCLUDE_FILES = {                      # Spezialdateien, die keine echten Songs sind
    "Münchener Freiheit - Ohne dich_DAVE.pdf",
    "Dave Überraschung.pdf",
}
# Dateinamen aus dem Backup sind NFD ("U\u0308"), die Literale hier NFC.
# Ohne Normalisierung greift der Vergleich bei Umlauten nicht.
EXCLUDE_FILES = {unicodedata.normalize("NFC", f) for f in EXCLUDE_FILES}
GIG_RE = re.compile(r"^(\d{6})[_-](.*)$")   # Setlist-Namen: YYMMDD_Name

def read_container(path):
    b = open(path, "rb").read()
    assert b.startswith(b"<--4SBV02-->"), "kein 4SB-V02-Container"
    p = 12
    while p < len(b):
        nl, dl = int(b[p:p+16]), int(b[p+16:p+32]); p += 32
        name = b[p:p+nl].decode("utf-8"); p += nl
        data = b[p:p+dl]; p += dl
        if data[:2] == b"\x1f\x8b":
            data = gzip.decompress(data)
        yield name, data

def parse_date(yymmdd):
    y, m, d = int(yymmdd[:2]) + 2000, int(yymmdd[2:4]), int(yymmdd[4:6])
    try:
        return date(y, m, d).isoformat()
    except ValueError:
        return None   # Tippfehler wie 249511 -> Gig wird übersprungen

def split_title(title):
    # Geschuetzte und schmale Leerzeichen zuerst normalisieren, sonst greift
    # " - " bei Titeln wie "Radiohead \u2013\u00a0Creep" nicht.
    title = title.replace("\u00a0", " ").replace("\u202f", " ").replace("\u2009", " ")
    title = re.sub(r"\s+", " ", title).strip()
    # Erst mit Leerzeichen auf beiden Seiten, dann die schlampigen Varianten
    # ("The Beach Boys- Surfin USA").
    for sep in (" - ", " – ", " — ", "- ", "– ", "— ", " -", " –", " —"):
        if sep in title:
            a, t = title.split(sep, 1)
            if a.strip() and t.strip():
                return a.strip(), t.strip()
    return None, title.strip()

def main():
    args = sys.argv[1:]
    if args:
        src = args[0]
    else:
        files = sorted(glob.glob("data/forscore/*.4sb"), key=os.path.getmtime)
        if not files:
            sys.exit("kein .4sb in data/forscore/ gefunden")
        src = files[-1]
    lib = None
    for name, data in read_container(src):
        if data.startswith(b"bplist"):
            lib = plistlib.loads(data); break
    assert lib, "keine Bibliotheks-plist im Backup"

    # Songs
    scores = collections.defaultdict(dict)
    for k, v in lib.items():
        parts = k.split("|")
        if len(parts) == 2 and parts[0].endswith(".pdf"):
            scores[parts[0]][parts[1]] = v
    pool = {f for f, m in scores.items()
            if m.get("composer") == BAND_COMPOSER
            and unicodedata.normalize("NFC", f) not in EXCLUDE_FILES}

    # Gigs
    gigs = []
    for key in lib.get("&SYS;setlists", []):
        name = key[5:]
        m = GIG_RE.match(name)
        if not m: continue
        iso = parse_date(m.group(1))
        if not iso: continue
        items = [i["FilePath"] for i in lib.get(key, []) if isinstance(i, dict)]
        items = [f for f in items if f in pool]
        if len(items) < 5: continue
        gigs.append({"date": iso, "songs": items, "_name": name})

    # Duplikate (z. B. "Bensberg" / "Bensberg 2" am selben Tag): längere Liste behalten
    gigs.sort(key=lambda g: (g["date"], -len(g["songs"])))
    dedup = []
    for g in gigs:
        same_day = [h for h in dedup if h["date"] == g["date"]]
        if any(len(set(g["songs"]) & set(h["songs"])) / max(len(g["songs"]), 1) >= 0.9 for h in same_day):
            continue
        dedup.append(g)
    gigs = dedup

    used = {f for g in gigs for f in g["songs"]}
    songs = []
    for f in sorted(pool):
        m = scores[f]
        title = m.get("title") or f[:-4]
        artist, name = split_title(title)
        dur = (m.get("minutes") or 0) * 60 + (m.get("seconds") or 0)
        songs.append({
            "id": f[:-4],
            "file": f,
            "title": name,
            "artist": artist,
            "duration": dur or None,
            "plays": sum(g["songs"].count(f) for g in gigs),
        })

    out = {
        "generated": date.today().isoformat(),
        "source": os.path.basename(src),
        "songs": songs,
        "gigs": [{"id": f"{i:03d}", "date": g["date"], "songs": [f[:-4] for f in g["songs"]]}
                 for i, g in enumerate(gigs, 1)],
    }
    os.makedirs("public", exist_ok=True)
    with open("public/data.json", "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    print(f"{len(songs)} Songs ({len(used)} je gespielt), {len(gigs)} Gigs "
          f"{gigs[0]['date']} bis {gigs[-1]['date']} -> public/data.json")

if __name__ == "__main__":
    main()
