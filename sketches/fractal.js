// Mandelbulb — a real-time raymarched power-8 Mandelbulb fractal rendered in a
// single fullscreen fragment shader (no ping-pong needed).
//
// INTERACTION
//   - Drag the mouse to ORBIT the camera (horizontal = azimuth, vertical = elevation).
//   - Scroll the mouse wheel to ZOOM (dolly the camera toward / away from the bulb).
//   - Let go and sit still — after a moment the camera resumes a slow auto-orbit.
//   - The fractal "power" breathes subtly over time so the surface is never static.
//
// PERFORMANCE NOTES (tuned for ~60fps at 1440x900 on Apple Silicon / Chrome):
//   - RENDER_SCALE = 0.75 — we raymarch into a 0.75x framebuffer and upscale it to
//     the screen with a cheap blit. pixelDensity(1) + 0.75 internal scale keeps the
//     fragment count manageable on Retina while still looking crisp.
//   - MAX_STEPS = 90 raymarch steps, ITERS = 8 Mandelbulb DE iterations. Both are
//     compile-time constants so the GLSL loops stay bounded.
//   - Ambient occlusion is derived from how few steps the ray needed (cheap, no
//     extra marching).

let bulbShader;   // the raymarch shader
let blitShader;   // upscales the low-res render buffer to the full screen
let lowFB;        // low-resolution framebuffer we raymarch into

const MOBILE = !!(window.__isMobile);

const RENDER_SCALE = MOBILE ? 0.5 : 0.75; // internal render resolution multiplier (see notes above)

// ---- Camera orbit state (spherical coords around the origin) ----
let azimuth = 0.6;      // horizontal angle (radians)
let elevation = 0.25;   // vertical angle (radians), clamped away from the poles
let camDist = 3.0;      // distance from origin; mouse wheel changes this
let targetDist = 3.0;   // smoothed toward by camDist for buttery zoom

// Drag tracking. We track the previous mouse position ourselves so a fresh click
// never causes a huge jump from the initial (0,0) mouse coordinate.
let dragging = false;
let lastMX = 0, lastMY = 0;
let lastInteraction = 0; // millis() of the last user input, for idle auto-rotate

// ---------------------------------------------------------------------------
// SHADER SOURCE
// ---------------------------------------------------------------------------

// Shared vertex shader for the fullscreen quad (GLSL ES 1.00 / WebGL1).
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

// The Mandelbulb raymarcher.
const STEPS = MOBILE ? 48 : 90;
const ITERS_N = MOBILE ? 6 : 8;
const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vUv;

uniform vec2  uResolution; // pixel size of the (low-res) render target
uniform float uTime;       // seconds
uniform vec3  uCamPos;     // camera position in world space
uniform vec3  uCamTarget;  // point the camera looks at (origin)
uniform float uPower;      // Mandelbulb power (breathes around 8.0)

// Bounded loop constants so the WebGL1 compiler keeps the loops bounded.
const int   MAX_STEPS = ${STEPS};
const int   ITERS     = ${ITERS_N};
const float MAX_DIST  = 12.0;
const float SURF_EPS  = 0.0006;

// -------- Distance estimator for the power-N Mandelbulb --------
// Returns the estimated distance to the fractal surface in .x and a normalized
// orbit-trap value in .y that we reuse for coloring.
vec2 mandelbulbDE(vec3 pos, float power) {
  vec3 z = pos;
  float dr = 1.0;
  float r  = 0.0;
  float trap = 1e10; // orbit trap: closest the orbit comes to the origin

  for (int i = 0; i < ITERS; i++) {
    r = length(z);
    if (r > 2.0) break;                 // escaped — outside the set
    trap = min(trap, r);

    // Guard r away from zero for every pow()/division/acos (NaN safety:
    // pow(0.0, x) is undefined on some GPUs).
    float rSafe = max(r, 1e-6);

    // Convert to polar coordinates.
    float theta = acos(clamp(z.z / rSafe, -1.0, 1.0));
    float phi   = atan(z.y, z.x);

    // Running derivative for the distance estimate.
    dr = pow(rSafe, power - 1.0) * power * dr + 1.0;

    // Scale & rotate the point by the power.
    float zr = pow(rSafe, power);
    theta *= power;
    phi   *= power;

    z = zr * vec3(
      sin(theta) * cos(phi),
      sin(theta) * sin(phi),
      cos(theta)
    );
    z += pos;
  }

  // Standard analytic distance estimate for an escape-time fractal.
  float dist = 0.5 * log(max(r, 1e-6)) * r / max(dr, 1e-6);
  return vec2(dist, clamp(trap, 0.0, 1.0));
}

// March a ray; return distance travelled (.x), trap value (.y) and a soft
// "iteration ratio" (.z) measuring how hard the ray had to work (cheap AO/glow).
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
  return vec3(-1.0, trap, 1.0); // miss
}

// Surface normal via central differences of the DE (cheap & robust).
vec3 calcNormal(vec3 p) {
  vec2 e = vec2(0.0009, 0.0);
  float dx = mandelbulbDE(p + e.xyy, uPower).x - mandelbulbDE(p - e.xyy, uPower).x;
  float dy = mandelbulbDE(p + e.yxy, uPower).x - mandelbulbDE(p - e.yxy, uPower).x;
  float dz = mandelbulbDE(p + e.yyx, uPower).x - mandelbulbDE(p - e.yyx, uPower).x;
  vec3 n = vec3(dx, dy, dz);
  float l = length(n);
  return l > 1e-6 ? n / l : vec3(0.0, 1.0, 0.0);
}

// Cosine palette (Inigo Quilez style) for a rich, shifting gradient.
vec3 palette(float t) {
  vec3 a = vec3(0.55, 0.45, 0.50);
  vec3 b = vec3(0.45, 0.45, 0.50);
  vec3 c = vec3(1.00, 1.00, 1.00);
  vec3 d = vec3(0.00, 0.15, 0.35);
  return a + b * cos(6.28318 * (c * t + d));
}

void main() {
  // Map the fullscreen UV into [-1,1] with correct aspect ratio.
  vec2 uv = (vUv * 2.0 - 1.0);
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  uv.x *= aspect;

  // Build a look-at camera basis.
  vec3 ro = uCamPos;
  vec3 fwd = normalize(uCamTarget - ro);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), fwd));
  vec3 up = cross(fwd, right);
  vec3 rd = normalize(fwd + uv.x * right + uv.y * up); // ~53deg FOV

  vec3 hit = raymarch(ro, rd);

  // Background: a soft vertical nebula gradient with a faint vignette so misses
  // still look intentional rather than flat black.
  vec3 bg = mix(vec3(0.015, 0.02, 0.05), vec3(0.05, 0.03, 0.09), vUv.y);
  bg += 0.04 * palette(uTime * 0.05 + length(uv) * 0.4);
  vec3 col = bg;

  if (hit.x > 0.0) {
    float t = hit.x;
    float trap = hit.y;
    float iterRatio = hit.z;

    vec3 p = ro + rd * t;
    vec3 n = calcNormal(p);

    // Two lights: a warm key light orbiting with time and a cool fill.
    vec3 keyDir  = normalize(vec3(cos(uTime * 0.3), 0.7, sin(uTime * 0.3)));
    vec3 fillDir = normalize(vec3(-0.5, 0.4, -0.6));
    float key  = max(dot(n, keyDir), 0.0);
    float fill = max(dot(n, fillDir), 0.0);

    // Soft ambient occlusion from how hard the ray worked + distance falloff.
    float ao = 1.0 - iterRatio;
    ao = clamp(ao * ao, 0.0, 1.0);
    float distAO = clamp(1.0 - t / MAX_DIST, 0.0, 1.0);
    ao *= mix(0.55, 1.0, distAO);

    // Base color from the orbit trap + a slowly drifting hue over time.
    vec3 base = palette(trap * 1.6 + uTime * 0.07);

    // Rim/fresnel for a glassy edge glow.
    float fres = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);

    vec3 lit =
        base * (0.18 * ao)                       // ambient
      + base * key * vec3(1.05, 0.85, 0.6) * ao  // warm key
      + base * fill * vec3(0.3, 0.45, 0.7) * ao; // cool fill
    lit += fres * palette(trap * 1.6 + uTime * 0.07 + 0.4) * 0.8; // rim glow

    // Specular highlight from the key light.
    vec3 h = normalize(keyDir - rd);
    float spec = pow(max(dot(n, h), 0.0), 32.0);
    lit += spec * vec3(1.0) * ao * 0.6;

    col = lit;

    // Fade into the background near the far plane for depth.
    col = mix(col, bg, smoothstep(MAX_DIST * 0.7, MAX_DIST, t));
  }

  // Tone map (Reinhard) + gentle gamma + a soft vignette.
  col = col / (col + vec3(1.0));
  col = pow(col, vec3(0.4545));
  float vig = smoothstep(1.4, 0.3, length(uv));
  col *= mix(0.75, 1.0, vig);

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

// A trivial blit shader: copies the low-res render buffer to the full screen.
const BLIT_FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
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
  createCanvas(windowWidth, windowHeight, WEBGL);
  pixelDensity(1);
  noStroke();

  bulbShader = createShader(VERT, FRAG);
  blitShader = createShader(VERT, BLIT_FRAG);

  lowFB = createFramebuffer({
    width:  Math.max(1, Math.floor(width * RENDER_SCALE)),
    height: Math.max(1, Math.floor(height * RENDER_SCALE)),
    density: 1,
    textureFiltering: LINEAR, // smooth upscale to the screen
  });

  // Seed the mouse trackers so the very first drag doesn't jump from (0,0).
  lastMX = width / 2;
  lastMY = height / 2;
  lastInteraction = -99999; // start in idle auto-orbit immediately

  if (window.__sketchReady) window.__sketchReady();
}

function draw() {
  const tSec = millis() * 0.001;

  // --- Idle auto-rotation: if the user hasn't touched anything for a moment,
  //     gently orbit the camera so the piece is alive on its own. ---
  const idle = millis() - lastInteraction > 1600;
  if (idle && !dragging) {
    azimuth += 0.0025;
  }

  // Smooth the zoom toward its target for a fluid dolly.
  targetDist = constrain(targetDist, 1.45, 6.0);
  camDist += (targetDist - camDist) * 0.12;
  if (!isFinite(camDist)) camDist = 3.0; // NaN guard

  // Keep elevation away from the exact poles to avoid a degenerate "up" vector.
  elevation = constrain(elevation, -1.4, 1.4);

  // Spherical -> Cartesian camera position around the origin.
  const ce = Math.cos(elevation);
  const camPos = [
    camDist * ce * Math.cos(azimuth),
    camDist * Math.sin(elevation),
    camDist * ce * Math.sin(azimuth),
  ];

  // The fractal power breathes subtly for a living surface (around 8.0).
  const power = 8.0 + Math.sin(tSec * 0.35) * 0.45;

  // --- Pass 1: raymarch into the low-res framebuffer. ---
  lowFB.begin();
  clear();
  shader(bulbShader);
  bulbShader.setUniform('uResolution', [lowFB.width, lowFB.height]);
  bulbShader.setUniform('uTime', tSec);
  bulbShader.setUniform('uCamPos', camPos);
  bulbShader.setUniform('uCamTarget', [0, 0, 0]);
  bulbShader.setUniform('uPower', power);
  noStroke();
  rectMode(CENTER);
  rect(0, 0, lowFB.width, lowFB.height);
  lowFB.end();

  // --- Pass 2: blit the low-res buffer up to the full screen. ---
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
  // Only start an orbit drag when the press is on the canvas (ignore UI chrome).
  if (mouseX < 0 || mouseY < 0 || mouseX > width || mouseY > height) return;
  dragging = true;
  lastMX = mouseX;
  lastMY = mouseY;
  lastInteraction = millis();
}

function mouseReleased() {
  dragging = false;
  lastInteraction = millis();
}

function mouseDragged() {
  if (!dragging) return;
  const dx = mouseX - lastMX;
  const dy = mouseY - lastMY;
  lastMX = mouseX;
  lastMY = mouseY;

  // Drag right -> orbit right; drag up -> look from higher.
  azimuth   += dx * 0.006;
  elevation += dy * 0.006;
  lastInteraction = millis();
}

function mouseWheel(event) {
  // Positive deltaY = scroll down = zoom out; clamp to keep the bulb in view.
  const d = event && isFinite(event.delta) ? event.delta : 0;
  targetDist *= 1.0 + d * 0.0012;
  targetDist = constrain(targetDist, 1.45, 6.0);
  lastInteraction = millis();
  return false; // prevent the page from scrolling
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  // Recreate the size-dependent render buffer at the new resolution.
  const w = Math.max(1, Math.floor(width * RENDER_SCALE));
  const h = Math.max(1, Math.floor(height * RENDER_SCALE));
  if (lowFB) lowFB.resize(w, h);
}