#!/usr/bin/env python3
"""
Band-Sheet -> public/data.json (ergänzt "members", "active" und "roles")

Quelle ist das Blatt "Setlist" aus "Songs_Setlist-Saitenhieb.xlsx", der
Arbeitsmappe der Band. Es trägt zwei Dinge, die das forScore-Backup nicht kennt:

  * Spalte "NOCH AKTIV?"  -> 1 = im Repertoire, 0 = ausgemustert
  * eine Spalte je Bandmitglied, was es bei dem Song macht:
        G = Gitarre, V = Gesang, B = Bass
        Klammern ("G(V)", "(V)", "GV(B)") = kann einspringen, ist nicht erste Wahl
        "/" oder leer = macht bei dem Song nichts
    Mario spielt Cajon und steht nicht im Sheet.

Spalten werden über ihre Überschrift gefunden, nicht über ihre Position: das
Sheet hat schon einmal die Spalten verschoben. Steht ein Mitgliedsname mehrfach
in der Kopfzeile (die alte Ansicht "ZUM FILTERN" führte die Kürzel doppelt),
gilt die letzte Spalte - das sind dort die gelb markierten, gepflegten.

Songs, die nur im Sheet stehen, kommen ohne Statistik in den Pool (plays 0,
duration null, file "" -> der .4ss-Export schreibt dafür ein <placeholder>).

Aufruf:
    python3 scripts/merge_roster.py                     # data/roster.csv -> public/data.json
    python3 scripts/merge_roster.py ~/Downloads/x.xlsx  # xlsx lesen, roster.csv mitschreiben
    python3 scripts/merge_roster.py --report            # nur Zuordnung zeigen, nichts schreiben

parse_forscore.py ruft das Skript am Ende selbst auf.
"""
import csv, json, os, re, sys, difflib, unicodedata, zipfile
import xml.etree.ElementTree as ET

ROSTER_CSV = "data/roster.csv"
DATA_JSON = "public/data.json"
SHEET_NAME = "Setlist"          # Blatt der Arbeitsmappe mit dem Repertoire

# Die Mitglieder, nach denen in der Kopfzeile gesucht wird. Kommt jemand dazu,
# reicht es, den Namen hier und als Spalte im Sheet zu ergänzen.
MEMBER_NAMES = ["Dave", "Martin", "Torsten", "Peter", "Markus"]
HEAD_TITLE, HEAD_ARTIST, HEAD_ACTIVE = "song", "interpret", "noch aktiv?"

# Ein sauberes Kürzel besteht nur aus G/V/B, Klammern machen daraus
# "kann einspringen". Alles andere ist ein Tippfehler und wird gemeldet -
# roster.ts liest nur die Großbuchstaben, der Rest fällt still unter den Tisch.
ROLE_CODE = re.compile(r"^(?:[GVB]|\([GVB]+\))+$")

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


# --- Quelle lesen ----------------------------------------------------------

XL_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL_NS = "{http://schemas.openxmlformats.org/package/2006/relationships}"
DOC_REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


def _column(ref):
    """Zellbezug "AB12" -> Spaltenindex 27 (0-basiert)."""
    index = 0
    for char in ref:
        if not char.isalpha():
            break
        index = index * 26 + (ord(char.upper()) - 64)
    return index - 1


def read_xlsx(path, sheet_name=SHEET_NAME):
    """
    Liest ein Blatt als Liste von Zeilen (Liste von Strings).

    Eine .xlsx ist ein ZIP aus XML, und gebraucht werden nur Texte und ein paar
    Zahlen - das geht mit der Standardbibliothek und erspart dem Workflow eine
    Installation. Formeln werden mit ihrem zuletzt berechneten Wert gelesen.
    """
    with zipfile.ZipFile(path) as zf:
        book = ET.fromstring(zf.read("xl/workbook.xml"))
        rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
        target = {r.get("Id"): r.get("Target") for r in rels}
        sheets = {s.get("name"): s.get(f"{DOC_REL}id") for s in book.iter(f"{XL_NS}sheet")}
        if sheet_name not in sheets:
            sys.exit(f"Blatt {sheet_name!r} fehlt in {path} (vorhanden: {', '.join(sheets)})")
        part = target[sheets[sheet_name]].lstrip("/")
        if not part.startswith("xl/"):
            part = f"xl/{part}"

        shared = []
        if "xl/sharedStrings.xml" in zf.namelist():
            for si in ET.fromstring(zf.read("xl/sharedStrings.xml")).iter(f"{XL_NS}si"):
                # Ein Eintrag kann in mehrere <r>-Läufe zerfallen (Teilformatierung).
                shared.append("".join(t.text or "" for t in si.iter(f"{XL_NS}t")))

        rows = []
        for row in ET.fromstring(zf.read(part)).iter(f"{XL_NS}row"):
            cells = {}
            for cell in row.iter(f"{XL_NS}c"):
                kind = cell.get("t")
                if kind == "inlineStr":
                    text = "".join(t.text or "" for t in cell.iter(f"{XL_NS}t"))
                else:
                    value = cell.find(f"{XL_NS}v")
                    text = "" if value is None or value.text is None else value.text
                    if kind == "s":
                        text = shared[int(text)]
                    elif kind == "b":
                        text = "1" if text == "1" else "0"
                    elif text.endswith(".0"):
                        text = text[:-2]
                cells[_column(cell.get("r", "A"))] = text.strip()
            rows.append([cells.get(i, "") for i in range(max(cells) + 1)] if cells else [])
        return rows


def read_rows(path):
    if path.lower().endswith((".xlsx", ".xlsm")):
        return read_xlsx(path)
    with open(path, encoding="utf-8") as fh:
        return [[c.strip() for c in row] for row in csv.reader(fh)]


def find_header(rows):
    """Index der Kopfzeile - die erste, die "Song" und "Interpret" trägt."""
    for i, row in enumerate(rows[:20]):
        lowered = [c.strip().lower() for c in row]
        if HEAD_TITLE in lowered and HEAD_ARTIST in lowered:
            return i
    sys.exit('keine Kopfzeile mit "Song" und "Interpret" gefunden')


def read_roster(path):
    rows = read_rows(path)
    head = find_header(rows)
    header = [c.strip() for c in rows[head]]
    lowered = [c.lower() for c in header]

    def column(name, required=True):
        # Die letzte passende Spalte gewinnt: siehe Kopfkommentar.
        found = [i for i, c in enumerate(lowered) if c == name]
        if not found and required:
            sys.exit(f'Spalte {name!r} fehlt in der Kopfzeile: {header}')
        return found[-1] if found else None

    col_title = column(HEAD_TITLE)
    col_artist = column(HEAD_ARTIST)
    col_active = column(HEAD_ACTIVE)
    members, col_members = [], []
    for name in MEMBER_NAMES:
        col_members.append(column(name.lower()))
        members.append({"id": fold(name).replace(" ", "-"), "name": name})

    entries = []
    for row in rows[head + 1:]:
        def cell(i):
            return row[i].strip() if i is not None and i < len(row) else ""
        if not cell(col_title):
            continue
        roles = {}
        for member, i in zip(members, col_members):
            code = cell(i)
            if code and code != "/":
                roles[member["id"]] = code
        entries.append({
            "title": cell(col_title),
            "artist": cell(col_artist),
            # Leeres Feld (eine Zeile im Sheet) als aktiv lesen, nicht verschweigen.
            "active": cell(col_active) != "0",
            "roles": roles,
        })
    return members, entries


def write_roster_csv(path, rows):
    """
    Hält eine lesbare Kopie des Sheets im Repo, damit git den Diff zeigt.
    Leere Zeilen und Spalten am Ende fliegen raus - ein Blatt meldet schnell
    ein paar hundert unbenutzte Zeilen, und die würden den Diff zumüllen.
    """
    trimmed = []
    for row in rows:
        row = list(row)
        while row and not row[-1]:
            row.pop()
        trimmed.append(row)
    while trimmed and not trimmed[-1]:
        trimmed.pop()
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as fh:
        csv.writer(fh).writerows(trimmed)


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
    source = args[0] if args else ROSTER_CSV
    json_path = args[1] if len(args) > 1 else DATA_JSON

    members, entries = read_roster(source)
    # Aus einer Arbeitsmappe fällt eine CSV-Kopie ab: die liegt im Repo und
    # macht in git sichtbar, was sich im Sheet geändert hat.
    roster_name = os.path.basename(source)
    if source.lower().endswith((".xlsx", ".xlsm")) and not report_only:
        write_roster_csv(ROSTER_CSV, read_rows(source))
        print(f"Blatt {SHEET_NAME!r} aus {roster_name} -> {ROSTER_CSV}")
        roster_name = os.path.basename(ROSTER_CSV)
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
        "roster": roster_name,
        "members": members,
        "songs": songs,
        "gigs": data["gigs"],
    }

    print(f"{len(pairs)} von {len(entries)} CSV-Zeilen auf forScore-Songs zugeordnet")
    fresh = [s for s in added if s["active"]]
    print(f"{len(added)} Songs nur aus der CSV ergänzt, davon {len(fresh)} aktiv:")
    for s in fresh:
        print(f"    + {s['id']}")
    odd = {}
    for song in songs:
        for member, code in (song["roles"] or {}).items():
            if not ROLE_CODE.match(code):
                odd.setdefault((member, code), []).append(song["id"])
    if odd:
        print(f"{len(odd)} unbekannte Kürzel im Sheet (bitte dort korrigieren):")
        for (member, code), where in sorted(odd.items()):
            print(f"    ! {member}: {code!r} bei {', '.join(where)}")

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
