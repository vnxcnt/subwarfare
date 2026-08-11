"""
Erzeugt die Effekt-Grafiken (Schaum, Rauch, Wasserfontäne, Explosion).

Warum prozedural statt gemalt: Schaum, Gischt und Rauch SIND Rauschfelder —
mit fBm-Rauschen, radialem Abfall und einer physikalisch motivierten Farbrampe
kommt man näher an das echte Aussehen als mit der Hand, und die Sätze lassen
sich jederzeit in anderer Auflösung oder Bildzahl neu bauen.

Ersetzt die bisher mit `Graphics` gezeichneten Kreise und Striche: die sahen
zwangsläufig nach Programmierergrafik aus, weil ein Kreis kein Schaum ist.

Drei Regeln, jede aus einem sichtbaren Fehler gelernt — beim Erweitern beachten:

1. Silhouetten NIE aus harmonischen Sinussen bauen (sin(nφ)+sin(2nφ)+…). Das
   Ergebnis hat exakte n-zählige Symmetrie und sieht aus wie ein Stern oder ein
   Kreuz. Stattdessen `winkelrauschen` (echtes Rauschen auf Stützstellen).
2. Jede Bildfolge braucht `randabfall` auf dem Alphakanal. Ohne ihn schneidet
   die Kachel den auslaufenden Rauch gerade ab, und im Spiel steht eine
   rechteckige Kante mitten auf dem Wasser.
3. Die Binnenstruktur muss über `skaliert` MITWACHSEN. Ein festes Muster in
   einer wachsenden Maske liest sich als Stempel, nicht als Wolke.

Aufruf:  python tools/fx-build.py   (braucht numpy und Pillow)
Ziel:    apps/client/src/assets/fx/ als WebP
"""

from __future__ import annotations

import os

import numpy as np
from PIL import Image

ZIEL = os.path.join(os.path.dirname(__file__), "..", "apps", "client", "src", "assets", "fx")

# Ein fester Startwert: die Grafiken sollen bei jedem Lauf gleich aussehen,
# sonst wäre jeder Neubau ein unbeabsichtigter Stilwechsel.
RNG = np.random.default_rng(20260811)


def value_noise(hoehe: int, breite: int, zellen: int) -> np.ndarray:
    """Wertrauschen: Zufallsgitter, glatt interpoliert. Ergebnis in [0,1]."""
    gitter = RNG.random((zellen + 1, zellen + 1))
    # Kachelbar machen: Rand doppelt belegen.
    gitter[-1, :] = gitter[0, :]
    gitter[:, -1] = gitter[:, 0]

    y = np.linspace(0, zellen, hoehe, endpoint=False)
    x = np.linspace(0, zellen, breite, endpoint=False)
    yi, xi = np.meshgrid(y, x, indexing="ij")
    y0, x0 = yi.astype(int), xi.astype(int)
    fy, fx = yi - y0, xi - x0
    # Glättungskurve (3t²−2t³) — ohne sie sind die Zellgrenzen sichtbar.
    sy, sx = fy * fy * (3 - 2 * fy), fx * fx * (3 - 2 * fx)

    a = gitter[y0, x0]
    b = gitter[y0, x0 + 1]
    c = gitter[y0 + 1, x0]
    d = gitter[y0 + 1, x0 + 1]
    return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy


def fbm(hoehe: int, breite: int, zellen: int = 4, oktaven: int = 5) -> np.ndarray:
    """Mehrere Rauschlagen übereinander — grobe Form plus feine Struktur."""
    summe = np.zeros((hoehe, breite))
    gewicht = 0.0
    amplitude = 1.0
    for i in range(oktaven):
        summe += amplitude * value_noise(hoehe, breite, zellen * 2**i)
        gewicht += amplitude
        amplitude *= 0.5
    return summe / gewicht


def radial(hoehe: int, breite: int) -> np.ndarray:
    """Abstand vom Mittelpunkt, 0 in der Mitte, 1 am Rand des einbeschriebenen Kreises."""
    y = np.linspace(-1, 1, hoehe)
    x = np.linspace(-1, 1, breite)
    yy, xx = np.meshgrid(y, x, indexing="ij")
    return np.sqrt(yy * yy + xx * xx)


def winkel(hoehe: int, breite: int) -> np.ndarray:
    """Polarwinkel jedes Bildpunkts in Radiant."""
    y = np.linspace(-1, 1, hoehe)
    x = np.linspace(-1, 1, breite)
    yy, xx = np.meshgrid(y, x, indexing="ij")
    return np.arctan2(yy, xx)


def _ringrauschen(w: np.ndarray, knoten: int) -> np.ndarray:
    """Periodisches Wertrauschen über den Winkel: Zufallswerte auf n Stützstellen."""
    werte = RNG.random(knoten + 1)
    werte[-1] = werte[0]  # geschlossener Ring, sonst klafft bei ±π eine Naht
    p = (w + np.pi) / (2 * np.pi) * knoten
    i0 = p.astype(int) % knoten
    f = p - p.astype(int)
    s = f * f * (3 - 2 * f)
    return werte[i0] * (1 - s) + werte[i0 + 1] * s


def winkelrauschen(hoehe: int, breite: int, knoten: int, oktaven: int = 3) -> np.ndarray:
    """
    Rauschen NUR über den Winkel — je Richtung ein anderer Wert, radial konstant.

    Das ist der Unterschied zwischen „Kreis" und „Explosion": eine über den
    Umfang schwankende Radiusvorgabe erzeugt Lappen und Zacken, während ein
    reiner Radiusvergleich zwangsläufig rund bleibt.

    ⚠️ NICHT als Summe von sin(n·φ) bauen: harmonische Sinusse haben exakte
    n-zählige Symmetrie, das Ergebnis ist zwangsläufig ein Stern. Deshalb echtes
    Wertrauschen auf zufälligen Stützstellen.
    """
    w = winkel(hoehe, breite)
    summe = np.zeros((hoehe, breite))
    gewicht = 0.0
    amplitude = 1.0
    for i in range(oktaven):
        # Krummer Faktor statt Verdopplung — sonst rasten die Lagen wieder ein.
        summe += amplitude * _ringrauschen(w, max(3, int(knoten * 2.3**i) + i * 3))
        gewicht += amplitude
        amplitude *= 0.5
    return summe / gewicht


def skaliert(feld: np.ndarray, faktor: float) -> np.ndarray:
    """
    Liest ein Rauschfeld so aus, als wäre es um `faktor` um die Mitte gedehnt.

    Damit wächst die Binnenstruktur eines Effekts mit ihm nach außen, statt
    ortsfest zu stehen — genau das unterscheidet eine expandierende Wolke von
    einem Kreis, dessen Maske größer wird.
    """
    h, b = feld.shape
    y = np.clip((np.arange(h) - (h - 1) / 2) / faktor + (h - 1) / 2, 0, h - 1.001)
    x = np.clip((np.arange(b) - (b - 1) / 2) / faktor + (b - 1) / 2, 0, b - 1.001)
    y0, x0 = y.astype(int), x.astype(int)
    fy, fx = (y - y0)[:, None], (x - x0)[None, :]
    a = feld[np.ix_(y0, x0)]
    bb = feld[np.ix_(y0, x0 + 1)]
    c = feld[np.ix_(y0 + 1, x0)]
    d = feld[np.ix_(y0 + 1, x0 + 1)]
    return (a * (1 - fx) + bb * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def speichern(name: str, rgba: np.ndarray) -> None:
    """
    Schreibt als WebP: verlustbehaftete Farbe, aber `alpha_quality=100`.

    Die Farbe ist bei Schaum, Rauch und Feuer fast flach — dort fällt Kompression
    nicht auf. Der Alphakanal IST die Form, ein Artefakt darin wäre sofort als
    ausgefranster Rand sichtbar; deshalb bleibt er unangetastet.
    """
    os.makedirs(ZIEL, exist_ok=True)
    bild = Image.fromarray(np.clip(rgba * 255, 0, 255).astype(np.uint8), "RGBA")
    pfad = os.path.abspath(os.path.join(ZIEL, name))
    bild.save(pfad, quality=92, alpha_quality=100, method=6)
    print(f"  {name}: {bild.size[0]}x{bild.size[1]}  {os.path.getsize(pfad) // 1024} KB")


def schaum_puff(groesse: int = 128) -> np.ndarray:
    """
    Ein Schaumbatzen für Kielwasser und Gischt.

    Kein weicher Gauß-Fleck: echter Schaum ist löchrig und ausgefranst, deshalb
    trägt die Deckkraft feines Rauschen und eine harte Schwelle.
    """
    r = radial(groesse, groesse)
    grob = fbm(groesse, groesse, zellen=3, oktaven=4)
    fein = fbm(groesse, groesse, zellen=10, oktaven=3)

    # Form: runder Kern, dessen Rand vom groben Rauschen zerbeult wird.
    rand = 0.62 + (grob - 0.5) * 0.45
    koerper = np.clip((rand - r) / 0.34, 0, 1)
    koerper = koerper**1.4

    # Löcher hineinfressen — das unterscheidet Schaum von Watte.
    loecher = np.clip((fein - 0.32) / 0.34, 0, 1)
    alpha = koerper * (0.35 + 0.65 * loecher)

    # Fast weiß mit einem Hauch Blaugrün aus dem Wasser darunter.
    rgba = np.zeros((groesse, groesse, 4))
    rgba[..., 0] = 0.88 + 0.12 * fein
    rgba[..., 1] = 0.94 + 0.06 * fein
    rgba[..., 2] = 0.97
    rgba[..., 3] = alpha
    return rgba


def rauch_puff(groesse: int = 128) -> np.ndarray:
    """Rauchballen — weicher als Schaum, mit wolkiger Binnenstruktur."""
    r = radial(groesse, groesse)
    grob = fbm(groesse, groesse, zellen=2, oktaven=5)
    fein = fbm(groesse, groesse, zellen=7, oktaven=4)

    rand = 0.70 + (grob - 0.5) * 0.5
    koerper = np.clip((rand - r) / 0.55, 0, 1) ** 1.6
    alpha = koerper * (0.55 + 0.45 * fein)

    # Weiß gehalten und zur Laufzeit getönt (weißer bzw. schwarzer Rauch).
    helligkeit = 0.72 + 0.28 * fein
    rgba = np.zeros((groesse, groesse, 4))
    rgba[..., 0] = helligkeit
    rgba[..., 1] = helligkeit
    rgba[..., 2] = helligkeit
    rgba[..., 3] = alpha * 0.9
    return rgba


def randabfall(k: int) -> np.ndarray:
    """
    Weicher Kreisabfall zum Kachelrand hin.

    ⚠️ Pflicht für jede Bildfolge: Rauch und Gischt wachsen über den Rand der
    128er-Kachel hinaus, und dort schneidet die Kachel sie GERADE ab — im Spiel
    stand dann eine sichtbare rechteckige Kante mitten auf dem Wasser. Der
    Abfall erzwingt, dass jedes Bild vor dem Rand auf null ist.
    """
    r = radial(k, k)
    x = np.clip((0.97 - r) / 0.20, 0, 1)
    return x * x * (3 - 2 * x)


def _blatt(frames: list[np.ndarray], spalten: int) -> np.ndarray:
    """Setzt Einzelbilder zu einem Raster zusammen."""
    n = len(frames)
    zeilen = (n + spalten - 1) // spalten
    k = frames[0].shape[0]
    blatt = np.zeros((zeilen * k, spalten * k, 4))
    for i, f in enumerate(frames):
        y, x = divmod(i, spalten)
        blatt[y * k : (y + 1) * k, x * k : (x + 1) * k] = f
    return blatt


def wasserfontaene(k: int = 128, anzahl: int = 25, spalten: int = 5) -> np.ndarray:
    """
    Einschlag ins Wasser, von schräg oben gesehen.

    Ablauf wie in Wirklichkeit: heller Kern, aus dem ein Kranz nach außen
    läuft, der sich verbreitert, abflacht und als Schaumfleck zerfällt.
    Zusätzlich fliegende Tropfen, die dem Kranz vorauseilen.
    """
    r = radial(k, k)
    struktur = fbm(k, k, zellen=4, oktaven=4)
    detail = fbm(k, k, zellen=11, oktaven=3)
    # Der Kranz läuft NICHT rund aus: je Richtung eine andere Reichweite, sonst
    # bleibt es ein Ring statt einer Gischtkrone.
    reichweite = 0.70 + 0.60 * winkelrauschen(k, k, knoten=7, oktaven=3)
    rand = randabfall(k)

    frames = []
    for i in range(anzahl):
        t = i / (anzahl - 1)

        # Kranz: wurzelförmig nach außen (der Impuls verteilt sich auf den Umfang).
        radius = (0.10 + 0.80 * np.sqrt(t)) * reichweite
        dicke = 0.14 + 0.36 * t
        kranz = np.exp(-(((r - radius) / dicke) ** 2) * 2.0)

        # Binnenstruktur wächst mit — sonst steht ein festes Muster in einer
        # wachsenden Maske und der Ring wirkt wie ein Stempel.
        dehnung = 1.0 + 2.6 * t
        wolke = skaliert(struktur, dehnung)
        koerner = skaliert(detail, dehnung * 0.7)
        # Kontrast steigt mit der Zeit: der geschlossene Kranz zerfällt in Flecken.
        kranz *= (0.30 + 0.70 * wolke) ** (1 + 1.8 * t) * (0.45 + 0.55 * koerner)
        kranz *= (1 - t) ** 1.15

        # Kern: kurzer, sehr heller Aufschlag.
        kern = np.exp(-((r / 0.26) ** 2) * 3.0) * max(0.0, 1 - t * 2.6)

        # Gischtschleier innerhalb des Kranzes — füllt die leere Mitte, aber
        # aufgelöst in Flecken, nicht als glatte Scheibe.
        schleier = np.clip((radius * 1.02 - r) / 0.55, 0, 1) ** 1.2
        schleier *= np.clip((koerner - 0.40) / 0.32, 0, 1) * (1 - t) ** 1.7

        # Tropfen: schnelle kleine Spritzer, die dem Kranz vorauseilen.
        tropfen = np.exp(-(((r - radius * 1.22) / 0.08) ** 2) * 3.5)
        tropfen *= np.clip((koerner - 0.60) / 0.18, 0, 1) * (1 - t) ** 2.0

        alpha = np.clip(kranz * 0.95 + kern + schleier * 0.55 + tropfen * 0.9, 0, 1) * rand

        rgba = np.zeros((k, k, 4))
        # Aufgewühltes Wasser ist weiß, dünnere Gischt schimmert türkis durch.
        dicht = np.clip(kern + kranz, 0, 1)
        rgba[..., 0] = 0.76 + 0.24 * dicht
        rgba[..., 1] = 0.88 + 0.12 * dicht
        rgba[..., 2] = 0.95
        rgba[..., 3] = alpha
        frames.append(rgba)
    return _blatt(frames, spalten)


def explosion(k: int = 128, anzahl: int = 25, spalten: int = 5) -> np.ndarray:
    """
    Detonation: Feuerball, der in Rauch übergeht.

    Die Farbe folgt der Temperatur — innen weißglühend, nach außen gelb,
    orange, rot, und was abkühlt, wird Rauch. Genau diese Staffelung macht den
    Unterschied zu einem orangen Kreis.
    """
    r = radial(k, k)
    grob = fbm(k, k, zellen=3, oktaven=5)
    fein = fbm(k, k, zellen=9, oktaven=3)
    # Lappen: der Feuerball drückt in manche Richtungen weiter als in andere.
    # Ohne diesen Term bleibt jede Formel für eine Detonation eine Kugel.
    lappen = 0.55 + 0.80 * winkelrauschen(k, k, knoten=6, oktaven=3)
    rauchlappen = 0.60 + 0.70 * winkelrauschen(k, k, knoten=5, oktaven=3)
    funkenrichtung = winkelrauschen(k, k, knoten=23, oktaven=2)
    rand = randabfall(k)

    frames = []
    for i in range(anzahl):
        t = i / (anzahl - 1)
        # Die Binnenstruktur quillt mit nach außen, statt in der Maske zu stehen.
        wolke = skaliert(grob, 1.0 + 2.2 * t)
        koerner = skaliert(fein, 1.0 + 1.6 * t)

        # Feuer: schießt auf, brennt kurz, erlischt im vorderen Drittel.
        feuerradius = (0.16 + 0.55 * t**0.45) * lappen
        feuer = np.clip((feuerradius - r) / (0.09 + 0.24 * t), 0, 1) ** 1.3
        feuer *= 0.40 + 0.60 * koerner
        feuer *= np.clip(1.25 - t * 2.2, 0, 1)

        # Rauch: wächst langsamer, hält länger, quillt über das Feuer hinaus.
        rauchradius = (0.22 + 0.72 * t**0.7) * rauchlappen
        rauch = np.clip((rauchradius - r) / (0.16 + 0.40 * t), 0, 1) ** 1.5
        rauch *= 0.35 + 0.65 * wolke
        rauch *= np.clip(t * 3.2, 0, 1) * (1 - t) ** 0.55

        # Funken: kurze helle Spritzer, die dem Feuerball vorauseilen.
        funken = np.exp(-(((r - feuerradius * 1.3) / 0.06) ** 2) * 5.0)
        funken *= np.clip((funkenrichtung - 0.70) / 0.12, 0, 1) * np.clip(1 - t * 2.6, 0, 1)

        # Temperatur: innen weißglühend, nach außen und mit der Zeit kühler.
        hitze = np.clip((feuer + funken) * (1.45 - t * 1.8) - r * 0.30, 0, 1)

        alpha = np.clip(feuer * 0.95 + rauch * 0.88 + funken, 0, 1) * rand
        # Rußanteil: reine Kennzeichnung „hier brennt nichts mehr", NICHT die
        # Rauchdichte — sonst bliebe der Rauch anteilig dunkel und verschwände
        # auf schwarzem Wasser.
        russ = np.clip(1 - (feuer + funken) * 3.0, 0, 1)

        grundton = 0.09 + 0.16 * koerner
        rgba = np.zeros((k, k, 4))
        # Rampe Ruß → Rot → Orange → Gelb → Weiß über die Hitze.
        rgba[..., 0] = grundton + np.clip(hitze * 3.2, 0, 1) * (1 - grundton)
        rgba[..., 1] = grundton + np.clip(hitze * 1.8 - 0.28, 0, 1) * (1 - grundton)
        rgba[..., 2] = grundton + np.clip(hitze * 1.6 - 0.80, 0, 1) * (1 - grundton)
        # Rauch mittelgrau statt schwarz, sonst säuft er auf dunklem Wasser ab —
        # dort ist Ruß vom Hintergrund nicht zu unterscheiden.
        for kanal in range(3):
            rgba[..., kanal] = rgba[..., kanal] * (1 - russ * 0.85) + (0.44 + 0.26 * wolke) * russ * 0.85
        rgba[..., 3] = alpha
        frames.append(rgba)
    return _blatt(frames, spalten)


if __name__ == "__main__":
    print("Effekt-Grafiken:")
    speichern("foam_puff.webp", schaum_puff())
    speichern("smoke_puff.webp", rauch_puff())
    speichern("splash_sheet.webp", wasserfontaene())
    speichern("explosion_sheet.webp", explosion())
    print(f"Ziel: {os.path.abspath(ZIEL)}")
