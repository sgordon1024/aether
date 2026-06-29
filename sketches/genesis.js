// Genesis — the BIRTH of a star.
// A vast, raymarched stellar nursery: a cloud of interstellar gas in which a
// protostar IGNITES. The matched pair to a black hole (a star's death), this is
// the opposite gesture — light being born out of cold dust.
//
// TECHNIQUE (single-pass volumetric integration, one fullscreen fragment shader):
//   - We march a camera ray through a bounded 3D volume.
//   - At every step we sample DOMAIN-WARPED fbm (3D value noise, 4 octaves) to get
//     local gas DENSITY. The field slowly drifts/curls over uTime so the cloud is
//     never static.
//   - We composite EMISSION + ABSORPTION front-to-back (Beer-Lambert): denser/hotter
//     gas glows and brightness rises sharply toward the protostar CORE at the origin.
//   - Fake SINGLE-SCATTERING for god-rays: each lit step's contribution falls off
//     with distance from the core AND with the optical depth of the gas lying
//     between that step and the core (a short, CHEAP secondary "shadow march"), so
//     you see light shafts carving through the dust like the Pillars of Creation.
//   - A procedural STARFIELD sits behind the cloud.
//
// INTERACTION (all delightful, all guarded against the initial (0,0) mouse):
//   - MOVE the mouse: injects TURBULENCE and PARTS the gas — a moving low-density
//     "bite" in the density field that follows the cursor through the volume.
//   - CLICK: feeds an IGNITION — a white flash plus an expanding spherical shockwave
//     of brightness blooming out from the core.
//   - WHEEL: DOLLIES the camera in/out so you can fly into the cloud.
//   - DRAG: slowly rotates the view around the nursery.
//   - Idle: the camera resumes a slow drift so the piece breathes on its own.
//
// PERFORMANCE (tuned for ~60fps at 1440x900 on Apple Silicon / Chrome):
//   - RENDER_SCALE = 0.6 — we raymarch into an OFFSCREEN WebGL graphics buffer at
//     0.6x and image() it up (image() preserves orientation; p5.Framebuffer caused
//     a vertical-flip bug, so we deliberately avoid it). pixelDensity(1) throughout.
//   - MAX_STEPS = 56 primary volume steps, early-out when accumulated alpha > 0.99.
//   - SHADOW_STEPS = 4 short secondary steps toward the core for the god-ray term,
//     using a CHEAP single-fbm density (no double domain warp) to keep it real-time.
//   - FBM_OCTAVES = 4.

let nurseryShader;        // the volumetric raymarcher
let gfx;                  // offscreen WEBGL buffer we render the shader into

const RENDER_SCALE = 0.6; // internal render resolution multiplier (see notes)

// ---- Camera orbit state (spherical coords around the origin) ----
let yaw = 0.5;            // horizontal angle (radians)
let pitch = 0.05;         // vertical angle (radians), clamped away from the poles
let camDist = 5.2;        // distance from origin; mouse wheel changes this
let targetDist = 5.2;     // smoothed toward by camDist for a buttery dolly

// Smoothed mouse in normalized [-1,1] screen space (drives the turbulence "bite").
let smoothMx = 0;
let smoothMy = 0;

// Drag tracking. We keep our own previous-mouse so a fresh click never jumps from
// the initial (0,0) mouse coordinate.
let dragging = false;
let lastMX = 0, lastMY = 0;
let lastInteraction = 0;  // millis() of last input, for idle drift

// Ignition state: a click records the moment and the shader plays a shockwave that
// expands from the core and fades. We track up to one active ignition at a time
// (a new click restarts it).
let igniteTime = -1e9;    // millis() of the last click; far in the past = no flash

// ---------------------------------------------------------------------------
// SHADER SOURCE
// ---------------------------------------------------------------------------

// Shared fullscreen-quad vertex shader (GLSL ES 1.00 / WebGL1) — verbatim pattern.
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

// The volumetric stellar-nursery raymarcher.
const FRAG = `
precision highp float;
varying vec2 vUv;

uniform vec2  uResolution;  // pixel size of the (low-res) render target
uniform float uTime;        // seconds
uniform vec3  uCamPos;      // camera position in world space
uniform vec2  uMouse;       // smoothed mouse in [-1,1] (screen), parts the gas
uniform float uIgnite;      // 0..1 strength of the active ignition shockwave
uniform float uShockR;      // current radius of the ignition shockwave (world units)
uniform float uFlash;       // 0..1 full-frame ignition flash (decays fast)

// ---- Bounded loop constants (the WebGL1 compiler needs constant bounds) ----
const int   MAX_STEPS    = 56;   // primary volume integration steps
const int   SHADOW_STEPS = 4;    // short secondary march toward core (god-rays)
const int   FBM_OCTAVES  = 4;    // fbm octaves
const float CORE_R       = 0.10; // protostar core radius (world units)
const float VOL_R        = 3.2;  // radius of the spherical gas volume

// ----------------------------------------------------------------------------
// Hashing + 3D value noise + domain-warped fbm
// ----------------------------------------------------------------------------

// Cheap 3D hash -> [0,1].
float hash13(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

// 3D value noise with smooth (quintic) interpolation.
float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0); // quintic fade

  float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));

  float nx00 = mix(n000, n100, u.x);
  float nx10 = mix(n010, n110, u.x);
  float nx01 = mix(n001, n101, u.x);
  float nx11 = mix(n011, n111, u.x);
  float nxy0 = mix(nx00, nx10, u.y);
  float nxy1 = mix(nx01, nx11, u.y);
  return mix(nxy0, nxy1, u.z);
}

// Standard fbm (4 octaves) with a fixed lacunarity/gain.
float fbm(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  for (int i = 0; i < FBM_OCTAVES; i++) {
    sum += amp * vnoise(p * freq);
    freq *= 2.02;
    amp  *= 0.5;
  }
  return sum;
}

// Domain-warped fbm: we sample fbm of a position that has itself been displaced by
// another fbm. This gives the curling, filamentary, "smoke-pulled-into-strands"
// look characteristic of real nebulae. The warp drifts slowly over time.
float warpedFbm(vec3 p) {
  float t = uTime * 0.04;
  // First warp layer.
  vec3 q = vec3(
    fbm(p + vec3(0.0, 1.7, 4.2) + t),
    fbm(p + vec3(5.2, 1.3, 0.8) - t * 0.7),
    fbm(p + vec3(2.1, 8.3, 2.9) + t * 0.5)
  );
  // Second warp layer (warp the warp) for extra structure.
  vec3 r = vec3(
    fbm(p + 2.4 * q + vec3(1.7, 9.2, 8.4)),
    fbm(p + 2.4 * q + vec3(8.3, 2.8, 0.4)),
    fbm(p + 2.4 * q + vec3(4.1, 5.6, 7.1))
  );
  return fbm(p + 3.0 * r);
}

// ----------------------------------------------------------------------------
// Density field of the nursery
// ----------------------------------------------------------------------------
// Returns gas density at world position p (0 outside, soft toward the volume edge).
// The mouse "bite" (mWorld) carves a moving low-density cavity that parts the gas;
// it also injects local turbulence so the cloud swirls around the cursor.
float densityAt(vec3 p, vec3 mWorld) {
  float r = length(p);

  // Spherical containment: density falls to zero at the volume boundary.
  float shell = smoothstep(VOL_R, VOL_R * 0.45, r);

  // Base warped cloud. Scale up the coordinates for finer filaments.
  float n = warpedFbm(p * 0.9);

  // Bias the cloud denser toward the middle (gas collapsing toward the protostar),
  // but leave a clearing right around the core so the ignition reads as a bright
  // cavity rather than a fog ball.
  float core = smoothstep(CORE_R * 1.2, VOL_R * 0.8, r);
  float d = n * shell * mix(0.35, 1.0, core);

  // --- Mouse parts the gas: subtract a soft sphere of density that follows the
  // cursor, and add swirl turbulence near it so the cloud reacts. ---
  float md = length(p - mWorld);
  float bite = smoothstep(0.95, 0.0, md);     // 1 at cursor, fades out
  d -= bite * 0.55;                            // carve the cavity
  // Turbulence injection: extra high-freq noise modulated by proximity to cursor.
  d += bite * 0.25 * (warpedFbm(p * 2.3 + uTime * 0.3) - 0.45);

  // Threshold so we get crisp filaments instead of uniform haze.
  d = max(d - 0.42, 0.0) * 1.9;
  return d;
}

// CHEAP density used ONLY by the secondary shadow march. A single fbm (no double
// domain warp) plus the same mouse bite — visually consistent for the god-ray
// optical-depth estimate, but vastly cheaper so the nested march stays real-time.
float densityCheap(vec3 p, vec3 mWorld) {
  float r = length(p);
  float shell = smoothstep(VOL_R, VOL_R * 0.45, r);
  float n = fbm(p * 0.9 + vec3(0.0, 1.7, 4.2) + uTime * 0.04);
  float core = smoothstep(CORE_R * 1.2, VOL_R * 0.8, r);
  float d = n * shell * mix(0.35, 1.0, core);

  float md = length(p - mWorld);
  float bite = smoothstep(0.95, 0.0, md);
  d -= bite * 0.55;

  d = max(d - 0.42, 0.0) * 1.9;
  return d;
}

// ----------------------------------------------------------------------------
// Emission color ramp: cold magenta/indigo dust -> warm gold + cyan near ignition.
// heat in [0,1] roughly maps "how hot" (0 = cold dust, 1 = at the core).
// ----------------------------------------------------------------------------
vec3 emissionColor(float heat) {
  heat = clamp(heat, 0.0, 1.0);
  // Multi-stop ramp built by mixing.
  vec3 cold = vec3(0.18, 0.05, 0.32);   // deep indigo
  vec3 dust = vec3(0.55, 0.10, 0.40);   // magenta dust
  vec3 warm = vec3(1.20, 0.55, 0.18);   // amber / gold
  vec3 hot  = vec3(1.60, 1.25, 0.75);   // near-white hot
  vec3 cyan = vec3(0.30, 0.85, 1.10);   // cyan ignition rim

  vec3 c = mix(cold, dust, smoothstep(0.0, 0.4, heat));
  c = mix(c, warm, smoothstep(0.35, 0.7, heat));
  c = mix(c, hot,  smoothstep(0.72, 1.0, heat));
  // A cyan rim sits just outside the hottest zone (ionized shell feel).
  c += cyan * smoothstep(0.55, 0.85, heat) * (1.0 - smoothstep(0.85, 1.0, heat)) * 0.6;
  return c;
}

// ----------------------------------------------------------------------------
// Procedural starfield (drawn for rays that survive the cloud).
// ----------------------------------------------------------------------------
vec3 starfield(vec3 rd) {
  vec3 col = vec3(0.0);
  // Two layers at different scales for depth.
  for (int k = 0; k < 2; k++) {
    float scl = (k == 0) ? 24.0 : 60.0;
    vec3 gp = rd * scl;
    vec3 ip = floor(gp);
    float h = hash13(ip);
    if (h > 0.985) {
      vec3 fp = fract(gp) - 0.5;
      float d = length(fp);
      float star = smoothstep(0.45, 0.0, d);
      // Twinkle.
      float tw = 0.6 + 0.4 * sin(uTime * 2.0 + h * 100.0);
      // Slight color variance: bluish to warm white.
      vec3 sc = mix(vec3(0.7, 0.8, 1.0), vec3(1.0, 0.9, 0.8), fract(h * 33.0));
      col += sc * star * tw * (k == 0 ? 0.9 : 0.5);
    }
  }
  return col;
}

// ----------------------------------------------------------------------------
// Secondary "shadow" march: estimate optical depth of gas between point p and the
// core, so light shafts (god-rays) carve through the dust. Short and CHEAP.
// ----------------------------------------------------------------------------
float lightTransmission(vec3 p, vec3 mWorld) {
  vec3 toCore = -p;                       // core is at origin
  float dist = length(toCore);
  vec3 dir = toCore / max(dist, 1e-4);
  float stepLen = dist / float(SHADOW_STEPS);
  float tau = 0.0;                        // accumulated optical depth
  vec3 sp = p;
  for (int i = 0; i < SHADOW_STEPS; i++) {
    sp += dir * stepLen;
    tau += densityCheap(sp, mWorld) * stepLen;
  }
  // Beer-Lambert transmission toward the core.
  return exp(-tau * 2.2);
}

void main() {
  // Map fullscreen UV into [-1,1] with correct aspect ratio.
  vec2 uv = (vUv * 2.0 - 1.0);
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  uv.x *= aspect;

  // --- Look-at camera basis (hardened against a degenerate up vector). ---
  vec3 ro = uCamPos;
  vec3 fwd = normalize(-ro);                              // always look at origin
  vec3 upRef = vec3(0.0, 1.0, 0.0);
  // If fwd is nearly parallel to upRef, swap to a different reference axis.
  if (abs(fwd.y) > 0.999) upRef = vec3(0.0, 0.0, 1.0);
  vec3 right = normalize(cross(upRef, fwd));
  vec3 up = cross(fwd, right);
  vec3 rd = normalize(fwd + uv.x * right + uv.y * up);    // ~53deg FOV

  // --- Place the mouse "bite" in the world: a point floating in front of the core,
  // offset by the cursor across the camera's right/up plane. ---
  vec3 mWorld = right * (uMouse.x * 1.6) + up * (uMouse.y * 1.6) + fwd * 0.4;

  // --- Ray/volume sphere intersection so we only march where gas can exist. ---
  // Solve |ro + t*rd| = VOL_R.
  float b = dot(ro, rd);
  float c = dot(ro, ro) - VOL_R * VOL_R;
  float disc = b * b - c;

  vec3 col = vec3(0.0);
  float alpha = 0.0;        // accumulated opacity (front-to-back)

  // Background starfield (will show through wherever the cloud is thin).
  vec3 bg = starfield(rd);
  // Faint deep-space gradient so true black is avoided.
  bg += mix(vec3(0.01, 0.012, 0.03), vec3(0.03, 0.01, 0.05), vUv.y);

  if (disc > 0.0) {
    float sq = sqrt(disc);
    float tNear = max(-b - sq, 0.0);
    float tFar  = -b + sq;
    float span = max(tFar - tNear, 1e-4);

    // March front-to-back through the sphere.
    float stepLen = span / float(MAX_STEPS);
    // Dithered start to break up banding (uses screen-space hash).
    float jitter = hash13(vec3(gl_FragCoord.xy, uTime));
    float t = tNear + stepLen * jitter;

    for (int i = 0; i < MAX_STEPS; i++) {
      if (alpha > 0.99) break;            // early-out when saturated
      if (t > tFar) break;
      vec3 p = ro + rd * t;

      float dens = densityAt(p, mWorld);
      if (dens > 0.001) {
        float r = length(p);

        // Heat rises sharply toward the core (1/r-ish), clamped.
        float heat = clamp(CORE_R / max(r, 1e-3), 0.0, 1.0);
        heat = pow(heat, 0.6);

        // God-ray term: how much core-light reaches this voxel through the dust.
        float trans = lightTransmission(p, mWorld);
        // Light intensity from the core also falls off with distance.
        float coreLight = trans / (1.0 + r * r * 2.2);

        // --- Ignition shockwave: a bright expanding shell at radius uShockR. ---
        float shell = exp(-pow((r - uShockR) * 4.0, 2.0)) * uIgnite;

        // Emission = thermal glow of the gas + scattered core light + shockwave.
        vec3 emis = emissionColor(heat) * (0.35 + heat * 2.2);
        emis += emissionColor(0.9) * coreLight * 6.0;     // god-ray scattered light
        emis += vec3(1.4, 1.1, 0.8) * shell * 3.0;        // shockwave brightness

        // Beer-Lambert absorption over this step.
        float a = 1.0 - exp(-dens * stepLen * 3.4);

        // Front-to-back compositing.
        col += (1.0 - alpha) * emis * dens * stepLen * 3.0;
        alpha += (1.0 - alpha) * a;
      }

      t += stepLen;
    }

    // --- The protostar core itself: a bright bloom centered on the origin, seen
    // through the remaining transparency of the cloud (1 - alpha). ---
    // Closest approach of the ray to the origin:
    float tCore = max(-b, 0.0);
    vec3 pc = ro + rd * tCore;
    float coreDist = length(pc);
    float coreGlow = exp(-coreDist * coreDist * 5.0);          // tight core
    float halo     = 1.0 / (1.0 + coreDist * coreDist * 8.0);  // wide halo
    vec3 coreCol = (vec3(1.6, 1.35, 0.95) * coreGlow * 3.0
                  + emissionColor(0.85) * halo * 0.9);
    col += coreCol * (1.0 - alpha * 0.7);
  }

  // Composite cloud over the starfield background.
  col += bg * (1.0 - alpha);

  // --- Full-frame ignition flash (decays fast right after a click). ---
  col += vec3(1.1, 1.0, 0.9) * uFlash * 0.9;

  // Tone map (filmic-ish) + gamma + vignette.
  col = col / (col + vec3(0.85));
  col = pow(max(col, 0.0), vec3(0.4545));
  float vig = smoothstep(1.7, 0.35, length(uv));
  col *= mix(0.62, 1.0, vig);

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

// ---------------------------------------------------------------------------
// p5 LIFECYCLE
// ---------------------------------------------------------------------------

function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL);
  pixelDensity(1);
  noStroke();

  // Offscreen WEBGL buffer we raymarch into at reduced resolution, then image() up.
  // (image() preserves orientation; p5.Framebuffer flipped vertically — avoid it.)
  gfx = createGraphics(
    Math.max(1, Math.floor(width * RENDER_SCALE)),
    Math.max(1, Math.floor(height * RENDER_SCALE)),
    WEBGL
  );
  gfx.pixelDensity(1);
  gfx.noStroke();

  nurseryShader = gfx.createShader(VERT, FRAG);

  // Seed mouse trackers so the very first drag doesn't jump from (0,0).
  lastMX = width / 2;
  lastMY = height / 2;
  lastInteraction = -99999;

  if (window.__sketchReady) window.__sketchReady();
}

function draw() {
  const tSec = millis() * 0.001;

  // --- Idle drift: if the user hasn't touched anything for a moment, gently
  //     rotate so the piece is alive on its own. ---
  const idle = millis() - lastInteraction > 2200;
  if (idle && !dragging) {
    yaw += 0.0016;
  }

  // Smooth the dolly toward its target.
  targetDist = constrain(targetDist, 1.4, 8.5);
  camDist += (targetDist - camDist) * 0.10;
  if (!isFinite(camDist)) camDist = 5.2; // NaN guard

  // Keep pitch away from the exact poles to avoid a degenerate "up" vector.
  pitch = constrain(pitch, -1.3, 1.3);

  // Spherical -> Cartesian camera position around the origin.
  const cp = Math.cos(pitch);
  const camPos = [
    camDist * cp * Math.cos(yaw),
    camDist * Math.sin(pitch),
    camDist * cp * Math.sin(yaw),
  ];

  // --- Mouse -> normalized [-1,1] screen space, smoothed. Guard the initial
  //     (0,0): if the mouse hasn't moved yet, treat it as screen center. ---
  let nmx = 0, nmy = 0;
  if (mouseX !== 0 || mouseY !== 0) {
    nmx = (mouseX / width) * 2 - 1;
    nmy = -((mouseY / height) * 2 - 1); // flip Y so up is positive
  }
  smoothMx += (nmx - smoothMx) * 0.08;
  smoothMy += (nmy - smoothMy) * 0.08;

  // --- Ignition: compute shockwave radius + flash from time since the last click. ---
  const since = (millis() - igniteTime) * 0.001; // seconds since click
  let ignite = 0, shockR = 0, flash = 0;
  if (since >= 0 && since < 2.5) {
    // Shockwave expands outward and fades.
    shockR = since * 1.7;                       // world units
    ignite = Math.max(0, 1 - since / 2.5);      // shell brightness decay
    flash = Math.max(0, 1 - since / 0.35);      // quick full-frame flash
    flash *= flash;
  }

  // --- Render the shader into the offscreen buffer. ---
  gfx.shader(nurseryShader);
  nurseryShader.setUniform('uResolution', [gfx.width, gfx.height]);
  nurseryShader.setUniform('uTime', tSec);
  nurseryShader.setUniform('uCamPos', camPos);
  nurseryShader.setUniform('uMouse', [smoothMx, smoothMy]);
  nurseryShader.setUniform('uIgnite', ignite);
  nurseryShader.setUniform('uShockR', shockR);
  nurseryShader.setUniform('uFlash', flash);
  gfx.rectMode(CENTER);
  gfx.rect(0, 0, gfx.width, gfx.height);

  // Blit the low-res buffer up to the full screen. Main canvas is WEBGL, so use
  // centered coords; image() preserves orientation (no flip).
  image(gfx, -width / 2, -height / 2, width, height);
}

// ---------------------------------------------------------------------------
// INTERACTION
// ---------------------------------------------------------------------------

function mousePressed() {
  // Ignore presses outside the canvas (e.g. UI chrome).
  if (mouseX < 0 || mouseY < 0 || mouseX > width || mouseY > height) return;
  dragging = true;
  lastMX = mouseX;
  lastMY = mouseY;
  lastInteraction = millis();
  // CLICK feeds an ignition — start the flash + shockwave.
  igniteTime = millis();
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

  // Drag rotates the view (slowly).
  yaw   += dx * 0.005;
  pitch += dy * 0.005;
  lastInteraction = millis();
}

function mouseWheel(event) {
  // Positive deltaY = scroll down = pull back; clamp so we stay in/near the cloud.
  const d = event && isFinite(event.delta) ? event.delta : 0;
  targetDist *= 1.0 + d * 0.0012;
  targetDist = constrain(targetDist, 1.4, 8.5);
  lastInteraction = millis();
  return false; // prevent the page from scrolling
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  // Recreate the size-dependent render buffer at the new resolution.
  const w = Math.max(1, Math.floor(width * RENDER_SCALE));
  const h = Math.max(1, Math.floor(height * RENDER_SCALE));
  if (gfx) gfx.resize(w, h);
}