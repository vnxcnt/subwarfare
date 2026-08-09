<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { SONAR } from '../config';
import { onFrame, type HudState } from '../state/hud';

const canvas = ref<HTMLCanvasElement | null>(null);
let context: CanvasRenderingContext2D | null = null;
let observer: ResizeObserver | null = null;
let stopFrames: (() => void) | null = null;

/** Ein aufgemaltes Echo. Weltkoordinate, eingefroren beim Überstreichen. */
interface Echo {
  x: number;
  y: number;
  rotation: number;
  /** Spielzeit des Überstreichens. */
  at: number;
}

const echoes = new Map<string, Echo>();
/** Strahlrichtung in Grad. 0 = Norden, im Uhrzeigersinn. */
let sweep = 0;
let clock = 0;
let latest: HudState | null = null;

const DEG = Math.PI / 180;

/**
 * Linienfarbe mit Deckkraft. Einmal aus der Config zerlegt, damit die Farbe an
 * genau einer Stelle steht und nicht als Zahlentripel über die Zeichenroutine
 * verstreut ist.
 */
const LINE = (() => {
  const hex = SONAR.color.replace('#', '');
  const value = Number.parseInt(hex, 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
})();

function line(alpha: number): string {
  return `rgba(${LINE.r}, ${LINE.g}, ${LINE.b}, ${alpha})`;
}

/** Peilung eines Richtungsvektors. 0 = Norden, im Uhrzeigersinn. */
function bearingOf(dx: number, dy: number): number {
  const value = (Math.atan2(dx, -dy) / DEG) % 360;
  return value < 0 ? value + 360 : value;
}

/**
 * Ob der Strahl auf seinem Weg von `from` nach `to` über `angle` gelaufen ist.
 * Der Nulldurchgang ist der Sonderfall, den man hier leicht übersieht.
 */
function swept(from: number, to: number, angle: number): boolean {
  if (to >= from) return angle > from && angle <= to;
  return angle > from || angle <= to;
}

/**
 * Ein Frame Strahlbewegung. Nur was überstrichen wird, bekommt eine neue
 * Position — dazwischen bleibt das Bild absichtlich stehen.
 */
function advance(frameSeconds: number, state: HudState): void {
  latest = state;
  clock = state.time;

  const step = (360 / SONAR.sweepSeconds) * frameSeconds;
  const previous = sweep;
  sweep = (sweep + step) % 360;

  const wholeTurn = step >= 360;
  for (const contact of state.contacts) {
    if (wholeTurn || swept(previous, sweep, bearingOf(contact.dx, contact.dy))) {
      // Absolute Weltposition einfrieren, nicht die relative: das eigene Boot
      // fährt weiter, und das Echo soll dabei an seinem Platz auf der See
      // bleiben statt mitzuwandern.
      echoes.set(contact.id, {
        x: state.x + contact.dx,
        y: state.y + contact.dy,
        rotation: contact.rotation,
        at: clock,
      });
    }
  }

  // Wer eineinhalb Umläufe nicht mehr bestätigt wurde, ist weg — aus der
  // Reichweite gefahren oder nie wieder erfasst.
  const stale = SONAR.sweepSeconds * 1.6;
  for (const [id, echo] of echoes) {
    if (clock - echo.at > stale) echoes.delete(id);
  }

  draw();
}

function draw(): void {
  const element = canvas.value;
  const state = latest;
  if (!element || !context || !state) return;

  const size = element.width;
  const centre = size / 2;
  const radius = centre - 6 * devicePixelRatio;
  const scale = radius / SONAR.range;
  const ctx = context;
  const unit = devicePixelRatio;

  // Die Leinwand füllt die Rahmenöffnung aus. Damit deckt sie auch die Ecken
  // zwischen Scheibe und Rahmen ab — dort liegt die Rahmenfläche.
  ctx.fillStyle = SONAR.frameBackground;
  ctx.fillRect(0, 0, size, size);

  ctx.fillStyle = SONAR.scopeBackground;
  ctx.beginPath();
  ctx.arc(centre, centre, radius, 0, Math.PI * 2);
  ctx.fill();

  // Entfernungsringe
  ctx.lineWidth = unit;
  // Explizit `number`: SONAR ist `as const`, sonst wäre die Laufvariable auf
  // das Literal des Startwerts festgelegt.
  for (let range: number = SONAR.ringSpacing; range <= SONAR.range; range += SONAR.ringSpacing) {
    const outer = range === SONAR.range;
    ctx.strokeStyle = line(outer ? 0.55 : 0.2);
    ctx.beginPath();
    ctx.arc(centre, centre, range * scale, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.strokeStyle = line(0.16);
  ctx.beginPath();
  ctx.moveTo(centre, centre - radius);
  ctx.lineTo(centre, centre + radius);
  ctx.moveTo(centre - radius, centre);
  ctx.lineTo(centre + radius, centre);
  ctx.stroke();

  drawTrail(ctx, centre, radius);

  // Echos: eingefrorene Positionen, relativ zum AKTUELLEN eigenen Standort.
  for (const echo of echoes.values()) {
    const dx = echo.x - state.x;
    const dy = echo.y - state.y;
    const distance = Math.hypot(dx, dy);
    if (distance > SONAR.range) continue;

    const age = clock - echo.at;
    const fresh = age < SONAR.flashSeconds;
    const fade = fresh
      ? 1
      : Math.max(
          SONAR.minEchoAlpha,
          1 - (age - SONAR.flashSeconds) / (SONAR.sweepSeconds - SONAR.flashSeconds),
        );

    const x = centre + dx * scale;
    const y = centre + dy * scale;
    const heading = echo.rotation * DEG;

    ctx.globalAlpha = fade;
    ctx.strokeStyle = fresh ? SONAR.flashColor : SONAR.echoColor;
    ctx.lineWidth = unit;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.sin(heading) * 9 * unit, y - Math.cos(heading) * 9 * unit);
    ctx.stroke();

    ctx.fillStyle = fresh ? SONAR.flashColor : SONAR.echoColor;
    ctx.beginPath();
    ctx.arc(x, y, (fresh ? 4.2 : 3) * unit, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Strahl zuletzt, damit er über den Echos liegt.
  const angle = sweep * DEG;
  ctx.strokeStyle = line(0.9);
  ctx.lineWidth = 1.5 * unit;
  ctx.beginPath();
  ctx.moveTo(centre, centre);
  ctx.lineTo(centre + Math.sin(angle) * radius, centre - Math.cos(angle) * radius);
  ctx.stroke();

  // Eigener Kurs als kurze Kerbe am Rand — ein voller Strich würde mit dem
  // Strahl verwechselt.
  const course = state.course * DEG;
  ctx.strokeStyle = line(1);
  ctx.lineWidth = 2.5 * unit;
  ctx.beginPath();
  ctx.moveTo(centre + Math.sin(course) * (radius - 9 * unit), centre - Math.cos(course) * (radius - 9 * unit));
  ctx.lineTo(centre + Math.sin(course) * radius, centre - Math.cos(course) * radius);
  ctx.stroke();

  ctx.fillStyle = SONAR.color;
  ctx.beginPath();
  ctx.arc(centre, centre, 2.5 * unit, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Nachleuchten hinter dem Strahl. Als gestaffelte Sektoren statt als
 * Kegelverlauf — `createConicGradient` ist nicht überall verfügbar, und der
 * Unterschied ist bei dieser Größe nicht zu sehen.
 */
function drawTrail(ctx: CanvasRenderingContext2D, centre: number, radius: number): void {
  const segments = 18;
  const width = SONAR.trailDegrees / segments;

  for (let i = 0; i < segments; i += 1) {
    const from = sweep - (i + 1) * width;
    const to = sweep - i * width;
    // Hinten schwächer: das ist das Abklingen der Leuchtschicht.
    ctx.fillStyle = line(Number((0.16 * (1 - i / segments) ** 2).toFixed(4)));
    ctx.beginPath();
    ctx.moveTo(centre, centre);
    // Canvas misst ab Ost gegen den Uhrzeigersinn, das Sonar ab Nord im
    // Uhrzeigersinn — daher die Drehung um 90°.
    ctx.arc(centre, centre, radius, (from - 90) * DEG, (to - 90) * DEG);
    ctx.closePath();
    ctx.fill();
  }
}

function resize(): void {
  const element = canvas.value;
  if (!element) return;
  // Zeichenpuffer in Geräte-Pixeln — der 2D-Kontext läuft mit voller
  // devicePixelRatio, während der WebGL-Renderer bewusst auf 1,5 gedeckelt ist.
  const side = Math.max(1, Math.round(element.clientWidth * devicePixelRatio));
  if (element.width !== side) {
    element.width = side;
    element.height = side;
  }
  draw();
}

onMounted(() => {
  const element = canvas.value;
  if (!element) return;
  context = element.getContext('2d');
  observer = new ResizeObserver(resize);
  observer.observe(element);
  resize();
  stopFrames = onFrame(advance);

  if (import.meta.env.DEV) {
    // Einblick in Strahlstellung und eingefrorene Echos aus der Konsole.
    (window as unknown as { __sonar?: unknown }).__sonar = () => ({
      sweep,
      clock,
      echoes: [...echoes.entries()].map(([id, e]) => ({ id, ...e })),
    });
  }
});

onBeforeUnmount(() => {
  stopFrames?.();
  stopFrames = null;
  observer?.disconnect();
  observer = null;
  context = null;
  echoes.clear();
});
</script>

<template>
  <section class="hud__panel sonar" aria-label="Sonar">
    <canvas ref="canvas" class="sonar__scope"></canvas>
  </section>
</template>

<style scoped>
/*
 * Der Rahmen ersetzt die übliche Panel-Optik — Hintergrund, Rand und Polster
 * kommen aus der Grafik. `.hud__panel` bleibt trotzdem gesetzt, weil davon
 * `pointer-events: auto` kommt.
 */
.sonar {
  position: relative;
  display: grid;
  place-items: center;
  width: clamp(176px, 22vh, 264px);
  aspect-ratio: 1;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: none;
  backdrop-filter: none;
}

/*
 * Der Rahmen liegt VOR der Scheibe, nicht dahinter.
 *
 * Als Hintergrundbild des Panels würde ihn die Leinwand überdecken — Kinder
 * werden über dem Hintergrund ihres Elternteils gezeichnet, und die Leinwand
 * reicht absichtlich unter das Rahmenband. Als überlagerndes Element maskiert
 * der Rahmen die Leinwandkanten sauber, so wie eine Blende vor einem Schirm.
 */
.sonar::after {
  content: '';
  position: absolute;
  inset: 0;
  background: url('../assets/ui/sonar-frame.png') center / 100% 100% no-repeat;
  pointer-events: none;
}

/*
 * Die Innenöffnung des Rahmens misst 85,8 % der Breite und 88,0 % der Höhe.
 * Die Leinwand nimmt 88 % ein und füllt die Öffnung damit senkrecht genau aus,
 * während sie waagerecht rund zwei Pixel unter das Rahmenband läuft — so bleibt
 * nirgends eine Lücke, durch die die Karte durchschiene. Die Scheibe selbst ist
 * kleiner und bleibt vollständig in der Öffnung.
 */
.sonar__scope {
  display: block;
  width: 88%;
  aspect-ratio: 1;
}
</style>
