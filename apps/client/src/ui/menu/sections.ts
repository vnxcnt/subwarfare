/**
 * Bereiche des Hauptmenüs. Eigene Datei statt Export aus einer SFC —
 * `<script setup>` erlaubt keine Modul-Exporte, und Shell wie Nav brauchen
 * denselben Typ.
 */
export type MenuSection = 'auslaufen' | 'werft' | 'flottille' | 'neuigkeiten';

/** Die drei großen Menüpunkte der linken Spalte, in Anzeige-Reihenfolge. */
export const MAIN_SECTIONS: ReadonlyArray<{
  id: MenuSection;
  label: string;
  detail: string;
}> = [
  { id: 'auslaufen', label: 'Auslaufen', detail: 'Einsatz · Schiff · Ausrüstung' },
  { id: 'werft', label: 'Werft', detail: 'Inventar · Shop' },
  { id: 'flottille', label: 'Flottille', detail: 'Kameraden · Ränge · Kasse' },
];
