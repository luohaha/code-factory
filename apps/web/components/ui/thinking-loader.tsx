'use client';

// Adapted from affectUI Thinking Loader (Clean), MIT © 2026 Florian Höller (adfects).
// https://www.affectui.com/components/thinking-loader — see THIRD_PARTY_NOTICES.md.
import { useLayoutEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

const rays = Array.from({ length: 8 }, (_, i) => i);

/** Labels come from actual application state, rather than simulated timed phases. */
export function ThinkingLoader({ label, done = false, className }: {
  label: string;
  done?: boolean;
  className?: string;
}) {
  const [shown, setShown] = useState({ key: 0, text: label });
  const [leaving, setLeaving] = useState<typeof shown | null>(null);
  if (label !== shown.text) {
    setLeaving(shown);
    setShown({ key: shown.key + 1, text: label });
  }

  const box = useRef<HTMLSpanElement>(null);
  const current = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (box.current && current.current) {
      box.current.style.width = `${current.current.offsetWidth + 1}px`;
    }
  }, [shown.key]);

  return (
    <output className={cn('cf-thinking-loader', className)} data-done={done || undefined} aria-live="polite" aria-atomic="true">
      <style href="cf-thinking-loader" precedence="default">{css}</style>
      <span className="cf-thinking-loader__icon" aria-hidden="true">
        <svg className="cf-thinking-loader__spinner" viewBox="0 0 16 16">
          {rays.map((i) => (
            <line key={i} x1="8" y1="1.75" x2="8" y2="4.75" transform={`rotate(${i * 45} 8 8)`} style={{ animationDelay: `${(i - 8) * 100}ms` }} />
          ))}
        </svg>
        <svg className="cf-thinking-loader__check" viewBox="0 0 16 16"><path d="M3.5 8.4 6.6 11.3 12.5 4.9" pathLength={1} /></svg>
      </span>
      <span ref={box} className="cf-thinking-loader__text">
        {leaving ? (
          <span key={leaving.key} className="cf-thinking-loader__label cf-thinking-loader__out" aria-hidden="true" onAnimationEnd={() => setLeaving(null)}>{leaving.text}</span>
        ) : null}
        <span key={shown.key} ref={current} className="cf-thinking-loader__label" data-text={shown.text}>{shown.text}</span>
      </span>
    </output>
  );
}

const css = `
.cf-thinking-loader {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%; min-width: 0;
  padding: 5px 8px; border: 1px solid var(--border); border-radius: var(--radius-md);
  background: var(--card); color: var(--muted-foreground); font-family: inherit;
  font-size: 11px; font-weight: 500; line-height: 18px; vertical-align: middle;
}
.cf-thinking-loader__icon { position: relative; flex: none; width: 14px; height: 14px; color: var(--primary); }
.cf-thinking-loader__icon svg { position: absolute; inset: 0; width: 100%; height: 100%; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; transition: opacity 240ms ease, transform 420ms ease; }
.cf-thinking-loader__spinner line { stroke-width: 1.1; opacity: .2; animation: cf-thinking-ray 800ms linear infinite; }
.cf-thinking-loader__check { opacity: 0; transform: scale(.6); stroke-width: 1.2; }
.cf-thinking-loader__check path { stroke-dasharray: 1; stroke-dashoffset: 1; }
.cf-thinking-loader[data-done] .cf-thinking-loader__spinner { opacity: 0; transform: scale(.6) rotate(-45deg); }
.cf-thinking-loader[data-done] .cf-thinking-loader__check { opacity: 1; transform: none; }
.cf-thinking-loader[data-done] .cf-thinking-loader__check path { animation: cf-thinking-draw 360ms ease 120ms forwards; }
.cf-thinking-loader__text { position: relative; display: block; height: 18px; min-width: 0; max-width: 100%; overflow: hidden; transition: width 460ms cubic-bezier(.22,1,.36,1); }
.cf-thinking-loader__label { position: absolute; top: 0; left: 0; white-space: nowrap; animation: cf-thinking-in 460ms ease both; }
.cf-thinking-loader__out { animation: cf-thinking-out 320ms ease both; }
.cf-thinking-loader:not([data-done]) .cf-thinking-loader__label:not(.cf-thinking-loader__out)::after {
  content: attr(data-text) / ''; position: absolute; inset: 0; color: transparent;
  background: linear-gradient(90deg, transparent 38%, var(--foreground) 50%, transparent 62%) 100% 0 / 300% 100% no-repeat;
  background-clip: text; animation: cf-thinking-sweep 1.6s linear infinite; pointer-events: none;
}
@keyframes cf-thinking-ray { from { opacity: 1; } to { opacity: .2; } }
@keyframes cf-thinking-in { from { opacity: 0; transform: translateY(70%); filter: blur(3px); } to { opacity: 1; transform: none; filter: none; } }
@keyframes cf-thinking-out { to { opacity: 0; transform: translateY(-70%); filter: blur(3px); } }
@keyframes cf-thinking-draw { to { stroke-dashoffset: 0; } }
@keyframes cf-thinking-sweep { from { background-position: 100% 0; } to { background-position: 0% 0; } }
@media (prefers-reduced-motion: reduce) {
  .cf-thinking-loader *, .cf-thinking-loader *::after { animation: none !important; transition: none !important; }
  .cf-thinking-loader__out, .cf-thinking-loader__label::after { display: none; }
  .cf-thinking-loader__spinner line { opacity: .6; }
  .cf-thinking-loader__check path { stroke-dashoffset: 0; }
}
`;
