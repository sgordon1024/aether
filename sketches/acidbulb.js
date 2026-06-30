// Acidbulb — the Mandelbulb, on acid. A psychedelic remix of the raymarched
// power-N Mandelbulb: every-color-imaginable technicolor shading, a shape that
// morphs HARD (the fractal "power" swings from 3 → 11 instead of breathing ±0.5,
// plus an animated offset that makes the surface writhe), and a HOVER boost —
// move your cursor over it and the whole animation rips into hyperspeed.
//
// INTERACTION
//   - HOVER the cursor over the canvas → the animation accelerates (~6x). Leave
//     and it eases back to normal speed.
//   - Drag to ORBIT the camera. Scroll to ZOOM. Idle → slow auto-orbit (which
//     also speeds up while hovering).
//
// PERFORMANCE: same budget as the original Mandelbulb — RENDER_SCALE 0.75,
// MAX_STEPS 90, ITERS 8, raymarched into a low-res framebuffer then blitted up.

let bulbShader;
let blitShader;
let lowFB;

const RENDER_SCALE = 0.75;

// ---- Camera orbit state ----
let azimuth = 0.6;
let elevation = 0.25;
let camDist = 3.0;
let targetDist = 3.0;

let dragging = false;
let lastMX = 0, lastMY = 0;
let lastInteraction = 0;

// ---- Hover-driven speed boost ----
let hovering = false;
let speedMult = 0.25;           // smoothed current speed multiplier
const BASE_SPEED = 0.25;        // resting speed — slow, meditative
const HOVER_SPEED = 1.5;        // hover boost (still clearly faster, far gentler than before)
let animPhase = 0;              // accumulated animation time (scaled by speedMult)

// ---- Morph parameters (this is what makes it transform so much more) ----
const POWER_MID = 7.0;
const POWER_AMP = 4.0;          // power swings POWER_MID ± POWER_AMP  →  3 .. 11
const POWER_FREQ = 0.55;
const MORPH_AMP = 0.2;          // animated offset added inside the DE

// ---------------------------------------------------------------------------
// SHADER SOURCE
// ---------------------------------------------------------------------------

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

const FRAG = `
precision highp float;
varying vec2 vUv;

uniform vec2  uResolution;
uniform float uTime;       // animation phase (accelerates on hover)
uniform vec3  uCamPos;
uniform vec3  uCamTarget;
uniform float uPower;      // Mandelbulb power (swings wildly: 3 .. 11)
uniform vec3  uMorph;      // animated offset added inside the iteration

const int   MAX_STEPS = 90;
const int   ITERS     = 8;
const float MAX_DIST  = 12.0;
const float SURF_EPS  = 0.0006;

// HSV -> RGB so we can sweep the full spectrum cheaply.
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(0.0, 0.6666667, 0.3333333)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

// Distance estimator for the power-N Mandelbulb, with an animated offset (uMorph)
// folded into the constant so the surface writhes over time.
vec2 mandelbulbDE(vec3 pos, float power) {
  vec3 c = pos + uMorph;          // morphed constant → Julia-ish wobble
  vec3 z = pos;
  float dr = 1.0;
  float r  = 0.0;
  float trap = 1e10;

  for (int i = 0; i < ITERS; i++) {
    r = length(z);
    if (r > 2.0) break;
    trap = min(trap, r);

    float rSafe = max(r, 1e-6);
    float theta = acos(clamp(z.z / rSafe, -1.0, 1.0));
    float phi   = atan(z.y, z.x);

    dr = pow(rSafe, power - 1.0) * power * dr + 1.0;

    float zr = pow(rSafe, power);
    theta *= power;
    phi   *= power;

    z = zr * vec3(
      sin(theta) * cos(phi),
      sin(theta) * sin(phi),
      cos(theta)
    );
    z += c;
  }

  float dist = 0.5 * log(max(r, 1e-6)) * r / max(dr, 1e-6);
  return vec2(dist, clamp(trap, 0.0, 1.0));
}

vec3 raymarch(vec3 ro, vec3 rd) {
  float t = 0.0;
  float trap = 1.0;
  float iterRatio = 1.0;
  for (int i = 0; i < MAX_STEPS; i++) {
    vec3 p = ro + rd * t;
    vec2 de = mandelbulbDE(p, uPower);
    trap = de.y;
    if (de.x < SURF_EPS) {
      iterRatio = float(i) / float(MAX_STEPS);
      return vec3(t, trap, iterRatio);
    }
    t += de.x;
    if (t > MAX_DIST) break;
  }
  return vec3(-1.0, trap, 1.0);
}

vec3 calcNormal(vec3 p) {
  vec2 e = vec2(0.0009, 0.0);
  float dx = mandelbulbDE(p + e.xyy, uPower).x - mandelbulbDE(p - e.xyy, uPower).x;
  float dy = mandelbulbDE(p + e.yxy, uPower).x - mandelbulbDE(p - e.yxy, uPower).x;
  float dz = mandelbulbDE(p + e.yyx, uPower).x - mandelbulbDE(p - e.yyx, uPower).x;
  vec3 n = vec3(dx, dy, dz);
  float l = length(n);
  return l > 1e-6 ? n / l : vec3(0.0, 1.0, 0.0);
}

void main() {
  vec2 uv = (vUv * 2.0 - 1.0);
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  uv.x *= aspect;

  vec3 ro = uCamPos;
  vec3 fwd = normalize(uCamTarget - ro);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), fwd));
  vec3 up = cross(fwd, right);
  vec3 rd = normalize(fwd + uv.x * right + uv.y * up);

  vec3 hit = raymarch(ro, rd);

  // Rainbow nebula background so even the misses are technicolor.
  vec3 bg = hsv2rgb(vec3(fract(uTime * 0.04 + vUv.y * 0.35 + vUv.x * 0.15), 0.6, 0.13));
  bg += 0.05 * hsv2rgb(vec3(fract(uTime * 0.07 + length(uv) * 0.2), 0.85, 1.0));
  vec3 col = bg;

  if (hit.x > 0.0) {
    float t = hit.x;
    float trap = hit.y;
    float iterRatio = hit.z;

    vec3 p = ro + rd * t;
    vec3 n = calcNormal(p);

    vec3 keyDir  = normalize(vec3(cos(uTime * 0.6), 0.7, sin(uTime * 0.6)));
    vec3 fillDir = normalize(vec3(-0.5, 0.4, -0.6));
    float key  = max(dot(n, keyDir), 0.0);
    float fill = max(dot(n, fillDir), 0.0);

    float ao = 1.0 - iterRatio;
    ao = clamp(ao * ao, 0.0, 1.0);
    float distAO = clamp(1.0 - t / MAX_DIST, 0.0, 1.0);
    ao *= mix(0.55, 1.0, distAO);

    // TECHNICOLOR: hue swept by orbit trap + position + normal + time so every
    // part of the surface is a different, shifting color.
    float hue = fract(trap * 3.0 + uTime * 0.25 + iterRatio * 1.6
                      + p.y * 0.22 + p.x * 0.12 + n.z * 0.10);
    vec3 base = hsv2rgb(vec3(hue, 0.95, 1.0));

    float fres = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
    vec3 rimCol = hsv2rgb(vec3(fract(hue + 0.5), 0.9, 1.0)); // complementary rim

    vec3 lit =
        base * (0.22 * ao)
      + base * key * ao * 1.15
      + base * fill * ao * 0.5;
    lit += fres * rimCol * 1.1;

    vec3 h = normalize(keyDir - rd);
    float spec = pow(max(dot(n, h), 0.0), 28.0);
    lit += spec * hsv2rgb(vec3(fract(hue + 0.25), 0.7, 1.0)) * ao * 0.8;

    col = lit;
    col = mix(col, bg, smoothstep(MAX_DIST * 0.7, MAX_DIST, t));
  }

  // Gentle tone map (keeps colors punchy) + gamma.
  col = col / (col + vec3(0.7));
  col = pow(col, vec3(0.4545));

  // Saturation boost for that full-tilt technicolor look.
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = clamp(mix(vec3(lum), col, 1.5), 0.0, 1.0);

  float vig = smoothstep(1.5, 0.3, length(uv));
  col *= mix(0.7, 1.0, vig);

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

const BLIT_FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
void main() {
  gl_FragColor = texture2D(uTex, vUv);
}
`;

// ---------------------------------------------------------------------------
// p5 LIFECYCLE
// ---------------------------------------------------------------------------

function setup() {
  const cnv = createCanvas(windowWidth, windowHeight, WEBGL);
  pixelDensity(1);
  noStroke();

  // Hover detection: ramp the speed up when the pointer is over the canvas.
  cnv.mouseOver(function () { hovering = true; });
  cnv.mouseOut(function () { hovering = false; });

  bulbShader = createShader(VERT, FRAG);
  blitShader = createShader(VERT, BLIT_FRAG);

  lowFB = createFramebuffer({
    width:  Math.max(1, Math.floor(width * RENDER_SCALE)),
    height: Math.max(1, Math.floor(height * RENDER_SCALE)),
    density: 1,
    textureFiltering: LINEAR,
  });

  lastMX = width / 2;
  lastMY = height / 2;
  lastInteraction = -99999;

  if (window.__sketchReady) window.__sketchReady();
}

function draw() {
  // Frame-rate-independent animation time, accelerated while hovering.
  let dt = (isFinite(deltaTime) && deltaTime > 0) ? deltaTime * 0.001 : 0.016;
  dt = Math.min(dt, 0.05); // clamp after tab-switches so it never lurches
  const target = hovering ? HOVER_SPEED : BASE_SPEED;
  speedMult += (target - speedMult) * 0.08;
  animPhase += dt * speedMult;

  // Idle auto-orbit (also faster while hovering).
  const idle = millis() - lastInteraction > 1600;
  if (idle && !dragging) {
    azimuth += 0.0025 * speedMult;
  }

  targetDist = constrain(targetDist, 1.45, 6.0);
  camDist += (targetDist - camDist) * 0.12;
  if (!isFinite(camDist)) camDist = 3.0;

  elevation = constrain(elevation, -1.4, 1.4);

  const ce = Math.cos(elevation);
  const camPos = [
    camDist * ce * Math.cos(azimuth),
    camDist * Math.sin(elevation),
    camDist * ce * Math.sin(azimuth),
  ];

  // Big, fast power swing → dramatic morphing (3 .. 11).
  const power = POWER_MID + POWER_AMP * Math.sin(animPhase * POWER_FREQ);
  // Animated offset folded into the DE for extra writhing.
  const morph = [
    Math.sin(animPhase * 0.7) * MORPH_AMP,
    Math.sin(animPhase * 0.53 + 1.7) * MORPH_AMP,
    Math.cos(animPhase * 0.9) * MORPH_AMP,
  ];

  // --- Pass 1: raymarch into the low-res framebuffer. ---
  lowFB.begin();
  clear();
  shader(bulbShader);
  bulbShader.setUniform('uResolution', [lowFB.width, lowFB.height]);
  bulbShader.setUniform('uTime', animPhase);
  bulbShader.setUniform('uCamPos', camPos);
  bulbShader.setUniform('uCamTarget', [0, 0, 0]);
  bulbShader.setUniform('uPower', power);
  bulbShader.setUniform('uMorph', morph);
  noStroke();
  rectMode(CENTER);
  rect(0, 0, lowFB.width, lowFB.height);
  lowFB.end();

  // --- Pass 2: blit up to the full screen. ---
  shader(blitShader);
  blitShader.setUniform('uTex', lowFB);
  noStroke();
  rectMode(CENTER);
  rect(0, 0, width, height);
}

// ---------------------------------------------------------------------------
// INTERACTION
// ---------------------------------------------------------------------------

function mousePressed() {
  if (mouseX < 0 || mouseY < 0 || mouseX > width || mouseY > height) return;
  dragging = true;
  hovering = true;
  lastMX = mouseX;
  lastMY = mouseY;
  lastInteraction = millis();
}

function mouseReleased() {
  dragging = false;
  lastInteraction = millis();
}

function mouseMoved() {
  // Being able to move the mouse means it's over the canvas.
  if (mouseX >= 0 && mouseY >= 0 && mouseX <= width && mouseY <= height) hovering = true;
}

function mouseDragged() {
  if (!dragging) return;
  const dx = mouseX - lastMX;
  const dy = mouseY - lastMY;
  lastMX = mouseX;
  lastMY = mouseY;
  azimuth   += dx * 0.006;
  elevation += dy * 0.006;
  lastInteraction = millis();
}

function mouseWheel(event) {
  const d = event && isFinite(event.delta) ? event.delta : 0;
  targetDist *= 1.0 + d * 0.0012;
  targetDist = constrain(targetDist, 1.45, 6.0);
  lastInteraction = millis();
  return false;
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  const w = Math.max(1, Math.floor(width * RENDER_SCALE));
  const h = Math.max(1, Math.floor(height * RENDER_SCALE));
  if (lowFB) lowFB.resize(w, h);
}
