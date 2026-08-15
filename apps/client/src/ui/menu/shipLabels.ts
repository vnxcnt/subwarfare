import type { PlayableModel } from '@subwarfare/shared';

/**
 * Anzeigenamen der spielbaren Schiffe — aus dem AuslaufenPanel herausgezogen,
 * seit Werft (Schiffsbasis) und Auslaufen sie beide brauchen.
 */
export const SHIP_LABELS: Record<PlayableModel, string> = {
  fregatte01: 'Fregatte',
  fregatte02: 'Fregatte II',
  submarine01: 'U-Boot',
  submarine02: 'U-Boot II',
  destroyer01: 'Zerstörer',
  destroyer02: 'Zerstörer II',
};
