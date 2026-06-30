// ============================================================================
// "Ink" — GPU fluid dye simulation (semi-Lagrangian advection on ping-pong FBOs)
// ----------------------------------------------------------------------------
// TARGET: p5.js v1.9.4, GLOBAL mode, WebGL1 only (GLSL ES 1.00).
//
// HOW IT WORKS
//   We keep two GPU fields, each on its own pair of ping-pong framebuffers:
//     * velocity  — signed 2D vector, PACKED into RGBA8 as v*0.5+0.5 (RG channels)
//                   so we never need a FLOAT render target (max Mac/Chrome compat).
//     * dye       — RGB color, stored straight in RGBA8.
//   Each frame:
//     1) advect velocity backward along itself (semi-Lagrangian).
//     2) apply curl / vorticity confinement so the fluid keeps swirling on its own.
//     3) inject mouse-drag velocity + a colored gaussian dye splat.
//     4) advect dye by the (new) velocity field and dissipate it slowly.
//   A final render pass upsamples the dye to the screen with a tonemapped,
//   velocity-tinted color map for that glowing swirling-ink look.
//
//   SIM RESOLUTION: 256 x 256 (fixed, square). 1 sim step per frame.
//   This comfortably holds ~60fps at 1440x900 on Apple Silicon.
//
//   VELOCITY ENCODING: signed values packed into [0,1] via v*0.5+0.5 (decode v*2-1).
//   No FLOAT framebuffer is used on purpose — float color targets are not
//   universally supported in WebGL1, so we stay on RGBA8 for reliability.
// ============================================================================

// ---- Mobile detection (boot.js has already run) ----------------------------
const MOBILE = !!(window.__isMobile);

// ---- Simulation grid (fixed, square) --------------------------------------
// On mobile, roughly halve the sim resolution (256->128) to cut the dominant
// per-frame fragment-shader fill cost by ~4x. Desktop stays at 256.
const SIM = MOBILE ? 128 : 256;  // sim resolution (SIM x SIM)
const DT  = 1.0;                 // sim timestep (in grid/texel units)

// ---- Framebuffers (ping-pong) ----------------------------------------------
let velA, velB;                  // velocity field (packed signed in RG)
let dyeA, dyeB;                  // dye field (RGB color)

// ---- Shaders ----------------------------------------------------------------
let advectVelShader;             // advect + decay velocity
let curlShader;                  // vorticity confinement (keeps it swirling)
let splatVelShader;              // inject mouse drag velocity
let advectDyeShader;             // advect + dissipate dye, inject dye splat
let renderShader;                // colorize dye to the screen

// ---- Interaction state ------------------------------------------------------
let haveMouse = false;           // guard against initial (0,0) cursor
let brushRadius = 0.030;         // splat radius in UV units (wheel-adjustable)
let hue = 0.0;                   // injected dye hue, slowly cycles

// ============================================================================
// SHADER SOURCE
// ============================================================================

// Shared fullscreen-quad vertex shader (canonical pattern).
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
}`;

// --- helpers shared by SIM fragment shaders (pack/unpack signed velocity) ---
const FRAG_HELPERS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vUv;
uniform vec2  uTexel;       // 1/SIM in x and y
// decode packed velocity (RG in [0,1]) back to signed vec2
vec2 decodeVel(vec3 c){ return c.xy * 2.0 - 1.0; }
// encode signed velocity into [0,1] for RGBA8 storage
vec3 encodeVel(vec2 v){ return vec3(v * 0.5 + 0.5, 0.0); }
`;

// 1) ADVECT VELOCITY — sample backward along the velocity field, mild decay.
const FRAG_ADVECT_VEL = FRAG_HELPERS + `
uniform sampler2D uVel;
uniform float uDt;
uniform float uDecay;       // velocity damping (<1)
void main() {
  vec2 v = decodeVel(texture2D(uVel, vUv).rgb);
  // clamp velocity for stability (texels/step)
  v = clamp(v, vec2(-1.0), vec2(1.0));
  // backtrace: where did this parcel come from?
  vec2 src = vUv - v * uDt * uTexel;
  vec2 nv = decodeVel(texture2D(uVel, src).rgb);
  nv *= uDecay;
  nv = clamp(nv, vec2(-1.0), vec2(1.0));
  // guard against NaN
  if (nv.x != nv.x) nv.x = 0.0;
  if (nv.y != nv.y) nv.y = 0.0;
  gl_FragColor = vec4(encodeVel(nv), 1.0);
}`;

// 2) CURL / VORTICITY CONFINEMENT — measures curl of the field and pushes the
//    velocity toward swirl, so the fluid keeps moving without input. A slow
//    procedural swirl term is added so a blank canvas still drifts.
const FRAG_CURL = FRAG_HELPERS + `
uniform sampler2D uVel;
uniform float uCurl;        // confinement strength
uniform float uTime;
uniform float uAmbient;     // gentle procedural drift strength

float curlAt(vec2 uv){
  vec2 L = decodeVel(texture2D(uVel, uv - vec2(uTexel.x, 0.0)).rgb);
  vec2 R = decodeVel(texture2D(uVel, uv + vec2(uTexel.x, 0.0)).rgb);
  vec2 B = decodeVel(texture2D(uVel, uv - vec2(0.0, uTexel.y)).rgb);
  vec2 T = decodeVel(texture2D(uVel, uv + vec2(0.0, uTexel.y)).rgb);
  // curl (z component of 2D field) = dVy/dx - dVx/dy
  return (R.y - L.y) - (T.x - B.x);
}

void main() {
  vec2 v = decodeVel(texture2D(uVel, vUv).rgb);

  // --- vorticity confinement ---
  float cC = curlAt(vUv);
  float cL = curlAt(vUv - vec2(uTexel.x, 0.0));
  float cR = curlAt(vUv + vec2(uTexel.x, 0.0));
  float cB = curlAt(vUv - vec2(0.0, uTexel.y));
  float cT = curlAt(vUv + vec2(0.0, uTexel.y));
  // gradient of |curl| -> normal pointing toward higher vorticity
  vec2 grad = vec2(abs(cR) - abs(cL), abs(cT) - abs(cB));
  float glen = max(length(grad), 1e-5);
  vec2 N = grad / glen;
  // force perpendicular to N, scaled by local curl
  vec2 force = uCurl * cC * vec2(N.y, -N.x);

  // --- gentle procedural ambient drift (keeps the ink alive when idle) ---
  float a = uTime * 0.15;
  vec2 p = vUv * 6.2831853;
  vec2 amb = vec2(
    sin(p.y + a) + 0.5 * sin(p.y * 2.0 - a * 1.3),
    cos(p.x - a) + 0.5 * cos(p.x * 2.0 + a * 1.1)
  ) * uAmbient;

  v += (force + amb) * 0.5;
  v = clamp(v, vec2(-1.0), vec2(1.0));
  if (v.x != v.x) v.x = 0.0;
  if (v.y != v.y) v.y = 0.0;
  gl_FragColor = vec4(encodeVel(v), 1.0);
}`;

// 3) SPLAT VELOCITY — add mouse-drag momentum as a gaussian blob.
const FRAG_SPLAT_VEL = FRAG_HELPERS + `
uniform sampler2D uVel;
uniform vec2  uPoint;       // splat center (uv)
uniform vec2  uForce;       // drag velocity to add
uniform float uRadius;      // splat radius (uv)
uniform float uActive;      // 1 when pressing, else 0
uniform float uAspect;      // width/height for round splats

void main() {
  vec2 v = decodeVel(texture2D(uVel, vUv).rgb);
  vec2 d = vUv - uPoint;
  d.x *= uAspect;                                  // keep splats circular
  float r2 = max(uRadius * uRadius, 1e-6);
  float fall = exp(-dot(d, d) / r2);
  v += uForce * fall * uActive;
  v = clamp(v, vec2(-1.0), vec2(1.0));
  gl_FragColor = vec4(encodeVel(v), 1.0);
}`;

// 4) ADVECT DYE — move dye along velocity, dissipate slowly, inject color splat.
const FRAG_ADVECT_DYE = FRAG_HELPERS + `
uniform sampler2D uDye;
uniform sampler2D uVel;
uniform float uDt;
uniform float uDissipate;   // dye fade (<1)
uniform vec2  uPoint;       // dye splat center
uniform vec3  uColor;       // injected color
uniform float uRadius;      // splat radius
uniform float uActive;      // pressing?
uniform float uAspect;

void main() {
  vec2 v = decodeVel(texture2D(uVel, vUv).rgb);
  v = clamp(v, vec2(-1.0), vec2(1.0));
  vec2 src = vUv - v * uDt * uTexel;
  vec4 dye = texture2D(uDye, src);
  dye.rgb *= uDissipate;

  // inject colored gaussian dye splat at cursor
  vec2 d = vUv - uPoint;
  d.x *= uAspect;
  float r2 = max(uRadius * uRadius, 1e-6);
  float fall = exp(-dot(d, d) / r2) * uActive;
  dye.rgb += uColor * fall;
  dye.rgb = clamp(dye.rgb, 0.0, 1.0);

  if (dye.r != dye.r) dye.r = 0.0;
  if (dye.g != dye.g) dye.g = 0.0;
  if (dye.b != dye.b) dye.b = 0.0;
  gl_FragColor = vec4(dye.rgb, 1.0);
}`;

// 5) RENDER — colorize dye to screen, tinted by velocity, with a soft tonemap.
//    Has its own minimal header (does NOT use uTexel) so no uniform is stripped.
const FRAG_RENDER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vUv;
uniform sampler2D uDye;
uniform sampler2D uVel;
uniform vec2  uResolution;  // screen size

vec2 decodeVel(vec3 c){ return c.xy * 2.0 - 1.0; }

void main() {
  // Aspect-fit the square sim into the screen (cover). vUv is 0..1 on screen.
  vec2 uv = vUv;
  float screenAspect = uResolution.x / max(uResolution.y, 1.0);
  // center-scale so the square field covers the wider dimension
  vec2 c = uv - 0.5;
  if (screenAspect > 1.0) c.y /= screenAspect; else c.x *= screenAspect;
  uv = c + 0.5;

  vec3 dye = texture2D(uDye, uv).rgb;
  vec2 vel = decodeVel(texture2D(uVel, uv).rgb);
  float speed = clamp(length(vel) * 1.8, 0.0, 1.0);

  // velocity adds a luminous rim tint to moving ink
  vec3 velTint = vec3(0.15, 0.35, 0.85) * speed * (0.4 + 0.6 * dye.r);

  vec3 col = dye + velTint * (0.2 + 0.8 * length(dye));

  // filmic-ish tonemap for rich saturated ink
  col = col / (col + vec3(0.55));
  col = pow(col, vec3(0.85));

  // deep ink-blue background where there's no dye
  vec3 bg = vec3(0.015, 0.02, 0.04);
  float density = clamp(length(dye) * 1.5, 0.0, 1.0);
  col = mix(bg, col, density);

  // subtle vignette for depth
  vec2 q = vUv - 0.5;
  float vig = smoothstep(0.95, 0.35, length(q));
  col *= mix(0.75, 1.0, vig);

  gl_FragColor = vec4(col, 1.0);
}`;

// ============================================================================
// p5 LIFECYCLE
// ============================================================================

function makeFBOs() {
  // Free any existing framebuffers first (avoids GPU texture leaks on resize).
  if (velA && velA.remove) velA.remove();
  if (velB && velB.remove) velB.remove();
  if (dyeA && dyeA.remove) dyeA.remove();
  if (dyeB && dyeB.remove) dyeB.remove();

  // LINEAR filtering is ideal for fluid dye (smooth advection sampling).
  const opts = { width: SIM, height: SIM, density: 1, textureFiltering: LINEAR };
  velA = createFramebuffer(opts);
  velB = createFramebuffer(opts);
  dyeA = createFramebuffer(opts);
  dyeB = createFramebuffer(opts);

  // Velocity buffers start at packed-zero (grey 127 -> decodes to (0,0)).
  clearFBOToColor(velA, 127, 127, 127);
  clearFBOToColor(velB, 127, 127, 127);
  // Dye buffers start fully black (no ink).
  clearFBOToColor(dyeA, 0, 0, 0);
  clearFBOToColor(dyeB, 0, 0, 0);
}

// Clear a framebuffer to a specific solid color.
function clearFBOToColor(fb, r, g, b) {
  fb.begin();
  clear();
  background(r, g, b, 255);
  fb.end();
}

function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL);
  pixelDensity(1);
  noStroke();
  rectMode(CENTER);

  // Build all shaders.
  advectVelShader = createShader(VERT, FRAG_ADVECT_VEL);
  curlShader      = createShader(VERT, FRAG_CURL);
  splatVelShader  = createShader(VERT, FRAG_SPLAT_VEL);
  advectDyeShader = createShader(VERT, FRAG_ADVECT_DYE);
  renderShader    = createShader(VERT, FRAG_RENDER);

  makeFBOs();

  // LAST line of setup.
  if (window.__sketchReady) window.__sketchReady();
}

// Run one full simulation step into the destination buffers, then swap.
function simStep() {
  const texel = [1.0 / SIM, 1.0 / SIM];
  const aspect = 1.0; // sim grid is square

  // Mouse drag -> velocity force (in screen px, normalized to texels/step).
  // Guard against the initial (0,0) cursor.
  let active = (haveMouse && mouseIsPressed) ? 1.0 : 0.0;
  let pUv = [0.5, 0.5];
  let force = [0.0, 0.0];
  if (haveMouse) {
    pUv = screenToSimUV(mouseX, mouseY);
    let dx = (mouseX - pmouseX);
    let dy = (mouseY - pmouseY);
    // scale drag into velocity units and clamp
    let s = 0.012;
    force = [
      constrain(dx * s, -1.0, 1.0),
      constrain(-dy * s, -1.0, 1.0) // flip Y: screen y down -> sim y up
    ];
  }

  // ---- 1) advect velocity -------------------------------------------------
  velB.begin();
  shader(advectVelShader);
  advectVelShader.setUniform('uVel', velA);
  advectVelShader.setUniform('uTexel', texel);
  advectVelShader.setUniform('uDt', DT);
  advectVelShader.setUniform('uDecay', 0.997);
  drawQuad(velB.width, velB.height);
  velB.end();
  swapVel();

  // ---- 2) curl / vorticity confinement ------------------------------------
  velB.begin();
  shader(curlShader);
  curlShader.setUniform('uVel', velA);
  curlShader.setUniform('uTexel', texel);
  curlShader.setUniform('uCurl', 0.18);
  curlShader.setUniform('uAmbient', 0.0016);
  curlShader.setUniform('uTime', millis() * 0.001);
  drawQuad(velB.width, velB.height);
  velB.end();
  swapVel();

  // ---- 3) inject drag velocity --------------------------------------------
  velB.begin();
  shader(splatVelShader);
  splatVelShader.setUniform('uVel', velA);
  splatVelShader.setUniform('uTexel', texel);
  splatVelShader.setUniform('uPoint', pUv);
  splatVelShader.setUniform('uForce', force);
  splatVelShader.setUniform('uRadius', brushRadius);
  splatVelShader.setUniform('uActive', active);
  splatVelShader.setUniform('uAspect', aspect);
  drawQuad(velB.width, velB.height);
  velB.end();
  swapVel();

  // ---- 4) advect + inject dye ---------------------------------------------
  // cycle the injected hue over time so layered drags differ in color
  hue = (hue + 0.0025) % 1.0;
  const col = hsvToRgb(hue, 0.85, 1.0);

  dyeB.begin();
  shader(advectDyeShader);
  advectDyeShader.setUniform('uDye', dyeA);
  advectDyeShader.setUniform('uVel', velA);
  advectDyeShader.setUniform('uTexel', texel);
  advectDyeShader.setUniform('uDt', DT);
  advectDyeShader.setUniform('uDissipate', 0.991);
  advectDyeShader.setUniform('uPoint', pUv);
  advectDyeShader.setUniform('uColor', col);
  advectDyeShader.setUniform('uRadius', brushRadius * 0.85);
  advectDyeShader.setUniform('uActive', active);
  advectDyeShader.setUniform('uAspect', aspect);
  drawQuad(dyeB.width, dyeB.height);
  dyeB.end();
  swapDye();
}

function draw() {
  // Advance the simulation one step per frame.
  simStep();

  // Render the dye field to the screen.
  shader(renderShader);
  renderShader.setUniform('uDye', dyeA);
  renderShader.setUniform('uVel', velA);
  renderShader.setUniform('uResolution', [width, height]);
  drawQuad(width, height);
}

// ============================================================================
// HELPERS
// ============================================================================

// Draw the canonical fullscreen quad covering (w,h) centered at origin.
function drawQuad(w, h) {
  noStroke();
  rectMode(CENTER);
  rect(0, 0, w, h);
}

// Map screen pixel coords -> sim UV (0..1), inverting the render aspect-fit so
// the splat lands under the cursor. Y is flipped because screen Y goes down.
function screenToSimUV(px, py) {
  let u = px / max(width, 1);
  let v = 1.0 - py / max(height, 1); // flip to sim space (y up)
  // invert the cover aspect-fit done in the render shader
  let screenAspect = width / max(height, 1);
  let cx = u - 0.5;
  let cy = v - 0.5;
  if (screenAspect > 1.0) cy *= screenAspect; else cx /= screenAspect;
  return [cx + 0.5, cy + 0.5];
}

function swapVel() { let t = velA; velA = velB; velB = t; }
function swapDye() { let t = dyeA; dyeA = dyeB; dyeB = t; }

// HSV -> RGB (h,s,v in 0..1) returning [r,g,b] in 0..1.
function hsvToRgb(h, s, v) {
  let i = Math.floor(h * 6.0);
  let f = h * 6.0 - i;
  let p = v * (1.0 - s);
  let q = v * (1.0 - f * s);
  let t = v * (1.0 - (1.0 - f) * s);
  let r, g, b;
  switch (((i % 6) + 6) % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  return [r, g, b];
}

// ============================================================================
// INTERACTION
// ============================================================================

function mousePressed() {
  // Mark the cursor as valid (guards the initial (0,0) position).
  if (mouseX !== 0 || mouseY !== 0) haveMouse = true;
}

function mouseMoved() {
  if (mouseX !== 0 || mouseY !== 0) haveMouse = true;
}

function mouseDragged() {
  if (mouseX !== 0 || mouseY !== 0) haveMouse = true;
}

// Wheel scales the brush radius.
function mouseWheel(e) {
  brushRadius = constrain(brushRadius - e.delta * 0.00004, 0.008, 0.12);
  return false; // prevent page scroll
}

// ============================================================================
// RESIZE — recreate size-dependent framebuffers. (SIM grid stays fixed.)
// ============================================================================
function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  // Framebuffers are sim-resolution (independent of window), but recreating
  // them on resize keeps GL state clean across context changes.
  makeFBOs();
}