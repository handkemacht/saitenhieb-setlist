#!/usr/bin/env python3
"""
data/roster.csv -> public/data.json (ergänzt "members", "active" und "roles")

Die CSV ist der Export des Google-Sheets "Songs_Setlist Saitenhieb - ZUM
FILTERN". Sie trägt zwei Dinge, die das forScore-Backup nicht kennt:

  * Spalte D  "NOCH AKTIV?"  -> 1 = im Repertoire, 0 = ausgemustert
  * Spalte T-X  pro Bandmitglied, was es bei dem Song macht:
        G = Gitarre, V = Gesang, B = Bass
        Klammern ("G(V)", "(V)", "GV(B)") = kann einspringen, ist nicht erste Wahl
        "/" oder leer = macht bei dem Song nichts
    Mario spielt Cajon und steht nicht im Sheet.

Songs, die nur in der CSV stehen, kommen ohne Statistik in den Pool (plays 0,
duration null, file "" -> der .4ss-Export schreibt dafür ein <placeholder>).

Aufruf:
    python3 scripts/merge_roster.py                 # data/roster.csv -> public/data.json
    python3 scripts/merge_roster.py roster.csv data.json
    python3 scripts/merge_roster.py --report        # nur Zuordnung zeigen, nichts schreiben

parse_forscore.py ruft das Skript am Ende selbst auf.
"""
import csv, json, os, re, sys, difflib, unicodedata

ROSTER_CSV = "data/roster.csv"
DATA_JSON = "public/data.json"

HEADER_ROW = 2          # 0-basiert: Zeile 3 der CSV trägt die Spaltennamen
COL_TITLE, COL_ARTIST, COL_ACTIVE = 0, 1, 3
COL_MEMBERS = range(19, 24)      # Spalten T-X, die gelb markierten Filterspalten

# Zuordnungen, die der Fuzzy-Match nicht treffen kann: CSV-Titel -> forScore-Id.
# "" heißt: in forScore bewusst nicht vorhanden, nicht weiter melden.
ALIASES = {
    "La Bamba / Twist and Shout": "Ritchie Valens - La Bamba",
    "Wackelkontakt": "Wackelkontakt - Oimara",          # Artist/Titel in forScore getauscht
    # forScore führt den Song unter der Coverversion, das Sheet unter dem Original.
    "Easy": "Faith No More - Easy",
    "Something just like this": "Coldplay - Something Just Like This",
}

MIN_SCORE = 0.78        # darunter gilt ein Treffer als zu unsicher
MIN_LEAD = 0.04         # Vorsprung, den der Beste vor dem Zweiten haben muss


def fold(value):
    """Kleingeschrieben, ohne Akzente, ohne Klammerzusätze und Satzzeichen."""
    value = unicodedata.normalize("NFKD", value.lower())
    value = "".join(c for c in value if not unicodedata.combining(c))
    value = re.sub(r"\(.*?\)", " ", value)
    value = value.replace("&", " and ").replace("ß", "ss")
    return re.sub(r"[^a-z0-9]+", " ", value).strip()


def tokens(value):
    return [t for t in fold(value).split() if t]


def strip_suffix(title):
    """forScore-Dubletten heißen "... 2" oder "..._C" — das ist kein Titelteil."""
    return re.sub(r"(?:_[A-Za-z]|\s+\d+)$", "", title).strip()


def similarity(a, b):
    """Ähnlichkeit zweier Strings, mit Bonus wenn der kürzere im längeren steckt."""
    fa, fb = fold(a), fold(b)
    if not fa or not fb:
        return 0.0
    ratio = difflib.SequenceMatcher(None, fa, fb).ratio()
    short, long = sorted((tokens(a), tokens(b)), key=len)
    # Token-Containment nur, wenn der kürzere Teil ein tragendes Wort hat:
    # sonst würde "One" in jedem Titel stecken, der "one" enthält.
    if short and set(short) <= set(long) and max(len(t) for t in short) >= 4:
        ratio = max(ratio, 0.9)
    return ratio


def match_score(csv_title, csv_artist, song):
    title = similarity(csv_title, strip_suffix(song["title"]))
    artist = similarity(csv_artist, song["artist"] or "")
    # Manche Songs stehen in forScore mit getauschtem Artist/Titel im Dateinamen.
    swapped = min(
        similarity(csv_title, song["artist"] or ""),
        similarity(csv_artist, strip_suffix(song["title"])),
    )
    return max(0.6 * title + 0.4 * artist, swapped)


def read_roster(path):
    with open(path, encoding="utf-8") as fh:
        rows = list(csv.reader(fh))
    header = rows[HEADER_ROW]
    members = [{"id": fold(header[i]).replace(" ", "-"), "name": header[i].strip()}
               for i in COL_MEMBERS]
    entries = []
    for row in rows[HEADER_ROW + 1:]:
        if not row or not row[COL_TITLE].strip():
            continue
        active = row[COL_ACTIVE].strip() if len(row) > COL_ACTIVE else ""
        roles = {}
        for member, i in zip(members, COL_MEMBERS):
            code = (row[i] if i < len(row) else "").strip()
            if code and code != "/":
                roles[member["id"]] = code
        entries.append({
            "title": row[COL_TITLE].strip(),
            "artist": row[COL_ARTIST].strip(),
            # Leeres Feld (eine Zeile im Sheet) als aktiv lesen, nicht verschweigen.
            "active": active != "0",
            "roles": roles,
        })
    return members, entries


def assign(entries, songs):
    """CSV-Zeile -> forScore-Song. Gibt (paare, csv_ohne_treffer) zurück."""
    by_id = {s["id"]: s for s in songs}
    pairs, orphans = {}, []
    for item in entries:
        alias = ALIASES.get(item["title"])
        if alias is not None:
            if alias and alias in by_id:
                pairs[alias] = item
            elif alias:
                sys.exit(f"ALIASES zeigt auf unbekannte Id: {alias!r}")
            continue
        ranked = sorted(
            ((match_score(item["title"], item["artist"], s), s) for s in songs),
            key=lambda x: (-x[0], x[1]["id"]),
        )
        best, second = ranked[0], (ranked[1] if len(ranked) > 1 else (0.0, None))
        if best[0] < MIN_SCORE or best[0] - second[0] < MIN_LEAD:
            orphans.append(item)
            continue
        taken = pairs.get(best[1]["id"])
        if taken:
            # Zwei CSV-Zeilen auf denselben Song: die mit dem besseren Score gewinnt.
            if match_score(taken["title"], taken["artist"], best[1]) >= best[0]:
                orphans.append(item)
                continue
            orphans.append(taken)
        pairs[best[1]["id"]] = item
    return pairs, orphans


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    report_only = "--report" in sys.argv
    csv_path = args[0] if args else ROSTER_CSV
    json_path = args[1] if len(args) > 1 else DATA_JSON

    members, entries = read_roster(csv_path)
    with open(json_path, encoding="utf-8") as fh:
        data = json.load(fh)
    # Nur die Songs aus dem forScore-Backup sind Match-Kandidaten. Die Songs,
    # die ein früherer Lauf aus der CSV ergänzt hat, haben kein "file" und
    # werden unten neu aufgebaut - sonst würde das Skript gegen sich selbst
    # matchen und beim zweiten Lauf andere Ergebnisse liefern.
    songs = [s for s in data["songs"] if s.get("file")]

    pairs, orphans = assign(entries, songs)

    for song in songs:
        item = pairs.get(song["id"])
        if item:
            song["active"] = item["active"]
            song["roles"] = item["roles"]
        else:
            # Kein Sheet-Eintrag: keine Besetzungs-Info, also auch keine Einschränkung.
            song["active"] = True
            song["roles"] = None

    # Auch ausgemusterte Songs ohne forScore-Datei kommen mit: der Generator
    # zieht sie nicht, aber sie bleiben über "Song einfügen" auffindbar.
    added = []
    for item in orphans:
        song_id = f"{item['artist']} - {item['title']}" if item["artist"] else item["title"]
        # Die Ids aus dem Backup sind NFD (macOS-Dateinamen), der Sheet-Export
        # ist NFC. Einheitlich NFD halten, sonst stehen "Männer" und "Männer"
        # als zwei verschiedene Songs im Pool.
        song_id = unicodedata.normalize("NFD", song_id)
        added.append({
            "id": song_id, "file": "",
            "title": item["title"], "artist": item["artist"] or None,
            "duration": None, "plays": 0,
            "active": item["active"], "roles": item["roles"],
        })
    songs = sorted(songs + added, key=lambda s: s["id"])

    out = {
        "generated": data["generated"],
        "source": data["source"],
        "roster": os.path.basename(csv_path),
        "members": members,
        "songs": songs,
        "gigs": data["gigs"],
    }

    print(f"{len(pairs)} von {len(entries)} CSV-Zeilen auf forScore-Songs zugeordnet")
    fresh = [s for s in added if s["active"]]
    print(f"{len(added)} Songs nur aus der CSV ergänzt, davon {len(fresh)} aktiv:")
    for s in fresh:
        print(f"    + {s['id']}")
    blind = [s for s in songs if s["roles"] is None]
    print(f"{len(blind)} forScore-Songs ohne Sheet-Eintrag (kein Besetzungsfilter):")
    for s in blind:
        print(f"    ? {s['id']}  plays={s['plays']}")
    inactive = [s for s in songs if not s["active"]]
    print(f"{len(inactive)} Songs als inaktiv markiert (nicht im Generator-Pool)")

    if report_only:
        print("\n--report: public/data.json nicht geschrieben")
        return
    with open(json_path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    print(f"-> {json_path}")


if __name__ == "__main__":
    main()
