// ============================================================================
//  EVENT HORIZON  —  "blackhole"
//  The death of a star: a Schwarzschild black hole gravitationally lensing a
//  living starfield, wrapped in a Doppler-beamed accretion disk. The matched
//  pair to the stellar nursery — where a star ends rather than begins.
//
//  TECHNIQUE (single-pass fragment shader, screen-space relativistic optics):
//    This is a convincing APPROXIMATION, not a full geodesic integrator.
//    Per pixel we build a view ray in the black hole's screen plane, then march
//    that ray through a 2D "deflection field". At each step we bend the ray
//    toward the hole by an angle ~ (Rs / b), where b is the impact parameter
//    (distance of closest approach). The bend diverges as b -> photon sphere,
//    which both (a) wraps the background sky into Einstein-ring arcs and
//    (b) lets the accretion disk's far side arc OVER and UNDER the shadow —
//    the iconic Interstellar/Gargantua top+bottom halo.
//
//    LENSING APPROACH, precisely:
//      - Work in a 2D plane: x = screen-horizontal, y = screen-vertical, with
//        the hole at the origin of that plane. The disk lives in the equatorial
//        plane seen nearly edge-on, tilted by uTilt.
//      - March a position 'pos' and direction 'dir' for LENS_STEPS fixed steps.
//      - Gravity pulls 'dir' toward the hole each step with strength
//        ~ Rs / r^2 (Newtonian-flavoured but tuned to mimic GR deflection).
//      - If r < shadow radius -> pure black (swallowed).
//      - When the ray crosses the equatorial plane between steps, we sample the
//        accretion disk there (this is what produces the lensed halo for free).
//      - After the march, the final 'dir' samples the procedural sky.
//
//  LOOP BOUNDS (all CONSTANT, GLSL-ES-1.00 safe):
//      LENS_STEPS = 64   (ray-march of the bending integrator)
//      Disk/sky noise: fixed unrolled fbm (6 octaves), no dynamic loops.
//
//  PERFORMANCE: rendered into an offscreen WEBGL graphics buffer at RENDER_SCALE
//      (0.85 of native) and image()'d up — keeps ~60fps at 1440x900 on Apple
//      Silicon. Bump RENDER_SCALE toward 1.0 for crisper rings if you have GPU
//      headroom; drop to ~0.7 on weaker machines.
//
//  INTERACTION:
//      - mouse moves the black hole across the field.
//      - click+drag spins the disk up (faster rotation + slight frame-drag tilt).
//      - mouse wheel changes MASS -> Schwarzschild radius -> stronger lensing
//        and a larger shadow.
//      - (0,0) initial mouse position is guarded.
// ============================================================================

let gfx;                 // offscreen WEBGL buffer we render the shader into
let bhShader;            // the one big fragment shader
const MOBILE = !!(window.__isMobile);
const RENDER_SCALE = MOBILE ? 0.55 : 0.85;
const LENS_STEPS = MOBILE ? 36 : 64;

// --- interaction state (smoothed for buttery motion) ---
let mass = 1.0;          // target mass multiplier (wheel)
let massSmooth = 1.0;
let spin = 0.0;          // target spin-up amount (drag) 0..1
let spinSmooth = 0.0;
let diskAngle = 0.0;     // accumulated disk rotation phase
let holePos;             // smoothed hole position in pixels (screen space)
let holeTarget;          // target hole position
let haveMouse = false;   // becomes true once the user actually moves the mouse

// =================== VERTEX SHADER (canonical fullscreen quad) ===============
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

// ============================= FRAGMENT SHADER ===============================
const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

varying vec2 vUv;

uniform vec2  uResolution;   // render-buffer resolution (px)
uniform float uTime;         // seconds
uniform vec2  uHole;         // black hole center, in clip-ish coords (see below)
uniform float uMass;         // mass multiplier -> scales Schwarzschild radius
uniform float uSpin;         // 0..1 spin-up (disk speed + frame drag)
uniform float uDiskAngle;    // accumulated disk rotation phase
uniform float uTilt;         // disk tilt (radians) — near edge-on

#define LENS_STEPS ${LENS_STEPS}        // CONSTANT loop bound for the bending integrator
#define PI 3.14159265359

// ----------------------------------------------------------------------------
//  Hashing / noise (pure GLSL, no textures)
// ----------------------------------------------------------------------------
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

// value noise in 2D
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i + vec2(0.0, 0.0));
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// 6-octave fbm (unrolled — no dynamic loops)
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  v += a * vnoise(p); p = m * p; a *= 0.5;
  v += a * vnoise(p); p = m * p; a *= 0.5;
  v += a * vnoise(p); p = m * p; a *= 0.5;
  v += a * vnoise(p); p = m * p; a *= 0.5;
  v += a * vnoise(p); p = m * p; a *= 0.5;
  v += a * vnoise(p);
  return v;
}

// ----------------------------------------------------------------------------
//  Procedural deep-space background sampled along a 2D direction angle.
//  We map a screen-plane direction to a "sky" lookup. The starfield + nebula
//  are functions of the bent direction so the universe warps around the hole.
// ----------------------------------------------------------------------------
vec3 starLayer(vec2 uv, float scale, float bright, float twinkle) {
  uv *= scale;
  vec2 cell = floor(uv);
  vec2 f = fract(uv);
  vec3 col = vec3(0.0);
  // sample a 3x3 neighborhood of cells (fixed, unrolled-style via loop with const bound)
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 off = vec2(float(i), float(j));
      vec2 id = cell + off;
      float h = hash21(id);
      // star present?
      if (h > 0.965) {
        vec2 starPos = off + vec2(hash21(id + 11.7), hash21(id + 41.3));
        float d = length(f - starPos);
        float tw = 0.6 + 0.4 * sin(twinkle + h * 40.0);
        float core = bright * tw / (1.0 + 240.0 * d * d);
        // give brighter stars a faint chromatic tint
        vec3 tint = mix(vec3(0.7, 0.8, 1.0), vec3(1.0, 0.9, 0.75), hash21(id + 7.0));
        col += core * tint;
      }
    }
  }
  return col;
}

vec3 sampleSky(vec2 dir) {
  // dir is a normalized-ish 2D direction in the hole's screen plane.
  // Turn it into stable 2D sky coordinates (angle + radius give a dome feel).
  float ang = atan(dir.y, dir.x);
  float rad = length(dir);
  vec2 uv = vec2(ang * 1.6, rad * 2.2 + ang * 0.15);

  vec3 col = vec3(0.0);

  // faint nebula: layered fbm, cool clouds with a few warm pockets
  float n1 = fbm(uv * 1.3 + vec2(0.0, uTime * 0.005));
  float n2 = fbm(uv * 2.7 - vec2(uTime * 0.004, 0.0));
  float neb = pow(n1 * n2, 1.6);
  vec3 nebCool = vec3(0.05, 0.10, 0.22) * neb * 1.4;
  vec3 nebWarm = vec3(0.22, 0.08, 0.14) * pow(n2, 3.0) * 0.9;
  col += nebCool + nebWarm;

  // deep base tint so the void is never pure flat black
  col += vec3(0.008, 0.011, 0.02);

  // multiple star layers at different densities for parallax-y depth
  col += starLayer(uv, 14.0, 1.0, uTime * 1.5);
  col += starLayer(uv * 1.7 + 5.0, 24.0, 0.6, uTime * 2.1);
  col += starLayer(uv * 0.7 - 3.0, 9.0, 1.5, uTime * 0.9);

  return col;
}

// ----------------------------------------------------------------------------
//  Blackbody-ish color ramp for the accretion disk.
//  t in 0..1 : 0 = cool deep red (outer/redshifted), 1 = blue-white (hot/inner).
// ----------------------------------------------------------------------------
vec3 blackbody(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 deepRed   = vec3(0.55, 0.06, 0.02);
  vec3 orange    = vec3(1.0, 0.42, 0.08);
  vec3 yellow    = vec3(1.0, 0.85, 0.45);
  vec3 white     = vec3(1.0, 0.98, 0.92);
  vec3 blueWhite = vec3(0.75, 0.88, 1.0);
  vec3 c;
  if (t < 0.33)      c = mix(deepRed, orange, t / 0.33);
  else if (t < 0.6)  c = mix(orange, yellow, (t - 0.33) / 0.27);
  else if (t < 0.82) c = mix(yellow, white, (t - 0.6) / 0.22);
  else               c = mix(white, blueWhite, (t - 0.82) / 0.18);
  return c;
}

// ----------------------------------------------------------------------------
//  Accretion disk emission at a point where the ray crossed the equatorial
//  plane. 'r' is distance from the hole (in plane units), 'phi' is the azimuth
//  around the hole, 'Rs' the Schwarzschild radius. Returns premultiplied color.
//  Handles: radial temperature falloff, turbulent spiral structure, relativistic
//  Doppler beaming (approaching side brighter+bluer), and gravitational redshift.
// ----------------------------------------------------------------------------
vec3 diskEmission(float r, float phi, float Rs, float diskSpeed, out float alpha) {
  alpha = 0.0;
  float rIn  = Rs * 1.45;     // inner edge ~ inside photon sphere region
  float rOut = Rs * 7.5;      // outer edge of the bright disk
  if (r < rIn || r > rOut) return vec3(0.0);

  // normalized radial coordinate 0 (inner/hot) .. 1 (outer/cool)
  float rn = (r - rIn) / (rOut - rIn);

  // ---- turbulent spiral plasma ----
  // sample in polar-ish coords advected by rotation; inner orbits faster
  float orbit = diskSpeed * (1.5 / (r * 0.6 + 0.4));   // Keplerian-ish shear
  float a = phi - orbit;
  vec2 turbUV = vec2(a * 2.4, r * 1.6);
  float plasma = fbm(turbUV + vec2(0.0, uTime * 0.15));
  plasma = pow(plasma, 1.3);
  // bright spiral filaments
  float filament = 0.5 + 0.5 * sin(a * 3.0 + r * 1.3 - uTime * 0.6 + plasma * 6.0);
  float density = mix(0.35, 1.0, plasma) * mix(0.6, 1.0, filament);

  // ---- temperature: hotter toward the inner edge ----
  float temp = (1.0 - rn);                 // 1 inner .. 0 outer
  temp = pow(temp, 0.8);

  // ---- relativistic Doppler beaming ----
  // The disk's local velocity is tangential. Project onto the line-of-sight to
  // the viewer. With a near-edge-on tilt, the side at phi≈0 swings toward us,
  // phi≈PI swings away. los ~ cos(phi) modulated by how edge-on we are.
  float edgeOn = cos(uTilt);               // 1 when fully edge-on
  float beta = clamp(0.42 / sqrt(max(r / Rs, 1.0)), 0.0, 0.78); // orbital speed (v/c)
  float los = sin(phi) * edgeOn;           // +approaching / -receding component
  float doppler = 1.0 / (1.0 - beta * los); // relativistic boost factor (>1 approaching)
  doppler = pow(doppler, 3.2);              // beaming exponent (intensity ~ D^(3..4))

  // ---- gravitational redshift near the hole ----
  float grav = sqrt(max(1.0 - Rs / r, 0.04)); // -> 0 near horizon

  // combine into an effective "temperature shift": approaching+near = bluer/hotter
  float shift = clamp(temp * 0.55 + (doppler - 1.0) * 0.18 + grav * 0.35, 0.0, 1.0);
  vec3 col = blackbody(shift);

  // brightness: emission * doppler beaming * gravitational dimming
  float bright = density * (0.35 + temp * 1.8) * doppler * grav;

  // soft edges (inner & outer falloff) so the disk doesn't hard-clip
  float edge = smoothstep(0.0, 0.12, rn) * smoothstep(1.0, 0.78, rn);
  bright *= edge;

  alpha = clamp(bright * 0.9, 0.0, 1.0);
  return col * bright;
}

void main() {
  // ---- build the view ray in the hole's screen plane ----
  // p spans roughly [-aspect..aspect] x [-1..1], origin at screen center.
  vec2 p = (vUv * 2.0 - 1.0);
  float aspect = uResolution.x / uResolution.y;
  p.x *= aspect;

  // hole position in the same coordinate space
  vec2 hp = uHole;
  hp.x *= aspect;

  // Schwarzschild radius scales with mass.
  float Rs = 0.16 * uMass;
  float shadowR = Rs * 1.0;          // event-horizon shadow radius
  float photonR = Rs * 1.30;         // photon-sphere ring radius

  // ---- ray-marched 2D deflection integrator ----
  // We march a "screen ray" outward from the pixel; gravity bends it toward hp.
  vec2 pos = p;
  // Start the ray pointing "into the screen" — we treat the march as integrating
  // how light from infinity arrives at this pixel. We march the position away
  // from the camera along a synthetic depth while pulling toward the hole.
  vec2 rel = pos - hp;
  float b = max(length(rel), 1e-4);  // impact parameter

  // Direction the photon travels in-plane (initially radially-from-center proxy).
  // We model deflection as accumulating an angular bend of the sampling vector.
  vec2 sampleDir = rel;              // where on the sky this pixel looks
  float bend = 0.0;                  // total accumulated bend angle

  // accretion disk accumulation (premultiplied)
  vec3 diskCol = vec3(0.0);
  float diskA = 0.0;

  // Was the ray captured by the hole?
  bool captured = false;

  // March: step the position along its current direction, bending each step.
  // We integrate in the screen plane; the "vertical" coordinate (pos.y relative
  // to the hole, rotated by tilt) defines the equatorial-plane crossing.
  vec2 marchPos = pos;
  vec2 marchDir = normalize(rel + vec2(1e-5));  // outward-ish initial heading
  float stepLen = (b + Rs) * 0.06 + 0.012;

  float diskSpeed = uDiskAngle;

  for (int i = 0; i < LENS_STEPS; i++) {
    vec2 toHole = hp - marchPos;
    float r = length(toHole);

    // captured by the event horizon
    if (r < shadowR) { captured = true; break; }

    // gravitational acceleration toward the hole (tuned GR-flavoured falloff)
    float g = (Rs * 0.55) / (r * r + 1e-3);
    vec2 ndir = normalize(toHole + vec2(1e-6));
    marchDir = normalize(marchDir + ndir * g);

    // accumulate bend (how much the sky direction rotated) — used for sky lookup
    bend += g;

    // ---- equatorial-plane (accretion disk) crossing test ----
    // The disk plane is the hole's horizontal axis, tilted by uTilt. We measure
    // the signed "height" of the march point above that plane.
    vec2 q = marchPos - hp;
    // rotate q by -tilt so the disk plane becomes the local x-axis
    float ct = cos(uTilt), st = sin(uTilt);
    float planeH = q.x * (-st) + q.y * ct;   // signed distance from disk plane

    // detect a sign change in planeH between this step and a tiny look-ahead
    vec2 nextPos = marchPos + marchDir * stepLen;
    vec2 q2 = nextPos - hp;
    float planeH2 = q2.x * (-st) + q2.y * ct;

    if (planeH * planeH2 < 0.0 && r < Rs * 8.0) {
      // crossed the disk plane: sample emission here
      float rInPlane = length(q);            // radial dist in the plane
      // azimuth around the ring as seen in-plane (in the disk's rotating frame)
      float phi = atan(q.y, q.x) - uTilt + diskSpeed;
      float aSeg;
      vec3 emis = diskEmission(rInPlane, phi, Rs, diskSpeed, aSeg);
      // front-to-back compositing (premultiplied)
      float t = (1.0 - diskA);
      diskCol += emis * t;
      diskA += aSeg * t;
    }

    marchPos = nextPos;

    // adapt step a little: smaller near the hole for accuracy
    stepLen = (r + Rs) * 0.05 + 0.010;

    if (diskA > 0.995) break; // fully opaque disk — stop early
  }

  // ---- compose final color ----
  vec3 col = vec3(0.0);

  if (captured) {
    // inside the event horizon: pure black (with a whisper of disk in front)
    col = vec3(0.0);
  } else {
    // sample the warped sky along the bent direction
    float ca = cos(bend), sa = sin(bend);
    mat2 rot = mat2(ca, -sa, sa, ca);
    vec2 skyDir = rot * normalize(sampleDir + vec2(1e-5)) * (b + bend * 0.4);
    col = sampleSky(skyDir);
  }

  // ---- photon ring: sharp bright ring at the photon sphere edge ----
  // Distance of this pixel's impact parameter to the photon radius.
  float ringD = abs(b - photonR);
  float ring = smoothstep(Rs * 0.16, 0.0, ringD);
  // make it razor-thin and intensely bright with a warm-white color
  float ringCore = smoothstep(Rs * 0.05, 0.0, ringD);
  vec3 ringCol = mix(vec3(1.0, 0.75, 0.4), vec3(1.0, 0.95, 0.85), ringCore);
  // The photon ring only shows OUTSIDE the shadow.
  if (b > shadowR * 0.96) {
    col += ringCol * (ring * 1.2 + ringCore * 2.2);
  }

  // ---- composite the (lensed) accretion disk over everything ----
  // spin-up makes the plasma read a touch hotter/brighter (energetic infall).
  diskCol *= (1.0 + uSpin * 0.35);
  col = col * (1.0 - diskA) + diskCol;

  // ---- a soft outer glow / gravitational bloom around the hole ----
  float glow = exp(-max(b - photonR, 0.0) * (7.0 / Rs));
  col += vec3(0.9, 0.55, 0.3) * glow * 0.12;

  // ---- tone mapping + grade ----
  col = col / (col + vec3(0.85));        // Reinhard-ish
  col = pow(col, vec3(0.85));            // gentle gamma lift
  // subtle cool vignette
  float vig = 1.0 - 0.25 * dot(p, p) * 0.18;
  col *= clamp(vig, 0.6, 1.0);

  // a touch of film grain to kill banding in the dark void
  float grain = (hash31(vec3(vUv * uResolution, uTime)) - 0.5) * 0.025;
  col += grain;

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

// ============================== p5 LIFECYCLE =================================
function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL);
  pixelDensity(1);
  noStroke();

  buildBuffer();
  bhShader = gfx.createShader(VERT, FRAG);

  // guard the (0,0) initial mouse: start the hole dead center.
  holeTarget = createVector(0.0, 0.0);
  holePos = createVector(0.0, 0.0);

  if (window.__sketchReady) window.__sketchReady();
}

function buildBuffer() {
  // (re)create the offscreen render buffer at RENDER_SCALE of native size.
  const w = Math.max(2, Math.floor(windowWidth * RENDER_SCALE));
  const h = Math.max(2, Math.floor(windowHeight * RENDER_SCALE));
  gfx = createGraphics(w, h, WEBGL);
  gfx.pixelDensity(1);
  gfx.noStroke();
}

function draw() {
  background(0);

  // ----- resolve interaction into smoothed parameters -----
  // Detect a real mouse move so the (0,0) startup doesn't snap the hole.
  if (!haveMouse && (mouseX !== 0 || mouseY !== 0) &&
      mouseX > 0 && mouseY > 0) {
    haveMouse = true;
  }

  if (haveMouse) {
    // map mouse (px, origin top-left) to centered clip-ish coords [-1..1] (y up).
    holeTarget.x = (mouseX / windowWidth) * 2.0 - 1.0;
    holeTarget.y = -((mouseY / windowHeight) * 2.0 - 1.0);
  } else {
    holeTarget.set(0.0, 0.0);
  }
  // smooth the hole motion for a heavy, gravitational feel
  holePos.x = lerp(holePos.x, holeTarget.x, 0.08);
  holePos.y = lerp(holePos.y, holeTarget.y, 0.08);

  // spin-up while dragging, decays when released
  if (mouseIsPressed) spin = Math.min(1.0, spin + 0.03);
  else spin = Math.max(0.0, spin - 0.015);
  spinSmooth = lerp(spinSmooth, spin, 0.1);

  // mass smoothing (wheel target)
  massSmooth = lerp(massSmooth, mass, 0.12);

  // accumulate disk rotation; faster when spun up.
  // wrap to keep the value bounded so GLSL sin/atan don't lose float precision
  // (and shimmer) after the sketch has been running for a long time.
  const baseRot = 0.18;
  const dt = (deltaTime > 0 ? deltaTime : 16.0) / 1000.0;
  diskAngle = (diskAngle + (baseRot + spinSmooth * 0.9) * dt) % (Math.PI * 2.0);

  // a little frame-dragging tilt when spinning
  const tilt = 1.32 - spinSmooth * 0.22;  // radians (near edge-on ~ PI/2 would be flat)

  // ----- render the shader into the offscreen buffer -----
  gfx.shader(bhShader);
  bhShader.setUniform('uResolution', [gfx.width, gfx.height]);
  bhShader.setUniform('uTime', millis() / 1000.0);
  bhShader.setUniform('uHole', [holePos.x, holePos.y]);
  bhShader.setUniform('uMass', massSmooth);
  bhShader.setUniform('uSpin', spinSmooth);
  bhShader.setUniform('uDiskAngle', diskAngle);
  bhShader.setUniform('uTilt', tilt);
  gfx.noStroke();
  gfx.rectMode(CENTER);
  gfx.rect(0, 0, gfx.width, gfx.height);

  // ----- blit the buffer up to the full canvas (centered, WEBGL) -----
  image(gfx, -width / 2, -height / 2, width, height);
}

// =============================== INTERACTION =================================
function mouseWheel(event) {
  // scroll changes MASS -> Schwarzschild radius -> lensing strength + shadow size
  mass += (event.delta > 0 ? -0.08 : 0.08);
  mass = Math.max(0.45, Math.min(2.4, mass));
  return false; // prevent page scroll
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  buildBuffer();
  // shaders belong to the buffer's GL context; rebuild it for the new buffer.
  bhShader = gfx.createShader(VERT, FRAG);
}