// frontend/src/theme/examples.js — starter scripts for the theme editor.
//
// Each one is a complete theme module: `export default function setup(ctx)`.
// They use only the documented ctx API (docs/features/themes.md), respect
// reduced motion, and leave nothing behind when the theme changes.

export const SCRIPT_EXAMPLES = [
  {
    id: 'pointer-glow',
    label: 'Pointer glow',
    note: 'a soft light follows your finger or cursor',
    code: `// Pointer glow — a soft accent light that follows the pointer.
export default function setup(ctx) {
  ctx.addStyle(\`
    body::after {
      content: '';
      position: fixed;
      inset: 0;
      z-index: 2147483000;
      pointer-events: none;
      background: radial-gradient(260px circle at var(--glow-x, 50%) var(--glow-y, 40%),
        color-mix(in srgb, var(--accent) 14%, transparent), transparent 70%);
      transition: opacity .4s;
    }
  \`);
  const move = (event) => {
    ctx.setVar('--glow-x', event.clientX + 'px');
    ctx.setVar('--glow-y', event.clientY + 'px');
  };
  window.addEventListener('pointermove', move, { passive: true, signal: ctx.signal });
  window.addEventListener('pointerdown', move, { passive: true, signal: ctx.signal });
}
`
  },
  {
    id: 'starfield',
    label: 'Starfield',
    note: 'slow drifting stars behind the app',
    code: `// Starfield — a canvas of drifting stars behind the whole app.
export default function setup(ctx) {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  Object.assign(canvas.style, {
    position: 'fixed', inset: '0', width: '100%', height: '100%',
    zIndex: '-1', pointerEvents: 'none'
  });
  // Behind #app: body and the app shell must not paint over it.
  ctx.addStyle('html { background: var(--bg); } body, .app__shell, .app__main--flush { background: transparent; }');
  document.body.prepend(canvas);
  const g = canvas.getContext('2d');
  let stars = [];
  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    stars = Array.from({ length: Math.round(innerWidth * innerHeight / 9000) }, () => ({
      x: Math.random() * innerWidth, y: Math.random() * innerHeight,
      r: Math.random() * 1.2 + 0.2, v: Math.random() * 0.03 + 0.01
    }));
  };
  resize();
  window.addEventListener('resize', resize, { signal: ctx.signal });
  const color = getComputedStyle(ctx.root).getPropertyValue('--fg').trim() || '#fff';
  const draw = (dt) => {
    g.clearRect(0, 0, innerWidth, innerHeight);
    g.fillStyle = color;
    for (const s of stars) {
      s.y -= s.v * dt;
      if (s.y < 0) { s.y = innerHeight; s.x = Math.random() * innerWidth; }
      g.globalAlpha = 0.25 + s.r * 0.35;
      g.beginPath(); g.arc(s.x, s.y, s.r, 0, Math.PI * 2); g.fill();
    }
  };
  if (ctx.reducedMotion) draw(0);
  else ctx.onFrame((now, dt) => draw(dt));
  return () => canvas.remove();
}
`
  },
  {
    id: 'page-transitions',
    label: 'Page transitions',
    note: 'each screen slides and fades in',
    code: `// Page transitions — animate the main view on every navigation.
export default function setup(ctx) {
  let first = true;
  ctx.onRoute(() => {
    if (first) { first = false; return; }
    if (ctx.reducedMotion) return;
    // Wait one frame so the new view is in the DOM.
    requestAnimationFrame(() => {
      const main = document.querySelector('.app__main');
      if (!main) return;
      main.animate([
        { opacity: 0, transform: 'translateY(10px) scale(.99)' },
        { opacity: 1, transform: 'none' }
      ], { duration: 260, easing: 'cubic-bezier(.16,.84,.44,1)' });
    });
  });
}
`
  },
  {
    id: 'time-of-day',
    label: 'Time-of-day accent',
    note: 'the accent shifts from dawn to night',
    code: `// Time-of-day accent — warmer in the morning, cooler at night.
export default function setup(ctx) {
  const paint = () => {
    const h = new Date().getHours() + new Date().getMinutes() / 60;
    const hue = Math.round(30 + (h / 24) * 200); // 30 (dawn) → 230 (night)
    ctx.setVar('--accent', 'hsl(' + hue + ' 85% 68%)');
    ctx.setVar('--accent-soft', 'hsl(' + hue + ' 85% 68% / .16)');
  };
  paint();
  const timer = setInterval(paint, 60 * 1000);
  return () => clearInterval(timer);
}
`
  }
];

export const SCRIPT_TEMPLATE = `// Theme script — runs in the app page after the theme is applied.
// ctx: theme, root, app, signal, reducedMotion, route,
//      addStyle(css), setVar(name, value), onRoute(fn), onFrame(fn), onMotionChange(fn)
// Return a function to clean up anything ctx does not track for you.
export default function setup(ctx) {
}
`;
