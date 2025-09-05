// charts.js — compact, pretty canvas charts (no deps)

/**
 * HiDPI setup so canvas looks crisp on phones.
 */
function setupHiDPI(canvas, cssW, cssH) {
  const r = Math.max(1, window.devicePixelRatio || 1);
  const w = Math.floor((cssW || canvas.clientWidth || canvas.width || 600) * r);
  const h = Math.floor((cssH || canvas.clientHeight || canvas.height || 240) * r);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(r, 0, 0, r, 0, 0);
  return { ctx, w: w / r, h: h / r, r };
}

/**
 * Draw light grid lines.
 */
function grid(ctx, w, h, { rows = 4, cols = 0 } = {}) {
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,.06)";
  ctx.lineWidth = 1;

  if (rows > 0) {
    for (let i = 1; i < rows; i++) {
      const y = (h * i) / rows;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
  }
  if (cols > 0) {
    for (let i = 1; i < cols; i++) {
      const x = (w * i) / cols;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/**
 * Rounded rectangle bar
 */
function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, Math.abs(h), Math.abs(w)) || 0;
  const up = h < 0;
  const sign = up ? -1 : 1;
  const ry = Math.min(rr, Math.abs(h));
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y + h - sign * ry);
  ctx.quadraticCurveTo(x, y + h, x + rr, y + h);
  ctx.lineTo(x + w - rr, y + h);
  ctx.quadraticCurveTo(x + w, y + h, x + w, y + h - sign * ry);
  ctx.lineTo(x + w, y);
  ctx.closePath();
}

/**
 * Nice max for y-scale.
 */
function niceMax(v) {
  if (v <= 0) return 10;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  let nice;
  if (norm <= 1) nice = 1;
  else if (norm <= 2) nice = 2;
  else if (norm <= 5) nice = 5;
  else nice = 10;
  return nice * mag;
}

/**
 * Linear gradient used across charts (matches app palette).
 */
function barGradient(ctx, x, y, w, h) {
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, "#5B8CFF");
  g.addColorStop(1, "#B85CFF");
  return g;
}

/**
 * 30-day points bar chart.
 * @param {HTMLCanvasElement} canvas
 * @param {number[]} values length up to 45 (we use 30)
 */
export function renderBarChart(canvas, values = []) {
  if (!canvas) return;
  const { ctx, w, h } = setupHiDPI(canvas, canvas.clientWidth, canvas.clientHeight);

  // padding
  const P = { t: 10, r: 8, b: 18, l: 8 };
  const cw = w - P.l - P.r;
  const ch = h - P.t - P.b;

  // bg clear
  ctx.clearRect(0, 0, w, h);

  // grid
  ctx.save();
  ctx.translate(P.l, P.t);
  grid(ctx, cw, ch, { rows: 4 });

  // scale
  const maxVal = Math.max(10, niceMax(Math.max(...values, 0)));
  const barCount = values.length;
  if (barCount === 0) {
    ctx.restore();
    return;
  }

  const gap = 4;
  const bw = Math.max(4, Math.floor((cw - gap * (barCount - 1)) / barCount));
  const grad = barGradient(ctx, 0, 0, 0, ch);

  // bars
  for (let i = 0; i < barCount; i++) {
    const v = Math.max(0, values[i] || 0);
    const x = i * (bw + gap);
    const hpx = Math.max(2, Math.round((v / maxVal) * ch));
    const y = ch - hpx;
    ctx.fillStyle = grad;
    roundRect(ctx, x, y, bw, hpx, 6);
    ctx.fill();
  }

  // baseline
  ctx.strokeStyle = "rgba(255,255,255,.08)";
  ctx.beginPath();
  ctx.moveTo(0, ch + 0.5);
  ctx.lineTo(cw, ch + 0.5);
  ctx.stroke();

  ctx.restore();
}

/**
 * 7-bar weekly micro chart (Mon..Sun).
 * @param {HTMLCanvasElement} canvas
 * @param {number[]} values length 7, Monday-first
 * @param {{labels?: string[]}} opts
 */
export function renderWeekChart(canvas, values = [], opts = {}) {
  if (!canvas) return;
  const { ctx, w, h } = setupHiDPI(canvas, canvas.clientWidth, canvas.clientHeight);

  const P = { t: 10, r: 10, b: 26, l: 10 };
  const cw = w - P.l - P.r;
  const ch = h - P.t - P.b;

  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.translate(P.l, P.t);

  // vertical grid (quarters)
  grid(ctx, cw, ch, { rows: 4 });

  const vals = (values && values.length === 7) ? values : [0,0,0,0,0,0,0];
  const ymax = Math.max(10, niceMax(Math.max(...vals)));
  const gap = 10;
  const bw = Math.max(14, Math.floor((cw - gap * 6) / 7));

  // bars
  const grad = barGradient(ctx, 0, 0, 0, ch);
  for (let i = 0; i < 7; i++) {
    const v = Math.max(0, vals[i] || 0);
    const x = i * (bw + gap);
    const hpx = Math.max(4, Math.round((v / ymax) * ch));
    const y = ch - hpx;

    // subtle shadow
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,.35)";
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = grad;
    roundRect(ctx, x, y, bw, hpx, 8);
    ctx.fill();
    ctx.restore();

    // highlight line at the top of bar
    ctx.fillStyle = "rgba(255,255,255,.08)";
    ctx.fillRect(x + 2, y, bw - 4, 2);
  }

  // baseline
  ctx.strokeStyle = "rgba(255,255,255,.08)";
  ctx.beginPath();
  ctx.moveTo(0, ch + 0.5);
  ctx.lineTo(cw, ch + 0.5);
  ctx.stroke();

  // labels
  const labels = opts.labels || ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  ctx.fillStyle = "rgba(230,233,242,.75)";
  ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let i = 0; i < 7; i++) {
    const x = i * (bw + gap) + bw / 2;
    ctx.fillText(labels[i], x, ch + 6);
  }

  ctx.restore();
}
