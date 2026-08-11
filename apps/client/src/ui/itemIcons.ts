/**
 * Item-Icons, Dateiname = Item-Kennung aus dem Katalog (`torpedo_mk1.png`,
 * `taeuschkoerper.png`, …) unter `assets/items/`.
 *
 * Über `import.meta.glob` wie bei den Rang-Icons: ein neues Item braucht nur
 * seine Datei, keine Codeänderung. Items ohne Datei (z. B. die Munition)
 * liefern null — die Anzeige lässt das Icon dann schlicht weg.
 */
const modules = import.meta.glob('../assets/items/*.png', {
  eager: true,
  import: 'default',
}) as Record<string, string>;

export function itemIconUrl(itemId: string): string | null {
  return modules[`../assets/items/${itemId}.png`] ?? null;
}
