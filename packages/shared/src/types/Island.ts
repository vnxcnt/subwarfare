/**
 * Eine Insel als geschlossener Umriss in Map-Units.
 *
 * Der Umriss ist die EINZIGE Wahrheit über die Form: der Server kollidiert
 * dagegen (Grundberührung, Geschosse), der Client zeichnet daraus die Minimap,
 * und das Abstandsfeld für die Küstendarstellung wird von `tools/island-sdf.py`
 * aus genau diesen Punkten gebacken. Wer die Form ändern will, ändert das
 * Polygon — alles andere folgt.
 */
export interface Island {
  /** Eindeutig je Karte. */
  id: string;
  /** Anzeigename (Minimap, Ereignislog). */
  name: string;
  /**
   * Umriss in Map-Units, NICHT geschlossen: der letzte Punkt verbindet sich
   * wieder mit dem ersten. Mindestens drei Punkte.
   *
   * ⚠️ Eine Insel darf die Torus-Naht NICHT überqueren — sämtliche
   * Polygon-Mathematik rechnet in der gewöhnlichen Ebene. `defineMap` prüft
   * das beim Serverstart.
   */
  polygon: { x: number; y: number }[];
}
