"""Richtungs-Atlas für ein Schiffsmodell bauen — der komplette Weg in einem Aufruf.

    python tools/atlas-build.py <modellname> <quellordner>

Erwartet im Quellordner die 64 Meshy-Turntable-Renders (`*_S_spritesheet.png`
plus `*_View_<x>°___<y>°_spritesheet.png`). Liegt zusätzlich eine
Meshy-`*_metadata.json` daneben, kommen Azimut UND Pivot-Anker exakt von dort;
ohne sie greifen `winkel-lookup.json` (Namens-Kalibrierung) und
`anker-muster.json` (Fregatten-Pivots, indexweise übertragen).

Ergebnis: `apps/client/src/assets/vessels/<modell>/atlas.webp + atlas.json`.
Danach von Hand: Eintrag in VESSEL_MODELS (shared), DEFINITIONS (textures.ts,
Seitenprofil-px steht in der Ausgabe), DEFAULT_SHIP_STATS + ships-Tabelle.

Kurs-Formel (an den Kardinal-Frames sichtgeprüft): Kurs = (Azimut − 90°) mod 360.
Nach dem Bau IMMER dir-00/16/32/48 ansehen: Bug muss oben/rechts/unten/links zeigen.
"""

import json
import os
import re
import subprocess
import sys
import tempfile

HIER = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HIER)


def arbeitsliste(modell: str, quelle: str) -> list[dict]:
    meta_dateien = [f for f in os.listdir(quelle) if f.endswith("_metadata.json")]
    lookup: dict[str, float] = {}
    anker_von_meta: dict[str, dict] = {}

    if meta_dateien:
        meta = json.load(open(os.path.join(quelle, meta_dateien[0]), encoding="utf-8"))
        for v in meta["animations"][0]["views"]:
            name = v["spriteSheet"].replace("/", "_")
            if not name.endswith(".png"):
                name += ".png"
            anchor = v["anchor"]
            if isinstance(anchor, str):
                anchor = eval(anchor)  # Meshy schreibt das Feld als Python-Repr
            lookup[name] = float(v["azimuth"])
            anker_von_meta[name] = {"x": int(anchor["x"]), "y": int(anchor["y"])}
        print(f"Metadaten gefunden: Azimut + Pivots exakt ({len(lookup)} Views).")
    else:
        namen_lookup = json.load(open(os.path.join(HIER, "winkel-lookup.json"), encoding="utf-8"))
        for datei in os.listdir(quelle):
            if not datei.endswith(".png") or datei == "spritesheet.png":
                continue
            key = "S" if "_S_spritesheet" in datei else None
            if key is None:
                m = re.search(r"View_(-?\d+)", datei)
                key = m.group(1) if m else None
            if key in namen_lookup:
                lookup[datei] = namen_lookup[key]
        print(f"Keine Metadaten — Namens-Kalibrierung ({len(lookup)} Views), Anker aus Muster.")

    liste = []
    for datei, az in lookup.items():
        kurs = (az - 90.0) % 360.0
        eintrag = {"datei": datei, "azimut": az, "kurs": kurs, "index": round(kurs / 5.625) % 64}
        if datei in anker_von_meta:
            eintrag["ankerX"] = anker_von_meta[datei]["x"]
            eintrag["ankerY"] = anker_von_meta[datei]["y"]
        liste.append(eintrag)

    # Nicht jedes Modell hat 64 Views: Requisiten (Boje, Kiste) kommen mit 8.
    # Verlangt wird eine GLEICHMAESSIGE Teilmenge der 64er-Teilung — dann werden
    # die Indizes dicht auf 0..n-1 umnummeriert. Der Client rechnet
    # degreesPerFrame = 360/n selbst, ihn interessiert nur die dichte Reihe.
    indizes = sorted(e["index"] for e in liste)
    n = len(indizes)
    assert n > 0 and 64 % n == 0, f"View-Zahl {n} teilt 64 nicht: {indizes}"
    schritt = 64 // n
    assert indizes == [i * schritt for i in range(n)], f"Indizes nicht gleichmaessig: {indizes}"
    if schritt > 1:
        for e in liste:
            e["index"] = e["index"] // schritt
        print(f"{n} Views — Indizes auf dir-00..{n - 1:02d} verdichtet (Schritt {schritt}).")
    return liste


def main() -> None:
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    modell, quelle = sys.argv[1], sys.argv[2]

    liste = arbeitsliste(modell, quelle)
    mit_meta_ankern = "ankerX" in liste[0]
    tmp = os.path.join(tempfile.gettempdir(), f"{modell}-arbeit.json")
    json.dump(liste, open(tmp, "w", encoding="utf-8"))

    # Croppen + Shelf-Packing (System.Drawing) — schreibt atlas.png + Ergebnis-JSON.
    subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
         os.path.join(HIER, "atlas-pack.ps1"), "-Modell", modell, "-Quelle", quelle],
        check=True,
    )

    ergebnis = json.load(open(os.path.join(tempfile.gettempdir(), f"{modell}-atlas.json"),
                              encoding="utf-8-sig"))
    muster = json.load(open(os.path.join(HIER, "anker-muster.json"), encoding="utf-8"))

    frames = {}
    for f in sorted(ergebnis["frames"], key=lambda e: e["index"]):
        name = f"dir-{f['index']:02d}"
        anker = {"x": f["ax"], "y": f["ay"]} if mit_meta_ankern else dict(muster[name])
        frames[name] = {
            "frame": {"x": f["x"], "y": f["y"], "w": f["w"], "h": f["h"]},
            "rotated": False, "trimmed": False,
            "spriteSourceSize": {"x": 0, "y": 0, "w": f["w"], "h": f["h"]},
            "sourceSize": {"w": f["w"], "h": f["h"]},
            "anchor": anker,
        }
    ziel_dir = os.path.join(REPO, "apps", "client", "src", "assets", "vessels", modell)
    data = {"frames": frames, "meta": {"app": "subwarfare-atlas-packer", "image": "atlas.webp",
            "format": "RGBA8888", "size": {"w": ergebnis["breite"], "h": ergebnis["hoehe"]},
            "scale": "1"}}
    json.dump(data, open(os.path.join(ziel_dir, "atlas.json"), "w", encoding="utf-8"),
              separators=(",", ":"))

    png = os.path.join(ziel_dir, "atlas.png")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", png,
                    "-c:v", "libwebp", "-quality", "92",
                    os.path.join(ziel_dir, "atlas.webp")], check=True)
    os.remove(png)

    # Seitenprofil = Ost-Frame. Bei 64 Views ist das dir-16, bei n Views n/4.
    seite = next(f for f in ergebnis["frames"] if f["index"] == len(ergebnis["frames"]) // 4)
    print(f"FERTIG: {ziel_dir}")
    print(f"Seitenprofil (fuer DEFINITIONS.sideProfilePx): {seite['w']} px")
    print("Nicht vergessen: VESSEL_MODELS, DEFINITIONS, DEFAULT_SHIP_STATS, ships-Tabelle —")
    print("und dir-00/16/32/48 ANSEHEN (Bug oben/rechts/unten/links).")


if __name__ == "__main__":
    main()
