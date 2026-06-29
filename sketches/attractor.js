// ============================================================================
// "Stardust" — a 3D strange attractor as a glowing particle galaxy (WEBGL)
// ----------------------------------------------------------------------------
// Attractor: AIZAWA. ~45,000 particles are seeded near the attractor and each
// frame advanced a couple of small RK4 sub-steps along the velocity field, then
// drawn as additive points colored by speed (slow = deep violet/blue,
// fast = cyan/white). Particles that fly off or go NaN are recycled near the
// core. orbitControl() lets you drag to orbit; a slow auto-rotation kicks in
// when idle.
//
// PARTICLE COUNT: 45,000   |   SUB-STEPS/FRAME: 2 (RK4)   |   p5 v1.9.4, WebGL1
//
// Interaction:
//   - Drag                : orbit the camera
//   - Move mouse (no drag) : morph the attractor's parameters live
//   - Press & hold         : inject energy, scattering particles outward
//   - Click                : reseed a fresh swarm
//   - Scroll wheel         : zoom in / out
// ============================================================================

// ---- Tunables -------------------------------------------------------------
const NUM_PARTICLES = 45000; // stated particle count
const SUB_STEPS = 2;         // integration sub-steps per frame
const DT = 0.012;            // base time step for the integrator
const WORLD_SCALE = 150;     // scales attractor coords into screen-friendly units
const RESPAWN_RADIUS = 6.0;  // if |pos| exceeds this, recycle the particle
const POINT_PX = 2.0;        // on-screen point size in PIXELS (screen-space)

// ---- Aizawa attractor default parameters ----------------------------------
// dx = (z - b) x - d y
// dy = d x + (z - b) y
// dz = c + a z - z^3/3 - (x^2 + y^2)(1 + e z) + f z x^3
const AZ = { a: 0.95, b: 0.7, c: 0.6, d: 3.5, e: 0.25, f: 0.1 };

// Live (mouse-morphed) copies of the two most visually expressive params.
let liveA = AZ.a;
let liveB = AZ.b;

// ---- Particle state (flat typed arrays — no per-frame allocation) ---------
let px, py, pz;     // positions (in attractor space, roughly [-2, 2])
let spd;            // cached speed (length of velocity) per particle, for color

// ---- Camera / interaction state -------------------------------------------
let camZoom = 520;          // distance feel; smaller = closer (used as scale)
let autoAngle = 0;          // accumulated idle auto-rotation
let lastInteractMs = 0;     // timestamp of last user camera interaction
let energy = 0;             // transient "press" energy that scatters particles

// ---------------------------------------------------------------------------
// Aizawa velocity field. Writes [dx,dy,dz] into out. Pure, allocation-free.
// ---------------------------------------------------------------------------
function aizawa(x, y, z, out) {
  const a = liveA, b = liveB, c = AZ.c, d = AZ.d, e = AZ.e, f = AZ.f;
  const zb = z - b;
  out[0] = zb * x - d * y;
  out[1] = d * x + zb * y;
  out[2] = c + a * z - (z * z * z) / 3.0 - (x * x + y * y) * (1.0 + e * z) + f * z * x * x * x;
}

// Scratch vectors reused by the RK4 integrator (no GC churn).
const k1 = [0, 0, 0], k2 = [0, 0, 0], k3 = [0, 0, 0], k4 = [0, 0, 0];

// ---------------------------------------------------------------------------
// Seed one particle near the attractor core with a little jitter.
// ---------------------------------------------------------------------------
function seedParticle(i) {
  // Small cloud near the origin where the Aizawa attractor lives.
  px[i] = (Math.random() - 0.5) * 1.6;
  py[i] = (Math.random() - 0.5) * 1.6;
  pz[i] = (Math.random() - 0.5) * 0.8 + 0.2;
  spd[i] = 0;
}

function seedAll() {
  for (let i = 0; i < NUM_PARTICLES; i++) seedParticle(i);
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------
function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL);
  pixelDensity(1);

  // Allocate flat buffers once.
  px = new Float32Array(NUM_PARTICLES);
  py = new Float32Array(NUM_PARTICLES);
  pz = new Float32Array(NUM_PARTICLES);
  spd = new Float32Array(NUM_PARTICLES);
  seedAll();

  lastInteractMs = millis();

  if (window.__sketchReady) window.__sketchReady();
}

// ---------------------------------------------------------------------------
// Advance every particle one RK4 step of size h.
// ---------------------------------------------------------------------------
function integrate(h) {
  for (let i = 0; i < NUM_PARTICLES; i++) {
    let x = px[i], y = py[i], z = pz[i];

    aizawa(x, y, z, k1);
    aizawa(x + 0.5 * h * k1[0], y + 0.5 * h * k1[1], z + 0.5 * h * k1[2], k2);
    aizawa(x + 0.5 * h * k2[0], y + 0.5 * h * k2[1], z + 0.5 * h * k2[2], k3);
    aizawa(x + h * k3[0], y + h * k3[1], z + h * k3[2], k4);

    const sixth = h / 6.0;
    const vx = (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
    const vy = (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
    const vz = (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]);

    let nx = x + sixth * vx;
    let ny = y + sixth * vy;
    let nz = z + sixth * vz;

    // Press-to-scatter: push particles radially outward while energy > 0.
    if (energy > 0.0001) {
      const r = Math.sqrt(x * x + y * y + z * z) + 1e-4;
      const e = energy * h;
      nx += (x / r) * e;
      ny += (y / r) * e;
      nz += (z / r) * e;
    }

    // Robustness: recycle particles that diverge or go NaN/Inf.
    const r2 = nx * nx + ny * ny + nz * nz;
    if (!isFinite(r2) || r2 > RESPAWN_RADIUS * RESPAWN_RADIUS) {
      seedParticle(i);
      continue;
    }

    px[i] = nx;
    py[i] = ny;
    pz[i] = nz;

    // Speed = velocity magnitude (RK4 slope). Used for color mapping.
    let sp = Math.sqrt(vx * vx + vy * vy + vz * vz) * 0.16;
    spd[i] = isFinite(sp) ? sp : 0;
  }
}

// ---------------------------------------------------------------------------
// draw
// ---------------------------------------------------------------------------
function draw() {
  // Deep space background — slight blue tint, fully opaque so the cloud
  // rotates cleanly (we clear every frame).
  background(4, 5, 12);

  // --- Live morph from mouse (only when not dragging the camera) ----------
  // Guard against the initial (0,0) mouse position.
  const haveMouse = (mouseX !== 0 || mouseY !== 0);
  if (haveMouse && !mouseIsPressed) {
    const mx = constrain(mouseX / max(width, 1), 0, 1);
    const my = constrain(mouseY / max(height, 1), 0, 1);
    // Gentle, well-behaved ranges around the defaults so it never blows up.
    const targetA = 0.88 + mx * 0.18;   // ~0.88 .. 1.06
    const targetB = 0.55 + my * 0.40;   // ~0.55 .. 0.95
    liveA = lerp(liveA, targetA, 0.05);
    liveB = lerp(liveB, targetB, 0.05);
  } else {
    // Ease back to defaults when interacting elsewhere.
    liveA = lerp(liveA, AZ.a, 0.02);
    liveB = lerp(liveB, AZ.b, 0.02);
  }

  // --- Press energy: ramp up while held, decay when released --------------
  if (mouseIsPressed) energy = lerp(energy, 2.2, 0.15);
  else energy = lerp(energy, 0, 0.08);
  if (energy < 0.0005) energy = 0;

  // --- Integrate the swarm ------------------------------------------------
  const h = DT / SUB_STEPS;
  for (let s = 0; s < SUB_STEPS; s++) integrate(h);

  // --- Camera ------------------------------------------------------------
  // Idle auto-rotation: only when the user hasn't touched the camera lately.
  const idle = (millis() - lastInteractMs) > 1200;
  if (idle) autoAngle += 0.0016;

  // orbitControl drives the camera from drag; we add a slow spin on top.
  orbitControl(1.4, 1.4, 0.05);
  rotateY(autoAngle);
  rotateX(-0.35); // a pleasing default tilt

  // Pull the whole galaxy to a nice viewing distance via uniform scale.
  // Guard the divisor and clamp the resulting scale so it can never be 0/NaN.
  let sc = camZoom / 520;
  if (!isFinite(sc) || sc <= 0) sc = 1;
  scale(WORLD_SCALE * sc);

  // --- Render: additive glowing points -----------------------------------
  // NOTE: in p5 WEBGL, strokeWeight sets the point size in SCREEN PIXELS and is
  // NOT affected by the modelview scale() above. So we pass a direct pixel value
  // (dividing by WORLD_SCALE would make points ~0.01px and effectively invisible).
  blendMode(ADD);
  strokeWeight(POINT_PX);
  noFill();

  beginShape(POINTS);
  for (let i = 0; i < NUM_PARTICLES; i++) {
    // Map speed -> color: slow = deep violet/blue, fast = cyan/white.
    let t = spd[i];
    if (!isFinite(t)) t = 0;
    t = constrain(t, 0, 1);

    // Three-stop gradient (violet -> blue -> cyan/white) in 0..255 space.
    let r, g, b;
    if (t < 0.5) {
      const u = t / 0.5;
      r = lerp(70, 30, u);    // violet -> blue
      g = lerp(20, 110, u);
      b = lerp(150, 230, u);
    } else {
      const u = (t - 0.5) / 0.5;
      r = lerp(30, 210, u);   // blue -> cyan/white
      g = lerp(110, 250, u);
      b = lerp(230, 255, u);
    }
    // Additive blending sums overlapping points into bright cores naturally.
    stroke(r, g, b, 140);
    vertex(px[i], py[i], pz[i]);
  }
  endShape();

  // Always restore normal blending before the next frame's background().
  blendMode(BLEND);
}

// ---------------------------------------------------------------------------
// Interaction handlers
// ---------------------------------------------------------------------------
function mousePressed() {
  lastInteractMs = millis();
  // Click reseeds a fresh swarm (cheap, fun "shuffle").
  seedAll();
  return false;
}

function mouseDragged() {
  // Mark camera interaction so auto-rotation pauses while orbiting.
  lastInteractMs = millis();
  return false;
}

function mouseWheel(event) {
  // Scroll to zoom. Clamp so we never invert or get absurd scales.
  if (event && isFinite(event.delta)) {
    camZoom = constrain(camZoom + event.delta * 0.5, 180, 1400);
    lastInteractMs = millis();
  }
  return false; // prevent page scroll
}

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------
function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  // No size-dependent buffers to rebuild (particles live in attractor space).
}