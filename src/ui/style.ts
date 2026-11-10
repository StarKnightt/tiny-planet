// Injected stylesheet for the play-mode UI. System fonts only.
export const STYLE = /* css */ `
.tp-root {
  --ink: #fbf5ea;
  --ink-2: rgba(251, 245, 234, 0.74);
  --ink-3: rgba(251, 245, 234, 0.52);
  --glass: rgba(18, 22, 38, 0.42);
  --glass-2: rgba(18, 22, 38, 0.58);
  --line: rgba(255, 255, 255, 0.13);
  --warm: #ffcf8a;
  --warm-2: #ff9f6e;
  --font: "Segoe UI Variable Display", "Segoe UI Variable Text", "SF Pro Rounded", ui-rounded, "SF Pro Display",
    -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Roboto, "Helvetica Neue", sans-serif;
  position: fixed; inset: 0; pointer-events: none; color: var(--ink); font-family: var(--font);
  -webkit-font-smoothing: antialiased; user-select: none; -webkit-user-select: none;
  font-size: 15px; line-height: 1.4; letter-spacing: 0.005em;
}
.tp-root * { box-sizing: border-box; }
.tp-ico { display: inline-flex; width: 1.15em; height: 1.15em; flex: none; }
.tp-ico svg { width: 100%; height: 100%; display: block; }

/* ---------- glass ---------- */
.tp-glass, .tp-legend, .tp-chip, .tp-dial, .tp-hint, .tp-toast, .tp-card {
  background: var(--glass);
  border: 1px solid var(--line);
  backdrop-filter: blur(14px) saturate(150%);
  -webkit-backdrop-filter: blur(14px) saturate(150%);
  box-shadow: 0 10px 34px rgba(4, 6, 16, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.07);
}

/* ---------- keycaps ---------- */
.tp-k {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 1.85em; height: 1.85em; padding: 0 0.45em; margin: 0 0.12em;
  font: 600 0.74em/1 var(--font); letter-spacing: 0.02em; color: var(--ink);
  background: linear-gradient(180deg, rgba(255,255,255,0.20), rgba(255,255,255,0.08));
  border: 1px solid rgba(255,255,255,0.22); border-bottom-width: 2px; border-radius: 0.5em;
  box-shadow: 0 1px 0 rgba(0,0,0,0.25);
}
.tp-kw { padding: 0 0.7em; }

/* ---------- title ---------- */
.tp-scrim {
  position: absolute; inset: 0; pointer-events: auto; cursor: pointer;
  background:
    radial-gradient(120% 90% at 0% 50%, rgba(6, 8, 22, 0.62) 0%, rgba(6, 8, 22, 0.28) 38%, rgba(6, 8, 22, 0) 62%),
    linear-gradient(180deg, rgba(6,8,22,0.25), rgba(6,8,22,0) 22%, rgba(6,8,22,0) 78%, rgba(6,8,22,0.3));
  transition: opacity 1.4s ease;
}
.tp-title {
  position: absolute; left: clamp(28px, 7vw, 132px); top: 50%; transform: translateY(-50%);
  width: min(34em, calc(100vw - 56px)); pointer-events: auto; cursor: pointer;
  transition: opacity 0.9s ease, transform 1.1s cubic-bezier(.2,.7,.2,1), filter 0.9s ease;
}
.tp-eyebrow {
  display: inline-flex; align-items: center; gap: 0.55em; color: var(--warm);
  font-size: 0.78em; font-weight: 600; letter-spacing: 0.22em; text-transform: uppercase;
  text-shadow: 0 1px 12px rgba(0,0,0,0.35);
}
.tp-title h1 {
  margin: 0.12em 0 0; padding: 0.04em 0 0.14em; font-size: clamp(52px, 6.2vw, 112px); line-height: 0.95; font-weight: 750;
  letter-spacing: -0.035em; white-space: nowrap;
  background: linear-gradient(176deg, #fffaf0 0%, #ffe9c6 46%, #ffc58f 100%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
  filter: drop-shadow(0 4px 22px rgba(10, 8, 30, 0.45));
}
.tp-sub {
  margin: 0.35em 0 1.6em; max-width: 26em; color: var(--ink-2); font-size: clamp(15px, 1.15vw, 18px); line-height: 1.5;
  text-shadow: 0 1px 14px rgba(0,0,0,0.5);
}
.tp-cta {
  position: relative; display: inline-flex; align-items: center; gap: 0.7em;
  font: 650 1.02em/1 var(--font); letter-spacing: 0.01em; color: #2a1a10; cursor: pointer;
  padding: 0.95em 1.6em 0.95em 1.35em; border: 0; border-radius: 999px;
  background: linear-gradient(180deg, #ffe2b0, #ffb979);
  box-shadow: 0 10px 30px rgba(255, 150, 80, 0.32), 0 2px 0 rgba(255,255,255,0.5) inset, 0 -2px 0 rgba(160, 70, 20, 0.18) inset;
  transition: transform 0.25s ease, box-shadow 0.25s ease;
}
.tp-title:hover .tp-cta { transform: translateY(-1px) scale(1.02); box-shadow: 0 14px 36px rgba(255, 150, 80, 0.42), 0 2px 0 rgba(255,255,255,0.5) inset; }
.tp-pulse { position: relative; width: 9px; height: 9px; border-radius: 50%; background: #c2541f; }
.tp-pulse::after {
  content: ""; position: absolute; inset: -5px; border-radius: 50%; border: 2px solid rgba(194, 84, 31, 0.6);
  animation: tp-ping 2.2s cubic-bezier(.2,.6,.3,1) infinite;
}
@keyframes tp-ping { 0% { transform: scale(0.5); opacity: 1; } 80%, 100% { transform: scale(1.6); opacity: 0; } }

.tp-legend {
  display: grid; grid-template-columns: repeat(3, auto); gap: 0.55em 1.35em; justify-content: start;
  margin-top: 2.1em; padding: 0.95em 1.15em; border-radius: 18px; width: max-content; max-width: 100%;
  font-size: 0.9em; color: var(--ink-2);
}
.tp-row { display: flex; align-items: center; gap: 0.5em; white-space: nowrap; }
.tp-keys { display: inline-flex; align-items: center; }
.tp-legend .tp-ico { width: 1.5em; height: 1.5em; color: var(--ink); }

/* ---------- pause ---------- */
.tp-pause {
  position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; opacity: 0;
  background: radial-gradient(80% 80% at 50% 50%, rgba(6,8,22,0.18), rgba(6,8,22,0.5));
  transition: opacity 0.35s ease; cursor: pointer;
}
.tp-card {
  padding: 1.7em 2em 1.5em; border-radius: 24px; text-align: center; background: var(--glass-2);
  transform: translateY(8px) scale(0.98); transition: transform 0.45s cubic-bezier(.2,.8,.2,1);
}
.tp-pause-h { font-size: 1.9em; font-weight: 700; letter-spacing: -0.02em; }
.tp-pause-sub { color: var(--ink-2); margin-top: 0.2em; }
.tp-card .tp-legend { margin: 1.3em auto 0; background: rgba(255,255,255,0.05); box-shadow: none; backdrop-filter: none; -webkit-backdrop-filter: none; }
.tp-note { color: var(--warm); font-size: 0.85em; margin-top: 0.9em; min-height: 1.2em; }
.tp-note:empty { display: none; }

/* ---------- HUD ---------- */
.tp-hud { position: absolute; inset: 0; opacity: 0; transition: opacity 0.9s ease 0.1s; }
.tp-chip {
  position: absolute; left: 22px; top: 20px; display: inline-flex; align-items: center; gap: 0.55em;
  padding: 0.5em 0.95em 0.5em 0.75em; border-radius: 999px; font-weight: 600; font-size: 0.92em;
  transition: background 0.4s ease;
}
.tp-chip .tp-ico { color: var(--warm); width: 1.3em; height: 1.3em; }
.tp-chip[data-mode="Flying"] .tp-ico { color: #a9dcff; }
.tp-chip[data-mode="Swimming"] .tp-ico { color: #8fe6dc; }
.tp-chip-alt { color: var(--ink-3); font-weight: 500; font-variant-numeric: tabular-nums; }
.tp-chip-alt:empty { display: none; }
.tp-chip-alt::before { content: ""; display: inline-block; width: 1px; height: 0.9em; margin: 0 0.6em -0.1em 0.1em; background: var(--line); }
.tp-bump { animation: tp-bump 0.5s cubic-bezier(.3,1.6,.5,1); }
@keyframes tp-bump { 0% { transform: scale(0.92); } 100% { transform: scale(1); } }

.tp-dial {
  position: absolute; right: 22px; top: 20px; display: inline-flex; align-items: center; gap: 0.5em;
  padding: 0.3em 0.95em 0.3em 0.45em; border-radius: 999px; font-weight: 600; font-size: 0.92em;
  --sky-a: 0.3; --dusk: 0;
}
.tp-dial svg { width: 44px; height: 33px; overflow: visible; }
.tp-dial-arc { fill: rgba(150, 200, 255, var(--sky-a)); stroke: rgba(255,255,255,0.28); stroke-width: 1; }
.tp-dial[data-night="1"] .tp-dial-arc { fill: rgba(70, 90, 170, 0.28); }
.tp-dial-hz { stroke: rgba(255,255,255,0.45); stroke-width: 1.4; stroke-linecap: round; }
.tp-sun-glow { fill: rgba(255, 190, 110, 0.32); }
.tp-sun-disc { fill: #ffd27a; }
.tp-moon { fill: #e8ecff; display: none; }
.tp-dial[data-night="1"] .tp-sun { display: none; }
.tp-dial[data-night="1"] .tp-moon { display: inline; }
.tp-dial-l { min-width: 4.6em; }

.tp-cross {
  position: absolute; left: 50%; top: 50%; width: 5px; height: 5px; margin: -2.5px 0 0 -2.5px; border-radius: 50%;
  background: rgba(255,255,255,0.85); box-shadow: 0 0 0 1.5px rgba(0,0,0,0.18), 0 0 8px rgba(0,0,0,0.25);
}
.tp-hint {
  position: absolute; left: 50%; bottom: 28px; transform: translate(-50%, 10px); opacity: 0;
  display: flex; align-items: center; gap: 0.35em; white-space: nowrap;
  padding: 0.55em 1.05em; border-radius: 999px; color: var(--ink-2); font-size: 0.9em;
  transition: opacity 0.7s ease, transform 0.7s ease;
}
.tp-hint i { display: inline-block; width: 3px; height: 3px; border-radius: 50%; background: var(--ink-3); margin: 0 0.55em; }
.tp-hint.tp-on { opacity: 1; transform: translate(-50%, 0); }
.tp-toast {
  position: absolute; left: 50%; top: 22px; transform: translate(-50%, -8px); opacity: 0;
  display: flex; align-items: center; gap: 0.5em; padding: 0.5em 1em; border-radius: 999px; font-weight: 600; font-size: 0.9em;
  transition: opacity 0.35s ease, transform 0.35s ease;
}
.tp-toast.tp-on { opacity: 1; transform: translate(-50%, 0); }

/* ---------- screens ---------- */
.tp-root:not([data-screen="title"]) .tp-scrim { opacity: 0; pointer-events: none; }
.tp-root:not([data-screen="title"]) .tp-title { opacity: 0; transform: translateY(-50%) translateX(-24px); filter: blur(6px); pointer-events: none; }
.tp-root[data-screen="title"] .tp-title { animation: tp-in 1.4s cubic-bezier(.2,.7,.2,1) both; }
@keyframes tp-in { from { opacity: 0; transform: translateY(-46%); filter: blur(6px); } to { opacity: 1; transform: translateY(-50%); filter: blur(0); } }
.tp-root[data-screen="pause"] .tp-pause { opacity: 1; pointer-events: auto; }
.tp-root[data-screen="pause"] .tp-card { transform: none; }
.tp-root[data-screen="play"] .tp-hud, .tp-root[data-screen="pause"] .tp-hud { opacity: 1; }
.tp-root[data-screen="pause"] .tp-hud { transition-delay: 0s; }
.tp-root[data-screen="pause"] .tp-cross, .tp-root[data-screen="pause"] .tp-hint { opacity: 0; }

/* ---------- small / portrait screens ---------- */
@media (max-width: 760px), (max-aspect-ratio: 1/1) {
  .tp-title { left: 50%; top: auto; bottom: 6vh; transform: translateX(-50%); text-align: center; }
  .tp-root[data-screen="title"] .tp-title { animation: none; }
  .tp-root:not([data-screen="title"]) .tp-title { transform: translateX(-50%) translateY(12px); }
  .tp-eyebrow { justify-content: center; }
  .tp-sub { margin-left: auto; margin-right: auto; }
  .tp-legend { margin-left: auto; margin-right: auto; grid-template-columns: repeat(2, auto); }
  .tp-scrim { background: linear-gradient(0deg, rgba(6,8,22,0.7), rgba(6,8,22,0) 65%); }
  .tp-hint { display: none; }
}
@media (min-width: 1700px) { .tp-root { font-size: 17px; } }
@media (prefers-reduced-motion: reduce) { .tp-root *, .tp-root *::after { animation: none !important; transition-duration: 0.01s !important; } }
`;
