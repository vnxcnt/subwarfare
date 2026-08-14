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

Ausgabe ist EINE Datei `ocean_water.webp`: die Vorlage in FARBE, nur nahtlos
gemacht. Genau so, wie sie ist — mit ihren Wellen, ihren Schaumkronen und ihrem
Blau. Der Shader zeigt sie an und verzerrt sie; er rechnet sie nicht nach.

⚠️ FARBE BEHALTEN, das ist der ganze Punkt. Eine frühere Fassung zog aus der
Vorlage ein Höhenfeld und eine Schaummaske und ließ den Shader daraus alles neu
beleuchten. Ergebnis: auf dem Bildschirm stand der Shader, nicht die Vorlage —
die Farbe war weg, die Beleuchtung herausgerechnet, und vier gedrehte Lagen
übereinander zerstörten den Rest der Wiedererkennbarkeit. Wer das hier wieder
in Graustufen zerlegt, bekommt dasselbe Ergebnis.

⚠️ RGB und NICHT RGBA: WebP räumt die Farbkanäle dort auf, wo Alpha 0 ist —
Daten oder Farbe unter transparenten Pixeln sind verloren.

⚠️ Kantenlänge MUSS eine Zweierpotenz sein. Pixi 8 fällt bei fehlendem WebGL2
auf WebGL1 zurück, und dort erlaubt der Wiederholmodus nur Zweierpotenzen —
sonst bricht die Kachelung genau auf den alten Rechnern weg.

Aufruf:  python tools/ocean-texture.py <vorlage.png> [512|1024] [--ruhig] [--tiefpass N]

--ruhig     Normiert auf ruhige See (Mittel 0.185, Streuung 0.035) statt der
            Sturm-Zielwerte — für flaue Vorlagen, deren Charakter erhalten
            bleiben soll. Die Shader-Schwellen vertragen beides; ruhig heißt
            schlicht: kaum Kämme, gleichmäßige Fläche.
--tiefpass  Sigma des Verlaufsausgleichs NACH dem Nahtlos-Schritt (Standard
            n/5). Kleinere Werte bügeln auch mittelgrobe Schlieren-Bänder aus
            — nötig bei gerichteten, gebürsteten Vorlagen (water_flat01: 44).
"""

from __future__ import annotations

import os
import sys

import numpy as np
from PIL import Image

ZIEL = os.path.join(os.path.dirname(__file__), "..", "apps", "client", "src", "assets", "fx")


def felder_aus_mosaik(bild: np.ndarray) -> list[np.ndarray]:
    """
    Zerlegt ein Blatt mit hellen Trennlinien in seine Felder — in FARBE.

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
        bild[z + rand : z + k - rand, s + rand : s + k - rand]
        for z, _ in zeilen
        for s, _ in spalten
    ]


def auf_groesse(feld: np.ndarray, n: int) -> np.ndarray:
    bild = Image.fromarray(np.clip(feld, 0, 255).astype(np.uint8), "RGB")
    return np.asarray(bild.resize((n, n), Image.LANCZOS), dtype=np.float64)


def nahtlos_machen(feld: np.ndarray, partner: np.ndarray) -> np.ndarray:
    """
    Versetzen und die Naht überblenden — die Struktur bleibt dabei erhalten.

    Nach dem Versatz um eine halbe Kante sind die AUSSENränder das, was in der
    Vorlage nebeneinanderlag: sie passen zusammen. Die ursprünglich
    unpassenden Ränder liegen jetzt als Kreuz in der Mitte und werden dort mit
    einem anderen Ausschnitt weich überblendet — mit einem FREMDEN, weil ein
    Verblenden des Feldes mit sich selbst ein Geisterbild ergäbe.

    ⚠️ IMMER BEIDE ACHSEN behandeln, auch wenn die Messung eine davon für
    sauber hält. Der Versuch, nur die gebrochene Achse anzufassen, ging schief:
    `naht_rang` misst HELLIGKEITSsprünge, und watertile.png hatte oben/unten
    keinen — wohl aber einen STRUKTURbruch, bei dem das Wellenmuster einfach
    nicht weiterläuft. Gekachelt standen dann klar sichtbare waagerechte Linien
    im Bild, obwohl die Zahl 27 % sagte. Die Messung taugt zur Kontrolle
    hinterher, nicht als Schalter davor.
    """
    n = feld.shape[0]
    grau = feld.mean(axis=2)
    print(f"  Naht der Vorlage (nur Helligkeit): links/rechts {naht_rang(grau, 1):.0f}%, "
          f"oben/unten {naht_rang(grau, 0):.0f}%")

    versetzt = np.roll(np.roll(feld, n // 2, axis=0), n // 2, axis=1)
    fremd = np.roll(np.roll(partner, n // 3, axis=0), n // 7, axis=1)

    breite = max(12, n // 14)
    achse = np.arange(n)
    d = np.minimum(np.abs(achse - n // 2), breite)
    keil = 1.0 - d / breite
    keil = keil * keil * (3 - 2 * keil)
    maske = np.maximum(keil[:, None], keil[None, :])[..., None]
    return versetzt * (1 - maske) + fremd * maske


# Zielstatistik der fertigen Kachel. Der Ozean-Shader hat FESTE Schwellen für
# Schaumkämme, Wasserfarbe und Kontrast; sie sind auf diese Werte eingestellt.
# Ohne Normierung müsste man sie bei jeder neuen Vorlage nachziehen — eine
# helle, flaue Aufnahme hätte sonst gar keine Kämme mehr und eine grelle Fläche.
ZIEL_MITTEL = 0.171
ZIEL_STREUUNG = 0.073


def normieren(feld: np.ndarray) -> np.ndarray:
    """
    Helligkeit und Kontrast auf die Zielstatistik ziehen, FARBTON unangetastet.

    Gearbeitet wird auf der Luminanz; die Kanäle folgen im selben Verhältnis.
    Dadurch bleibt das Blau der Vorlage erhalten, nur Helligkeit und Spreizung
    werden vergleichbar gemacht.
    """
    lum = feld @ np.array([0.299, 0.587, 0.114])
    mittel, streuung = lum.mean() / 255.0, lum.std() / 255.0
    faktor = ZIEL_STREUUNG / max(streuung, 1e-6)
    ziel = (lum / 255.0 - mittel) * faktor + ZIEL_MITTEL
    ziel = np.clip(ziel, 0.004, 1.0)
    print(
        f"  Normiert: Mittel {mittel:.3f} -> {ZIEL_MITTEL:.3f}, "
        f"Streuung {streuung:.3f} -> {ZIEL_STREUUNG:.3f}"
    )
    verhaeltnis = (ziel * 255.0) / np.maximum(lum, 1.0)
    return np.clip(feld * verhaeltnis[..., None], 0, 255)


def gauss_periodisch(feld: np.ndarray, sigma: float) -> np.ndarray:
    """Weichzeichnen mit UMLAUF, kanalweise — zerstört die Kachelbarkeit nicht."""
    n = feld.shape[0]
    k = np.hypot(np.fft.fftfreq(n)[None, :], np.fft.fftfreq(n)[:, None])
    kern = np.exp(-2.0 * (np.pi * sigma * k) ** 2)
    aus = np.empty_like(feld)
    for c in range(feld.shape[2]):
        aus[..., c] = np.real(np.fft.ifft2(np.fft.fft2(feld[..., c]) * kern))
    return aus


def verlauf_weg(feld: np.ndarray, sigma: float) -> np.ndarray:
    """
    Beleuchtungsverlauf NICHT-periodisch entfernen — VOR dem Nahtlos-Schritt.

    ⚠️ Der periodische Ausgleich nach dem Nahtlos-Machen reicht nicht: der
    Versatz rollt die BILDRÄNDER in die Kachelmitte, und ein heller Rahmen
    oder ein Helligkeitsverlauf der Vorlage steht danach als helles Kreuz
    mitten in der Kachel (so gefunden bei water_flat01 — im Spiel ein sich
    wiederholender Fleck plus gerade Linien). Deshalb hier mit SPIEGEL-Polster
    statt Umlauf: die Ränder werden gegen ihr eigenes Spiegelbild geglättet,
    der Abzug kennt keine Wrap-Kante.
    """
    rand = int(3 * sigma)
    gepolstert = np.pad(feld, ((rand, rand), (rand, rand), (0, 0)), mode="reflect")
    n0, n1 = gepolstert.shape[:2]
    k = np.hypot(np.fft.fftfreq(n1)[None, :], np.fft.fftfreq(n0)[:, None])
    kern = np.exp(-2.0 * (np.pi * sigma * k) ** 2)
    glatt = np.empty_like(gepolstert)
    for c in range(feld.shape[2]):
        glatt[..., c] = np.real(np.fft.ifft2(np.fft.fft2(gepolstert[..., c]) * kern))
    glatt = glatt[rand:-rand, rand:-rand]
    mittel = feld.reshape(-1, feld.shape[2]).mean(axis=0)
    return np.clip(feld - glatt + mittel, 0, 255)


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
    """Zielname: `ocean_water.webp`, oder mit Zusatz beim Vergleichslauf."""
    zusatz = os.environ.get("KACHEL_NAME")
    return f"ocean_water_{zusatz}.webp" if zusatz else "ocean_water.webp"


def main() -> None:
    argumente = [a for a in sys.argv[1:] if not a.startswith("--")]
    quelle = argumente[0]
    n = int(argumente[1]) if len(argumente) > 1 else 512
    if n & (n - 1):
        raise SystemExit(f"Kantenlänge muss eine Zweierpotenz sein, nicht {n}.")

    ruhig = "--ruhig" in sys.argv
    tiefpass = n / 5.0
    if "--tiefpass" in sys.argv:
        tiefpass = float(sys.argv[sys.argv.index("--tiefpass") + 1])
    if ruhig:
        # Ruhige-See-Zielwerte: der Charakter einer flauen Vorlage bleibt
        # erhalten, statt sie auf Sturm-Kontrast zu spreizen (die 5,6-fache
        # Spreizung machte bei water_flat01 aus unsichtbaren Bürstenstrichen
        # ein hartes Diagonal-Gitter).
        global ZIEL_MITTEL, ZIEL_STREUUNG
        ZIEL_MITTEL, ZIEL_STREUUNG = 0.185, 0.035

    roh = np.asarray(Image.open(quelle).convert("RGB"), dtype=np.float64)
    # Bildrand großzügig abschneiden: erzeugte Vorlagen tragen dort oft einen
    # hellen Rahmen oder eine Vignette, und der Nahtlos-Versatz rollte beides
    # als helles Kreuz mitten in die Kachel.
    if min(roh.shape[0], roh.shape[1]) > 600:
        roh = roh[40:-40, 40:-40]
    felder = felder_aus_mosaik(roh)
    print(f"Vorlage: {os.path.basename(quelle)} — {len(felder)} Ausschnitt(e) à {felder[0].shape[0]} px")

    # Den kontrastreichsten Ausschnitt als Hauptvorlage nehmen, einen weit
    # entfernten als Blendpartner.
    reihenfolge = sorted(range(len(felder)), key=lambda i: -felder[i].std())
    haupt = auf_groesse(felder[reihenfolge[0]], n)
    partner = auf_groesse(felder[reihenfolge[len(felder) // 2]], n)
    print(f"  Hauptausschnitt #{reihenfolge[0]}, Blendpartner #{reihenfolge[len(felder) // 2]}")

    # Beleuchtungsverlauf VOR dem Nahtlos-Schritt entfernen (nicht-periodisch)
    # — danach ist es zu spät, siehe verlauf_weg.
    haupt = verlauf_weg(haupt, sigma=n / 13.0)
    partner = verlauf_weg(partner, sigma=n / 13.0)

    kachel = nahtlos_machen(haupt, partner)

    # Rest-Verlauf ausgleichen, jetzt periodisch: NUR die gröbste Lage gegen
    # den Bildmittelwert tauschen — die Wellenschattierung sitzt knapp darunter
    # und muss bleiben. `--tiefpass` zieht die Schwelle tiefer und bügelt auch
    # mittelgrobe Schlieren-Bänder gerichteter Vorlagen aus.
    verlauf = gauss_periodisch(kachel, sigma=tiefpass)
    mittel = kachel.reshape(-1, kachel.shape[2]).mean(axis=0)
    ausgeglichen = np.clip(kachel - verlauf + mittel, 0, 255)
    ausgeglichen = normieren(ausgeglichen)

    speichern(name_aus(quelle), ausgeglichen / 255.0, "RGB")

    print("Nahtprüfung (100 % = Bruch, alles darunter unauffällig):")
    grau = ausgeglichen.mean(axis=2)
    print(f"  Farbe    l/r {naht_rang(grau, 1):5.0f}%   o/u {naht_rang(grau, 0):5.0f}%")
    print(f"Ziel: {os.path.abspath(ZIEL)}\n")


if __name__ == "__main__":
    main()
