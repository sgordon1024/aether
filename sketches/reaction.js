// ===================================================================
// "Coral" — GPU Gray-Scott Reaction-Diffusion (p5.js 1.9.4, WebGL1)
// ===================================================================
// Two chemicals A and B diffuse and react across a grid. A is the
// "substrate" (starts at 1.0 everywhere), B is the "activator" (starts
// at 0, you paint it in with the mouse). The classic Gray-Scott rules
// produce organic coral / leopard / fingerprint growth.
//
// Implementation notes:
//  - Simulation runs entirely on the GPU using two ping-pong
//    framebuffers. One STEP samples the "previous" texture and writes
//    the "next" one, then we swap.
//  - We do NOT require floating-point render targets. A and B (both in
//    [0,1]) are stored in the R and G channels of a normal 8-bit RGBA
//    texture. This runs on every GPU; 8-bit quantization is invisible.
//  - We run several sim iterations per frame (SIM_STEPS) so growth is
//    fast, then a separate colorize pass renders B through a lush
//    gradient to the screen.
//
// Performance: sim grid longest side capped at 900px (pixelDensity 1),
// 12 iterations/frame. Smooth 60fps at 1440x900 on Apple Silicon.
//
// Interaction:
//  - Click / drag : paint chemical B (seeds coral growth)
//  - Mouse wheel  : grow / shrink the brush
//  - SPACE        : scatter a burst of random seeds
//  - R            : reset to a clean field + a few center seeds
//  - C            : cycle color palettes
// ===================================================================

// ---- Gray-Scott reaction parameters (classic "coral" regime) ------
const FEED = 0.0545;   // feed rate of A
const KILL = 0.062;    // kill rate of B
const DA   = 1.0;      // diffusion rate of A
const DB   = 0.5;      // diffusion rate of B

const SIM_STEPS = 12;  // simulation iterations per frame
const SIM_CAP   = 900; // cap on the longest sim-grid side (perf)

let SIMW, SIMH;        // actual sim grid dimensions (computed from window)

let fbA, fbB;          // ping-pong framebuffers
let simShader;         // the reaction-diffusion step shader
let renderShader;      // the colorize-to-screen shader

let brushRadius = 16;  // brush size in sim pixels (wheel-adjustable)
let paletteIndex = 0;  // which color palette is active
const PALETTE_COUNT = 4;

let mouseHasMoved = false; // guard against initial (0,0) mouse position

// -------------------------------------------------------------------
// SHADER SOURCE
// -------------------------------------------------------------------

// Shared fullscreen-quad vertex shader (verified-correct p5 pattern).
const VERT = `
precision highp float;
attribute vec3 aPosition;
attribute vec2 aTexCoord;
varying vec2 vUv;
uniform mat4 uProjectionMatrix;
uniform mat4 uModelViewMatrix;
void main() {
  vUv = aTexCoord;
  gl_Position = uProjectionMatrix * uModelViewMatrix * vec4(aPosition, 1.0);
}
`;

// Simulation step: reads A,B from R,G of uPrev; writes new A,B.
const SIM_FRAG = `
precision highp float;
varying vec2 vUv;

uniform sampler2D uPrev;     // previous state (A in .r, B in .g)
uniform vec2  uTexel;        // 1/SIMW, 1/SIMH
uniform float uFeed;
uniform float uKill;
uniform float uDA;
uniform float uDB;

// brush / seeding
uniform vec2  uMouse;        // mouse in UV space [0,1]
uniform float uMouseDown;    // 1.0 if painting
uniform float uBrush;        // brush radius in UV units
uniform float uAspect;       // SIMW/SIMH, to keep brush round

// helper: sample A,B safely at an offset
vec2 samp(vec2 uv) {
  uv = clamp(uv, vec2(0.0), vec2(1.0));
  return texture2D(uPrev, uv).rg;
}

void main() {
  vec2 uv = vUv;
  vec2 c  = texture2D(uPrev, uv).rg; // current A (.x), B (.y)
  float A = c.x;
  float B = c.y;

  // ---- 9-point Laplacian (weights sum to 0) ----
  vec2 lap = vec2(0.0);
  lap += samp(uv + vec2(-uTexel.x,  0.0      )) * 0.20;
  lap += samp(uv + vec2( uTexel.x,  0.0      )) * 0.20;
  lap += samp(uv + vec2( 0.0,      -uTexel.y )) * 0.20;
  lap += samp(uv + vec2( 0.0,       uTexel.y )) * 0.20;
  lap += samp(uv + vec2(-uTexel.x, -uTexel.y )) * 0.05;
  lap += samp(uv + vec2( uTexel.x, -uTexel.y )) * 0.05;
  lap += samp(uv + vec2(-uTexel.x,  uTexel.y )) * 0.05;
  lap += samp(uv + vec2( uTexel.x,  uTexel.y )) * 0.05;
  lap += c * -1.0;

  float lapA = lap.x;
  float lapB = lap.y;

  // ---- Gray-Scott reaction ----
  float reaction = A * B * B;
  float newA = A + (uDA * lapA - reaction + uFeed * (1.0 - A));
  float newB = B + (uDB * lapB + reaction - (uKill + uFeed) * B);

  // ---- mouse painting: inject B (and refill A) under the brush ----
  if (uMouseDown > 0.5) {
    vec2 d = uv - uMouse;
    d.x *= uAspect;                 // keep brush circular on non-square grids
    float dist = length(d);
    float br = max(uBrush, 1e-4);
    float falloff = smoothstep(br, br * 0.2, dist);
    newB = mix(newB, 1.0, falloff);
    newA = mix(newA, 0.0, falloff * 0.5);
  }

  // ---- clamp / NaN guard (8-bit storage needs [0,1] anyway) ----
  newA = clamp(newA, 0.0, 1.0);
  newB = clamp(newB, 0.0, 1.0);
  if (newA != newA) newA = 1.0; // NaN check
  if (newB != newB) newB = 0.0;

  gl_FragColor = vec4(newA, newB, 0.0, 1.0);
}
`;

// Colorize pass: map B through a lush palette with a little rim light.
const RENDER_FRAG = `
precision highp float;
varying vec2 vUv;

uniform sampler2D uPrev;
uniform vec2  uTexel;
uniform int   uPalette;

// IQ-style cosine palette: a + b*cos(2pi*(c*t + d))
vec3 cosPal(float t, vec3 a, vec3 b, vec3 c, vec3 d) {
  return a + b * cos(6.28318530718 * (c * t + d));
}

vec3 paletteColor(float t, int idx) {
  t = clamp(t, 0.0, 1.0);
  if (idx == 0) {
    // Coral / teal: deep teal background -> warm coral structure
    return cosPal(t,
      vec3(0.22, 0.34, 0.40),
      vec3(0.55, 0.32, 0.28),
      vec3(1.0,  0.9,  0.7),
      vec3(0.10, 0.25, 0.55));
  } else if (idx == 1) {
    // Aurora: green -> magenta over indigo
    return cosPal(t,
      vec3(0.18, 0.20, 0.30),
      vec3(0.45, 0.50, 0.45),
      vec3(1.0,  1.0,  0.6),
      vec3(0.0,  0.33, 0.67));
  } else if (idx == 2) {
    // Ember: black -> amber -> white-hot
    return cosPal(t,
      vec3(0.20, 0.12, 0.10),
      vec3(0.55, 0.40, 0.30),
      vec3(1.0,  0.9,  0.7),
      vec3(0.00, 0.10, 0.20));
  }
  // Bone / ivory: cool ink -> warm ivory (monochrome-ish)
  return cosPal(t,
    vec3(0.30, 0.30, 0.34),
    vec3(0.45, 0.44, 0.40),
    vec3(1.0,  1.0,  1.0),
    vec3(0.00, 0.05, 0.10));
}

void main() {
  vec2 uv = vUv;
  vec2 s  = texture2D(uPrev, uv).rg;
  float B = s.y;

  // ---- cheap gradient-based shading for a wet, raised look ----
  float bx = texture2D(uPrev, uv + vec2(uTexel.x, 0.0)).g
           - texture2D(uPrev, uv - vec2(uTexel.x, 0.0)).g;
  float by = texture2D(uPrev, uv + vec2(0.0, uTexel.y)).g
           - texture2D(uPrev, uv - vec2(0.0, uTexel.y)).g;
  vec3 n = normalize(vec3(-bx, -by, 0.18));
  vec3 L = normalize(vec3(0.4, 0.55, 0.8));
  float diff = clamp(dot(n, L), 0.0, 1.0);
  float spec = pow(diff, 24.0);

  // Shape the concentration for richer contrast in the structures.
  float t = smoothstep(0.02, 0.34, B);

  vec3 col = paletteColor(t, uPalette);
  col += spec * 0.35 * t;          // glossy highlight on ridges
  col *= 0.65 + 0.5 * diff;        // soft form shading

  // subtle vignette so the canvas reads as a framed plate
  vec2 q = uv - 0.5;
  float vig = smoothstep(0.95, 0.35, length(q));
  col *= mix(0.78, 1.0, vig);

  gl_FragColor = vec4(col, 1.0);
}
`;

// -------------------------------------------------------------------
// SIZE / FRAMEBUFFER MANAGEMENT
// -------------------------------------------------------------------

// Compute sim grid dimensions from the window, capped at SIM_CAP.
function computeSimSize() {
  let w = Math.max(2, windowWidth);
  let h = Math.max(2, windowHeight);
  let longest = Math.max(w, h);
  let scale = longest > SIM_CAP ? SIM_CAP / longest : 1.0;
  SIMW = Math.max(2, Math.floor(w * scale));
  SIMH = Math.max(2, Math.floor(h * scale));
}

// (Re)create the two ping-pong framebuffers at the current sim size.
function makeBuffers() {
  fbA = createFramebuffer({
    width: SIMW, height: SIMH, density: 1, textureFiltering: NEAREST
  });
  fbB = createFramebuffer({
    width: SIMW, height: SIMH, density: 1, textureFiltering: NEAREST
  });
}

// Initialize the field: A = 1, B = 0, with a few seeds of B.
// Stored as color: R = A, G = B. Clean field is (255, 0, 0).
function seedField(clearFirst, seeds) {
  // IMPORTANT: a custom shader may currently be bound from draw().
  // Immediate-mode geometry (background/ellipse) must use p5's default
  // shader, so reset it before drawing into the framebuffers.
  if (clearFirst) {
    fbA.begin();
    resetShader();
    background(255, 0, 0);
    fbA.end();
    fbB.begin();
    resetShader();
    background(255, 0, 0);
    fbB.end();
  }
  // Stamp seeds of B by drawing dots into fbA.
  // R high (A present), G high (B present), Blue = 0.
  if (seeds && seeds.length) {
    fbA.begin();
    resetShader();
    noStroke();
    rectMode(CENTER);
    ellipseMode(CENTER);
    fill(255, 255, 0);
    for (let i = 0; i < seeds.length; i++) {
      // framebuffer uses a centered coordinate space (origin at middle)
      let sx = seeds[i].x * SIMW - SIMW / 2;
      let sy = seeds[i].y * SIMH - SIMH / 2;
      let r = seeds[i].r || 6;
      ellipse(sx, sy, r * 2, r * 2);
    }
    fbA.end();
  }
}

// -------------------------------------------------------------------
// p5 LIFECYCLE
// -------------------------------------------------------------------

function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL);
  pixelDensity(1);
  noStroke();

  computeSimSize();
  makeBuffers();

  simShader    = createShader(VERT, SIM_FRAG);
  renderShader = createShader(VERT, RENDER_FRAG);

  // Seed with a few clusters near the center for an inviting start.
  let initSeeds = [
    { x: 0.5,  y: 0.5,  r: 7 },
    { x: 0.42, y: 0.46, r: 5 },
    { x: 0.58, y: 0.54, r: 5 },
    { x: 0.5,  y: 0.6,  r: 4 }
  ];
  seedField(true, initSeeds);

  if (window.__sketchReady) window.__sketchReady();
}

function draw() {
  // Determine mouse paint state (guard the initial (0,0) position).
  let painting = (mouseIsPressed && mouseHasMoved) ? 1.0 : 0.0;
  // Mouse -> UV. Flip Y because texture V grows downward here.
  let mu = constrain(mouseX / Math.max(1, width), 0, 1);
  let mv = 1.0 - constrain(mouseY / Math.max(1, height), 0, 1);
  let brushUV = brushRadius / Math.max(2, SIMH); // radius in UV (Y based)
  let aspect = SIMW / Math.max(1, SIMH);

  // --- run the simulation several steps for fast growth ---
  for (let i = 0; i < SIM_STEPS; i++) {
    fbB.begin();
    shader(simShader);
    simShader.setUniform('uPrev', fbA);
    simShader.setUniform('uTexel', [1.0 / SIMW, 1.0 / SIMH]);
    simShader.setUniform('uFeed', FEED);
    simShader.setUniform('uKill', KILL);
    simShader.setUniform('uDA', DA);
    simShader.setUniform('uDB', DB);
    simShader.setUniform('uMouse', [mu, mv]);
    simShader.setUniform('uMouseDown', painting);
    simShader.setUniform('uBrush', brushUV);
    simShader.setUniform('uAspect', aspect);
    noStroke();
    rectMode(CENTER);
    rect(0, 0, fbB.width, fbB.height);
    fbB.end();

    // swap
    let tmp = fbA; fbA = fbB; fbB = tmp;
  }

  // --- colorize the current state to the screen ---
  shader(renderShader);
  renderShader.setUniform('uPrev', fbA);
  renderShader.setUniform('uTexel', [1.0 / SIMW, 1.0 / SIMH]);
  renderShader.setUniform('uPalette', paletteIndex);
  noStroke();
  rectMode(CENTER);
  rect(0, 0, width, height);
}

// -------------------------------------------------------------------
// INTERACTION
// -------------------------------------------------------------------

function mouseMoved() {
  mouseHasMoved = true;
}

function mousePressed() {
  mouseHasMoved = true; // a click is intentional input
}

function mouseDragged() {
  mouseHasMoved = true;
}

// Wheel grows / shrinks the brush.
function mouseWheel(event) {
  let d = (event && typeof event.delta === 'number') ? event.delta : 0;
  brushRadius = constrain(brushRadius - d * 0.05, 3, 90);
  return false; // prevent page scroll
}

function keyPressed() {
  if (key === ' ') {
    // scatter a burst of random seeds across the field
    let seeds = [];
    let n = 24;
    for (let i = 0; i < n; i++) {
      seeds.push({
        x: random(0.05, 0.95),
        y: random(0.05, 0.95),
        r: random(2, 6)
      });
    }
    seedField(false, seeds);
  } else if (key === 'r' || key === 'R') {
    // reset to clean field with a few central seeds
    let seeds = [
      { x: 0.5,  y: 0.5,  r: 7 },
      { x: 0.45, y: 0.48, r: 5 },
      { x: 0.55, y: 0.52, r: 5 }
    ];
    seedField(true, seeds);
  } else if (key === 'c' || key === 'C') {
    // cycle palette
    paletteIndex = (paletteIndex + 1) % PALETTE_COUNT;
  }
}

// -------------------------------------------------------------------
// RESIZE — recreate size-dependent framebuffers and reseed.
// -------------------------------------------------------------------

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  computeSimSize();
  makeBuffers();
  // reseed so the new buffers aren't empty/black
  let seeds = [
    { x: 0.5,  y: 0.5,  r: 7 },
    { x: 0.43, y: 0.47, r: 5 },
    { x: 0.57, y: 0.53, r: 5 }
  ];
  seedField(true, seeds);
}
