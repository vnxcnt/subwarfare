/**
 * Item-Icons, Dateiname = Item-Kennung aus dem Katalog (`torpedo_mk1.png`,
 * `taeuschkoerper.png`, …) unter `assets/items/`.
 *
 * Über `import.meta.glob` wie bei den Rang-Icons: ein neues Item braucht nur
 * seine Datei, keine Codeänderung. Items ohne Datei liefern null — die
 * Anzeige lässt das Icon dann schlicht weg.
 *
 * Perks sind ebenfalls Items, ihre Grafiken liegen aber unter
 * `assets/perks/*.webp` (siehe perkIcons.ts) — dieser Resolver fällt darauf
 * zurück, damit Depot-Inventar und Moderation sie ohne Sonderfall zeigen.
 */
const modules = import.meta.glob('../assets/items/*.png', {
  eager: true,
  import: 'default',
}) as Record<string, string>;

const perkModules = import.meta.glob('../assets/perks/*.webp', {
  eager: true,
  import: 'default',
}) as Record<string, string>;

export function itemIconUrl(itemId: string): string | null {
  return (
    modules[`../assets/items/${itemId}.png`] ??
    perkModules[`../assets/perks/${itemId}.webp`] ??
    null
  );
}
