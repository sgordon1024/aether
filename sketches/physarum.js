// Mycelium — a CPU Physarum (slime-mold) agent simulation.
//
// ~18,000 agents crawl across a scaled-down scent grid (canvas / 1.5).
// Each agent SENSES the trail map at three points (front-left, front,
// front-right), STEERS toward the strongest scent, MOVES forward, and
// DEPOSITS a little trail. Every frame the trail is DIFFUSED (a cheap 3x3
// box blur) and DECAYED (multiplied down). The grid is colorized through a
// bioluminescent palette into a p5.Image and scaled up to fill the canvas.
//
// The emergent transport networks — branching, pulsing veins — are the show.
//
// AGENT COUNT: ~18,000   GRID SCALE: canvas / 1.5  (with a hard pixel cap)
//
// INTERACTION:
//   - Move the mouse  -> a strong scent halo attracts agents to the cursor.
//   - Click / drag     -> drop a bright burst of "food" scent.
//   - Mouse wheel      -> grow/shrink the sensor distance (network density).
//
// Pure CPU/JS. No shaders. p5.js v1.9.4, global mode, WebGL1 not required.

// ----------------------------------------------------------------------------
// Tunables
// ----------------------------------------------------------------------------
const MOBILE = !!(window.__isMobile);

const GRID_SCALE = MOBILE ? 2.4 : 1.5;          // trail grid = canvas / GRID_SCALE
const MAX_GRID_CELLS = MOBILE ? 640 * 400 : 1300 * 820; // hard cap on grid pixels (perf guard)
const TARGET_AGENTS = MOBILE ? 6000 : 18000;     // agent count (tuned for ~60fps Apple Silicon)

const SENSE_ANGLE = 0.45;        // radians between center and side sensors
let   senseDist = 9.0;           // pixels ahead the agent looks (mouse-wheel)
const TURN_ANGLE = 0.55;         // radians an agent rotates toward best scent
const MOVE_SPEED = 1.0;          // pixels per step in grid space
const DEPOSIT = 0.85;            // trail dropped per agent per step
const DECAY = 0.94;              // multiplicative trail decay per frame
const DIFFUSE = 0.62;            // 0..1 blend toward the 3x3 blurred value

const MOUSE_SCENT = 2.6;         // scent added under the cursor each frame
const MOUSE_RADIUS = 26;         // radius (grid px) of the cursor scent halo

// ----------------------------------------------------------------------------
// State
// ----------------------------------------------------------------------------
let gw, gh;                      // grid width / height (in cells)
let trail, blurBuf;             // Float32Array scent maps (current + scratch)
let ax, ay, ah;                 // agent positions (Float32Array) + heading
let nAgents = 0;
let img;                         // p5.Image we write pixels into and upscale
let palette;                     // precomputed 256-entry RGB lookup table

// ----------------------------------------------------------------------------
// setup
// ----------------------------------------------------------------------------
function setup() {
  createCanvas(windowWidth, windowHeight);
  pixelDensity(1);
  noSmooth();

  buildPalette();
  buildSim();

  if (window.__sketchReady) window.__sketchReady();
}

// Build / rebuild every size-dependent buffer.
function buildSim() {
  // Derive grid size from the canvas, then clamp total cells for performance.
  gw = Math.max(2, Math.floor(width / GRID_SCALE));
  gh = Math.max(2, Math.floor(height / GRID_SCALE));
  if (gw * gh > MAX_GRID_CELLS) {
    const s = Math.sqrt(MAX_GRID_CELLS / (gw * gh));
    gw = Math.max(2, Math.floor(gw * s));
    gh = Math.max(2, Math.floor(gh * s));
  }

  const cells = gw * gh;
  trail = new Float32Array(cells);
  blurBuf = new Float32Array(cells);

  // The displayed image matches the grid resolution; p5 upscales it to canvas.
  img = createImage(gw, gh);

  // Scale agent count modestly with grid area so small windows stay lively
  // and huge windows do not melt the CPU.
  nAgents = Math.min(TARGET_AGENTS,
                     Math.max(MOBILE ? 2500 : 4000, Math.floor(cells * 0.07)));

  ax = new Float32Array(nAgents);
  ay = new Float32Array(nAgents);
  ah = new Float32Array(nAgents);

  // Seed agents in a soft central disc, headings pointing outward — this
  // gives a satisfying radial bloom in the first second of life.
  const cx = gw * 0.5, cy = gh * 0.5;
  const r0 = Math.min(gw, gh) * 0.22;
  for (let i = 0; i < nAgents; i++) {
    const a = Math.random() * Math.PI * 2;
    const rr = Math.sqrt(Math.random()) * r0;
    ax[i] = cx + Math.cos(a) * rr;
    ay[i] = cy + Math.sin(a) * rr;
    ah[i] = a + (Math.random() - 0.5) * 0.6;
  }
}

// Precompute a 256-step bioluminescent palette (deep teal -> cyan -> mint glow).
function buildPalette() {
  palette = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    // Smooth ramp with a hot near-white highlight at the top.
    const r = clamp01(smooth(t, 0.55, 1.0) * 0.9 + Math.pow(t, 6) * 0.7);
    const g = clamp01(Math.pow(t, 0.7) * 1.05);
    const b = clamp01(0.18 + smooth(t, 0.0, 0.5) * 0.9);
    palette[i * 3]     = (r * 255) | 0;
    palette[i * 3 + 1] = (g * 255) | 0;
    palette[i * 3 + 2] = (b * 255) | 0;
  }
}

// ----------------------------------------------------------------------------
// draw
// ----------------------------------------------------------------------------
function draw() {
  // --- Continuous mouse scent (guard the initial (0,0) position) ---
  if (mouseHasMoved()) {
    const mx = (mouseX / width) * gw;
    const my = (mouseY / height) * gh;
    stampScent(mx, my, MOUSE_RADIUS, MOUSE_SCENT);
  }

  // While the button is held, keep feeding extra scent for a thick vein.
  if (mouseIsPressed && mouseHasMoved()) {
    const mx = (mouseX / width) * gw;
    const my = (mouseY / height) * gh;
    stampScent(mx, my, MOUSE_RADIUS * 0.6, MOUSE_SCENT * 2.2);
  }

  // --- Simulation steps ---
  stepAgents();
  diffuseAndDecay();

  // --- Render the scent grid into the image, then upscale to the canvas ---
  renderTrail();

  background(4, 6, 9);
  // Draw the (small) image stretched across the whole canvas. With WEBGL off
  // we are in 2D mode, so image() uses top-left coordinates.
  image(img, 0, 0, width, height);
}

// ----------------------------------------------------------------------------
// Physarum agent step: sense -> steer -> move -> deposit
// ----------------------------------------------------------------------------
function stepAgents() {
  const w = gw, h = gh;
  for (let i = 0; i < nAgents; i++) {
    const x = ax[i], y = ay[i], heading = ah[i];

    // Sense at three points ahead.
    const fl = senseAt(x, y, heading - SENSE_ANGLE, w, h);
    const fc = senseAt(x, y, heading, w, h);
    const fr = senseAt(x, y, heading + SENSE_ANGLE, w, h);

    // Steer toward the strongest concentration.
    let nh = heading;
    if (fc >= fl && fc >= fr) {
      // straight ahead is best — keep heading
    } else if (fl > fr) {
      nh = heading - TURN_ANGLE;
    } else if (fr > fl) {
      nh = heading + TURN_ANGLE;
    } else {
      // tie between sides — pick a random direction to break symmetry
      nh = heading + (Math.random() < 0.5 ? -TURN_ANGLE : TURN_ANGLE);
    }

    // Move forward.
    let nx = x + Math.cos(nh) * MOVE_SPEED;
    let ny = y + Math.sin(nh) * MOVE_SPEED;

    // Wrap around edges (toroidal world keeps the network seamless).
    if (nx < 0) nx += w; else if (nx >= w) nx -= w;
    if (ny < 0) ny += h; else if (ny >= h) ny -= h;

    // NaN guard: if anything went sideways, respawn this agent centrally.
    if (!isFinite(nx) || !isFinite(ny) || !isFinite(nh)) {
      nx = w * 0.5; ny = h * 0.5; nh = Math.random() * Math.PI * 2;
    }

    ax[i] = nx; ay[i] = ny; ah[i] = nh;

    // Deposit trail at the new cell. Clamp the integer cell index as a final
    // guard so a deposit can never land outside the buffer under any float
    // rounding edge case.
    let ix = nx | 0, iy = ny | 0;
    if (ix < 0) ix = 0; else if (ix >= w) ix = w - 1;
    if (iy < 0) iy = 0; else if (iy >= h) iy = h - 1;
    trail[iy * w + ix] += DEPOSIT;
  }
}

// Sample the trail a fixed distance ahead along a given angle (toroidal).
function senseAt(x, y, ang, w, h) {
  let sx = x + Math.cos(ang) * senseDist;
  let sy = y + Math.sin(ang) * senseDist;
  // Toroidal wrap into [0,w) / [0,h).
  sx = sx - Math.floor(sx / w) * w;
  sy = sy - Math.floor(sy / h) * h;
  let ix = sx | 0, iy = sy | 0;
  // Clamp against float-precision corner cases (e.g. sx rounding up to w).
  if (ix < 0) ix = 0; else if (ix >= w) ix = w - 1;
  if (iy < 0) iy = 0; else if (iy >= h) iy = h - 1;
  return trail[iy * w + ix];
}

// ----------------------------------------------------------------------------
// Diffuse (3x3 box blur, blended) + multiplicative decay
// ----------------------------------------------------------------------------
function diffuseAndDecay() {
  const w = gw, h = gh;
  const src = trail, dst = blurBuf;

  for (let y = 0; y < h; y++) {
    const ym = y > 0 ? y - 1 : h - 1;
    const yp = y < h - 1 ? y + 1 : 0;
    const rowm = ym * w, row0 = y * w, rowp = yp * w;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : w - 1;
      const xp = x < w - 1 ? x + 1 : 0;

      // 3x3 average (wrapped) — cheap diffusion.
      const sum =
        src[rowm + xm] + src[rowm + x] + src[rowm + xp] +
        src[row0 + xm] + src[row0 + x] + src[row0 + xp] +
        src[rowp + xm] + src[rowp + x] + src[rowp + xp];
      const avg = sum * 0.1111111; // /9

      const i = row0 + x;
      // Blend toward blur, then decay. DIFFUSE controls how mushy it is.
      let v = src[i] + (avg - src[i]) * DIFFUSE;
      v *= DECAY;
      dst[i] = v < 0.0001 ? 0 : v; // flush tiny values to zero
    }
  }

  // Swap buffers (dst becomes the live trail).
  trail = dst;
  blurBuf = src;
}

// ----------------------------------------------------------------------------
// Render the scent grid -> palette -> image pixels
// ----------------------------------------------------------------------------
function renderTrail() {
  img.loadPixels();
  const px = img.pixels;
  const t = trail;
  const n = gw * gh;
  for (let i = 0; i < n; i++) {
    // Tone-map the unbounded scent into 0..255 with a soft knee so bright
    // veins glow without clipping the whole field to white.
    let v = t[i];
    if (!(v > 0)) v = 0; // NaN / negative guard
    // v / (v + k) is a Reinhard-style rolloff.
    const m = v / (v + 1.6);          // 0..1
    let li = (m * 255) | 0;
    if (li < 0) li = 0; else if (li > 255) li = 255;

    const p = li * 3;
    const o = i * 4;
    px[o]     = palette[p];
    px[o + 1] = palette[p + 1];
    px[o + 2] = palette[p + 2];
    px[o + 3] = 255;
  }
  img.updatePixels();
}

// ----------------------------------------------------------------------------
// Scent stamping (mouse attractor + food bursts)
// ----------------------------------------------------------------------------
function stampScent(cx, cy, radius, amount) {
  const w = gw, h = gh;
  const r = radius | 0;
  const r2 = radius * radius;
  if (r2 <= 0) return;
  const icx = cx | 0, icy = cy | 0;
  for (let dy = -r; dy <= r; dy++) {
    // True modulo wrap keeps the row index in-bounds for any grid size.
    let yy = ((icy + dy) % h + h) % h;
    const row = yy * w;
    for (let dx = -r; dx <= r; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      let xx = ((icx + dx) % w + w) % w;
      // Falloff: strongest at center.
      const f = 1 - d2 / r2;
      trail[row + xx] += amount * f * f;
    }
  }
}

// True once the mouse has actually moved away from the initial (0,0).
function mouseHasMoved() {
  return (mouseX !== 0 || mouseY !== 0) &&
         mouseX >= 0 && mouseX <= width &&
         mouseY >= 0 && mouseY <= height;
}

// ----------------------------------------------------------------------------
// Interaction
// ----------------------------------------------------------------------------
function mousePressed() {
  dropFood();
}

function mouseDragged() {
  // Continuous burst trail while dragging.
  dropFood();
}

function dropFood() {
  if (!mouseHasMoved()) return;
  const mx = (mouseX / width) * gw;
  const my = (mouseY / height) * gh;
  // A fat, bright burst of food that agents will rush toward.
  stampScent(mx, my, MOUSE_RADIUS * 1.6, MOUSE_SCENT * 6);
}

function mouseWheel(e) {
  // Scroll to grow/shrink sensor distance -> tighter or looser networks.
  // p5 1.9.4 sets event.delta = deltaY; fall back to deltaY just in case.
  const d = (e && typeof e.delta === 'number') ? e.delta
          : (e && typeof e.deltaY === 'number') ? e.deltaY : 0;
  senseDist = constrain(senseDist + (d > 0 ? 0.6 : -0.6), 3, 22);
  return false; // prevent page scroll
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

// Smoothstep between edge0 and edge1.
function smooth(x, e0, e1) {
  if (e1 === e0) return x < e0 ? 0 : 1;
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

// ----------------------------------------------------------------------------
// Resize: recreate every size-dependent buffer.
// ----------------------------------------------------------------------------
function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  buildSim();
}