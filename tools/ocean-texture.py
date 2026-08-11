"""
Macht aus einem BILD von Wasser eine kachelnde Detail-Textur für den Ozean-Shader.

Vorlagen — erzeugt oder fotografiert — kacheln so gut wie nie: der linke Rand
passt nicht zum rechten. Direkt verwendet steht im Spiel ein Gitter aus Kanten.

⚠️ WAS HIER NICHT GEMACHT WIRD, UND WARUM:
Der naheliegende Trick ist, das Amplitudenspektrum zu behalten und die Phasen
neu zu würfeln — das Ergebnis ist per Konstruktion periodisch. Ich habe es
gebaut und gemessen: es taugt hier NICHT. Was ein Wasserbild wie Wasser
aussehen lässt, sind die zusammenhängenden Kämme und die durchlaufenden
Schaumadern, und das sind PHASENGEBILDE. Würfelt man die Phasen, bleibt ein
Zufallsfeld mit korrektem Frequenzgemisch übrig — also grauer Grieß.

Der Weg hier ist stattdessen konservativ: die Vorlage bleibt Pixel für Pixel
erhalten, sie wird nur um eine halbe Kante VERSETZT (damit die beiden
unpassenden Ränder in die Mitte wandern) und die entstandene Naht dort mit
einem ANDEREN Ausschnitt derselben Vorlage überblendet. Danach ist die Kachel
nahtlos und sieht immer noch aus wie das Original.

Ausgabe ist EINE Datei `ocean_detail.webp`, RGB:
  R = Höhe        (das Wellenfeld)
  G = Schaummaske (die Adern)
  B = frei

Die NEIGUNG steckt bewusst nicht mit drin, obwohl sie in den Shader muss: als
verlustfreie Normalmap kostete sie 635 KB, abgeleitet aus der Höhe kostet sie
zwei zusätzliche Texturabtastungen pro Pixel und nichts an Ladezeit.

⚠️ RGB und NICHT RGBA: WebP räumt die Farbkanäle dort auf, wo Alpha 0 ist. Als
die Schaummaske noch im Alphakanal lag — zu 86 % 0 —, standen R, G und B auf
ebenso vielen Pixeln exakt auf null, und Höhenfeld wie Normalen waren weg.
Daten gehören nie in den Alphakanal.

⚠️ Kantenlänge MUSS eine Zweierpotenz sein. Pixi 8 fällt bei fehlendem WebGL2
auf WebGL1 zurück, und dort erlaubt der Wiederholmodus nur Zweierpotenzen —
sonst bricht die Kachelung genau auf den alten Rechnern weg.

Aufruf:  python tools/ocean-texture.py <vorlage.png> [512|1024]
"""

from __future__ import annotations

import os
import sys

import numpy as np
from PIL import Image

ZIEL = os.path.join(os.path.dirname(__file__), "..", "apps", "client", "src", "assets", "fx")


def felder_aus_mosaik(bild: np.ndarray) -> list[np.ndarray]:
    """
    Zerlegt ein Blatt mit hellen Trennlinien in seine Felder.

    Erzeugte „Kachelblätter" haben oft ein eingezeichnetes Raster. Die Linien
    müssen weg, sonst landen sie als heller Balken in der fertigen Textur.
    """
    grau = bild.mean(axis=2)
    schwelle = grau.mean() + 3 * grau.std()

    def linien(werte: np.ndarray) -> list[tuple[int, int]]:
        treffer = np.where(werte > schwelle)[0]
        if len(treffer) == 0:
            return []
        gruppen, start = [], int(treffer[0])
        for i in range(1, len(treffer)):
            if treffer[i] != treffer[i - 1] + 1:
                gruppen.append((start, int(treffer[i - 1])))
                start = int(treffer[i])
        gruppen.append((start, int(treffer[-1])))
        return gruppen

    def bereiche(grenzen: list[tuple[int, int]], gesamt: int) -> list[tuple[int, int]]:
        kanten, letzte = [], 0
        for a, e in grenzen:
            if a - letzte > 20:
                kanten.append((letzte, a))
            letzte = e + 1
        if gesamt - letzte > 20:
            kanten.append((letzte, gesamt))
        return kanten

    zeilen = bereiche(linien(grau.mean(axis=1)), bild.shape[0])
    spalten = bereiche(linien(grau.mean(axis=0)), bild.shape[1])
    if not zeilen or not spalten:
        return [grau]

    k = min(min(e - a for a, e in zeilen), min(e - a for a, e in spalten))
    # Ein paar Pixel Sicherheitsabstand zur Linie — sie franst weich aus.
    rand = 3
    return [
        grau[z + rand : z + k - rand, s + rand : s + k - rand]
        for z, _ in zeilen
        for s, _ in spalten
    ]


def auf_groesse(feld: np.ndarray, n: int) -> np.ndarray:
    bild = Image.fromarray(np.clip(feld, 0, 255).astype(np.uint8), "L")
    return np.asarray(bild.resize((n, n), Image.LANCZOS), dtype=np.float64)


def nahtlos_machen(feld: np.ndarray, partner: np.ndarray) -> np.ndarray:
    """
    Versetzen und die Naht überblenden — die Struktur bleibt dabei erhalten.

    Nach dem Versatz um eine halbe Kante sind die AUSSENränder das, was in der
    Vorlage nebeneinanderlag: sie passen zusammen. Die ursprünglich
    unpassenden Ränder liegen jetzt als Kreuz in der Mitte und werden dort mit
    einem anderen Ausschnitt weich überblendet — mit einem FREMDEN, weil ein
    Verblenden des Feldes mit sich selbst ein Geisterbild ergäbe.
    """
    n = feld.shape[0]
    versetzt = np.roll(np.roll(feld, n // 2, axis=0), n // 2, axis=1)
    fremd = np.roll(np.roll(partner, n // 3, axis=0), n // 7, axis=1)

    breite = max(12, n // 14)
    achse = np.arange(n)
    d = np.minimum(np.abs(achse - n // 2), breite)
    keil = 1.0 - d / breite
    keil = keil * keil * (3 - 2 * keil)
    maske = np.maximum(keil[:, None], keil[None, :])
    return versetzt * (1 - maske) + fremd * maske


def gauss_periodisch(feld: np.ndarray, sigma: float) -> np.ndarray:
    """Weichzeichnen mit UMLAUF — zerstört die Kachelbarkeit nicht."""
    n = feld.shape[0]
    k = np.hypot(np.fft.fftfreq(n)[None, :], np.fft.fftfreq(n)[:, None])
    kern = np.exp(-2.0 * (np.pi * sigma * k) ** 2)
    return np.real(np.fft.ifft2(np.fft.fft2(feld) * kern))


def naht_rang(f: np.ndarray, achse: int) -> float:
    """
    Perzentilrang der Naht unter allen Nachbarpaaren dieser Achse.

    ⚠️ Nicht gegen den Mittelwert prüfen — das führt zweifach in die Irre. Ein
    perfekt periodisches Sinusfeld liefert dort schon Faktor 1,57, weil die
    Naht zufällig an der steilsten Stelle liegen kann; und bei einer fast
    leeren Maske trifft ein einzelnes Vergleichspaar auf „0 gegen 0".
    Entscheidend ist allein: STICHT die Naht heraus? 100 % heißt Bruch.
    """
    d = np.abs(np.diff(f, axis=achse)).mean(axis=1 - achse)
    naht = np.abs(f[:, 0] - f[:, -1]).mean() if achse == 1 else np.abs(f[0, :] - f[-1, :]).mean()
    return 100.0 * float((d < naht).mean())


def speichern(name: str, kanaele: np.ndarray, modus: str) -> None:
    os.makedirs(ZIEL, exist_ok=True)
    bild = Image.fromarray(np.clip(kanaele * 255, 0, 255).astype(np.uint8), modus)
    pfad = os.path.abspath(os.path.join(ZIEL, name))
    # VERLUSTFREI: eine Normalmap verträgt keine Kompressionsartefakte, jeder
    # Fehler in R/G wird zu einer falschen Spiegelung auf dem Wasser.
    bild.save(pfad, lossless=True, quality=100)
    print(f"  {name}: {bild.size[0]}x{bild.size[1]}  {os.path.getsize(pfad) // 1024} KB")


def name_aus(quelle: str) -> str:
    """Zielname: `ocean_detail.webp`, oder mit Zusatz beim Vergleichslauf."""
    zusatz = os.environ.get("KACHEL_NAME")
    return f"ocean_detail_{zusatz}.webp" if zusatz else "ocean_detail.webp"


def main() -> None:
    quelle = sys.argv[1]
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 512
    if n & (n - 1):
        raise SystemExit(f"Kantenlänge muss eine Zweierpotenz sein, nicht {n}.")

    roh = np.asarray(Image.open(quelle).convert("RGB"), dtype=np.float64)
    felder = felder_aus_mosaik(roh)
    print(f"Vorlage: {os.path.basename(quelle)} — {len(felder)} Ausschnitt(e) à {felder[0].shape[0]} px")

    # Den kontrastreichsten Ausschnitt als Hauptvorlage nehmen, einen weit
    # entfernten als Blendpartner.
    reihenfolge = sorted(range(len(felder)), key=lambda i: -felder[i].std())
    haupt = auf_groesse(felder[reihenfolge[0]], n)
    partner = auf_groesse(felder[reihenfolge[len(felder) // 2]], n)
    print(f"  Hauptausschnitt #{reihenfolge[0]}, Blendpartner #{reihenfolge[len(felder) // 2]}")

    kachel = nahtlos_machen(haupt, partner)

    # Beleuchtungsverlauf herausrechnen: Vorlagen haben fast immer eine
    # großflächige Aufhellung. Gekachelt wäre die als regelmäßiges Muster
    # sichtbar. NUR die gröbste Lage abziehen (sigma = n/6) — mehr nicht:
    # die Wellenschattierung selbst sitzt knapp darunter, und wer zu viel
    # abzieht, behält nur die Schaumadern und damit ein Rissnetz.
    verlauf = gauss_periodisch(kachel, sigma=n / 6.0)
    flach = kachel - verlauf

    streuung = flach.std()
    hoehe = np.clip(flach / max(streuung, 1e-6) * 0.22 + 0.5, 0, 1)

    # Schaum: die obersten Helligkeiten der NAHTLOSEN Kachel — hier darf nichts
    # gefiltert werden, die Adern sind das Wertvolle an der Vorlage.
    p88, p998 = np.percentile(kachel, 88), np.percentile(kachel, 99.8)
    schaum = np.clip((kachel - p88) / max(p998 - p88, 1e-6), 0, 1) ** 1.2

    struktur = np.stack([hoehe, schaum, np.zeros_like(hoehe)], axis=-1)
    speichern(name_aus(quelle), struktur, "RGB")

    print("Nahtprüfung (100 % = Bruch, alles darunter unauffällig):")
    for bez, f in (("Höhe", hoehe), ("Schaum", schaum)):
        print(f"  {bez:<8} l/r {naht_rang(f, 1):5.0f}%   o/u {naht_rang(f, 0):5.0f}%")
    print(f"Ziel: {os.path.abspath(ZIEL)}\n")


if __name__ == "__main__":
    main()
