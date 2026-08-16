"""Erzeugt die Inselumrisse der Karte ocean04 aus OSM-Kuestenlinien.

    python tools/balearen-import.py <overpass.json>

Die Rohdaten kommen von der Overpass-API (einmalig geholt, danach nicht mehr
noetig — das Ergebnis ist eingecheckter Quelltext):

    curl -X POST https://overpass-api.de/api/interpreter --data-urlencode 'data=
      [out:json][timeout:180];
      (
        relation["place"="island"]["name"~"^(Mallorca|Menorca|Eivissa)$"];
        way["place"="island"]["name"~"^(Mallorca|Menorca|Eivissa)$"];
      );
      out geom;'

Weg: Relations-Mitglieder zu geschlossenen Ringen verketten -> aequidistant auf
Meter projizieren -> Douglas-Peucker vereinfachen -> Inselformen mit MASSSTAB
verkleinern, die ABSTAENDE zusaetzlich stauchen, damit der Archipel mit
Wasserrand auf die Karte passt.

Ausgabe:
  apps/game-server/src/maps/ocean04-islands.ts   (generierter Quelltext)
  tools/out/ocean04-kontrolle.png                (Kontrollbild)
"""

import json
import math
import os
import sys

HIER = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HIER)

KARTE = 30_000.0        # Kantenlaenge der Zielkarte in Map-Units (= Meter)
MASSSTAB = 1.0 / 9.0    # Inselgroesse gegenueber der Wirklichkeit
ABSTAND_FAKTOR = 0.62   # zusaetzliche Stauchung der Zwischenraeume
TOLERANZ = 45.0         # Douglas-Peucker in ZIEL-Metern

# OSM-Name -> (Insel-Id, Anzeigename)
NAMEN = {
    'Mallorca': ('mallorca', 'Mallorca'),
    'Menorca': ('menorca', 'Menorca'),
    'Eivissa': ('ibiza', 'Ibiza'),
}
REIHENFOLGE = ['Mallorca', 'Menorca', 'Eivissa']


# --- Ringe aus OSM-Mitgliedern zusammensetzen --------------------------------

def ringe_aus_relation(rel):
    segmente = []
    for m in rel.get('members', []):
        if m.get('type') != 'way' or m.get('role') not in ('outer', ''):
            continue
        geo = m.get('geometry')
        if geo:
            segmente.append([(p['lon'], p['lat']) for p in geo])

    ringe = []
    while segmente:
        kette = segmente.pop(0)
        weiter = True
        while weiter and kette[0] != kette[-1]:
            weiter = False
            for i, seg in enumerate(segmente):
                if seg[0] == kette[-1]:
                    kette += seg[1:]
                elif seg[-1] == kette[-1]:
                    kette += seg[::-1][1:]
                elif seg[-1] == kette[0]:
                    kette = seg[:-1] + kette
                elif seg[0] == kette[0]:
                    kette = seg[::-1][:-1] + kette
                else:
                    continue
                segmente.pop(i)
                weiter = True
                break
        ringe.append(kette)
    return ringe


def flaeche(punkte):
    s = 0.0
    for i in range(len(punkte)):
        x1, y1 = punkte[i]
        x2, y2 = punkte[(i + 1) % len(punkte)]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2.0


def douglas_peucker(punkte, toleranz):
    if len(punkte) < 3:
        return punkte
    ax, ay = punkte[0]
    bx, by = punkte[-1]
    dx, dy = bx - ax, by - ay
    laenge = math.hypot(dx, dy)
    weit, index = -1.0, 0
    for i in range(1, len(punkte) - 1):
        px, py = punkte[i]
        if laenge < 1e-9:
            d = math.hypot(px - ax, py - ay)
        else:
            d = abs(dy * px - dx * py + bx * ay - by * ax) / laenge
        if d > weit:
            weit, index = d, i
    if weit <= toleranz:
        return [punkte[0], punkte[-1]]
    return (douglas_peucker(punkte[:index + 1], toleranz)[:-1]
            + douglas_peucker(punkte[index:], toleranz))


# --- Einlesen und aufbereiten -------------------------------------------------

quelle = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HIER, 'out', 'balearen.json')
daten = json.load(open(quelle, encoding='utf-8'))

roh = {}
for el in daten['elements']:
    name = el.get('tags', {}).get('name')
    if name not in NAMEN:
        continue
    if el['type'] == 'relation':
        ringe = ringe_aus_relation(el)
    elif el.get('geometry'):
        ringe = [[(p['lon'], p['lat']) for p in el['geometry']]]
    else:
        continue
    if not ringe:
        continue
    groesster = max(ringe, key=flaeche)
    if name not in roh or flaeche(groesster) > flaeche(roh[name]):
        roh[name] = groesster

fehlend = [n for n in REIHENFOLGE if n not in roh]
if fehlend:
    raise SystemExit('Nicht in den Rohdaten gefunden: %s' % ', '.join(fehlend))

alle = [p for ring in roh.values() for p in ring]
lon0 = (min(p[0] for p in alle) + max(p[0] for p in alle)) / 2
lat0 = (min(p[1] for p in alle) + max(p[1] for p in alle)) / 2
m_pro_grad_lat = 111_132.0
m_pro_grad_lon = 111_320.0 * math.cos(math.radians(lat0))

# Projektion: x nach Osten, y nach SUEDEN (Kartenursprung liegt oben links).
projiziert = {
    name: [((lon - lon0) * m_pro_grad_lon, -(lat - lat0) * m_pro_grad_lat)
           for lon, lat in ring]
    for name, ring in roh.items()
}

# Form verkleinern, Abstaende zusaetzlich stauchen.
inseln = {}
for name, ring in projiziert.items():
    cx = sum(p[0] for p in ring) / len(ring)
    cy = sum(p[1] for p in ring) / len(ring)
    zx, zy = cx * MASSSTAB * ABSTAND_FAKTOR, cy * MASSSTAB * ABSTAND_FAKTOR
    inseln[name] = [(zx + (x - cx) * MASSSTAB, zy + (y - cy) * MASSSTAB)
                    for x, y in ring]

# Archipel mittig auf die Karte legen.
axs = [p[0] for r in inseln.values() for p in r]
ays = [p[1] for r in inseln.values() for p in r]
vx = KARTE / 2 - (min(axs) + max(axs)) / 2
vy = KARTE / 2 - (min(ays) + max(ays)) / 2

fertig = {}
for name, ring in inseln.items():
    verschoben = [(x + vx, y + vy) for x, y in ring]
    offen = verschoben[:-1] if verschoben[0] == verschoben[-1] else verschoben
    vereinfacht = douglas_peucker(offen + [offen[0]], TOLERANZ)[:-1]
    fertig[name] = [(round(x, 1), round(y, 1)) for x, y in vereinfacht]

# --- Quelltext schreiben ------------------------------------------------------

zeilen = [
    '/* eslint-disable */',
    '/**',
    ' * GENERIERT von tools/balearen-import.py — nicht von Hand bearbeiten.',
    ' *',
    ' * Kuestenlinien der Balearen aus OpenStreetMap (ODbL), aequidistant',
    ' * projiziert, Form 1:%d, Abstaende auf %d %% gestaucht, Douglas-Peucker %d m.' % (
        round(1 / MASSSTAB), round(ABSTAND_FAKTOR * 100), round(TOLERANZ)),
    ' * Karte: %d x %d Map-Units. Ursprung oben links, y waechst nach Sueden.' % (
        KARTE, KARTE),
    ' */',
    "import type { Island } from '@subwarfare/shared';",
    '',
    'export const OCEAN04_ISLANDS: Island[] = [',
]
for name in REIHENFOLGE:
    insel_id, anzeige = NAMEN[name]
    ring = fertig[name]
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    zeilen.append('  {')
    zeilen.append("    id: '%s'," % insel_id)
    zeilen.append("    name: '%s'," % anzeige)
    zeilen.append('    // %.1f x %.1f km, %d Stuetzpunkte' % (
        (max(xs) - min(xs)) / 1000, (max(ys) - min(ys)) / 1000, len(ring)))
    zeilen.append('    polygon: [')
    for i in range(0, len(ring), 4):
        stueck = ring[i:i + 4]
        zeilen.append('      ' + ' '.join(
            '{ x: %.1f, y: %.1f },' % (x, y) for x, y in stueck))
    zeilen.append('    ],')
    zeilen.append('  },')
zeilen.append('];')
zeilen.append('')

ziel_ts = os.path.join(REPO, 'apps', 'game-server', 'src', 'maps', 'ocean04-islands.ts')
with open(ziel_ts, 'w', encoding='utf-8', newline='\n') as f:
    f.write('\n'.join(zeilen))

print('Geschrieben: %s' % os.path.relpath(ziel_ts, REPO))
for name in REIHENFOLGE:
    ring = fertig[name]
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    print('  %-10s %5.1f x %5.1f km, %4d Punkte, Mitte (%5.0f, %5.0f)' % (
        NAMEN[name][1], (max(xs) - min(xs)) / 1000, (max(ys) - min(ys)) / 1000,
        len(ring), sum(xs) / len(xs), sum(ys) / len(ys)))

rx = (min(p[0] for r in fertig.values() for p in r),
      max(p[0] for r in fertig.values() for p in r))
ry = (min(p[1] for r in fertig.values() for p in r),
      max(p[1] for r in fertig.values() for p in r))
print('  Wasserrand W/O %.1f / %.1f km, N/S %.1f / %.1f km' % (
    rx[0] / 1000, (KARTE - rx[1]) / 1000, ry[0] / 1000, (KARTE - ry[1]) / 1000))

# --- Kontrollbild (optional, nur mit Pillow) ---------------------------------

try:
    from PIL import Image, ImageDraw
except ImportError:
    raise SystemExit(0)

PX = 1000
bild = Image.new('RGB', (PX, PX), (28, 52, 74))
zeichner = ImageDraw.Draw(bild)
for i in range(1, 6):
    q = PX * i / 6
    zeichner.line([(q, 0), (q, PX)], fill=(40, 68, 92))
    zeichner.line([(0, q), (PX, q)], fill=(40, 68, 92))
for name in REIHENFOLGE:
    punkte = [(x / KARTE * PX, y / KARTE * PX) for x, y in fertig[name]]
    zeichner.polygon(punkte, fill=(196, 168, 116), outline=(240, 230, 200))
os.makedirs(os.path.join(HIER, 'out'), exist_ok=True)
bild.save(os.path.join(HIER, 'out', 'ocean04-kontrolle.png'))
print('Kontrollbild: tools/out/ocean04-kontrolle.png')
