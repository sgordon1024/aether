// Aurora — a night sky with twinkling stars and flowing northern lights.
// Drag the mouse to brighten the curtains where you move (the glow decays back
// down over time). Click to launch a shooting star.

let stars = [];
let glow = [];
let shooters = [];
const BANDS = 120;

function setup() {
  createCanvas(windowWidth, windowHeight);
  pixelDensity(1);
  for (let i = 0; i < 260; i++) {
    stars.push({ x: random(width), y: random(height * 0.7), s: random(0.5, 2), tw: random(1000) });
  }
  glow = new Array(BANDS).fill(0.15);
  if (window.__sketchReady) window.__sketchReady();
}

function draw() {
  // Night gradient.
  for (let y = 0; y < height; y += 2) {
    stroke(lerpColor(color(6, 8, 24), color(20, 16, 40), y / height));
    line(0, y, width, y);
  }

  // Stars twinkle.
  noStroke();
  for (const s of stars) {
    fill(255, 255, 255, 150 + 105 * sin(frameCount * 0.05 + s.tw));
    circle(s.x, s.y, s.s);
  }

  // Mouse brightens nearby bands.
  if (mouseIsPressed || movedThisFrame()) {
    const bi = floor(map(mouseX, 0, width, 0, BANDS));
    for (let k = -8; k <= 8; k++) {
      const idx = bi + k;
      if (idx >= 0 && idx < BANDS) glow[idx] = min(1.5, glow[idx] + (1 - abs(k) / 8) * 0.07);
    }
  }

  // The aurora itself.
  push();
  blendMode(ADD);
  const t = frameCount * 0.006;
  const bw = width / BANDS;
  colorMode(HSB, 360, 100, 100, 100);
  for (let i = 0; i < BANDS; i++) {
    glow[i] = max(0.12, glow[i] * 0.985); // decay toward baseline
    const x = i * bw + bw / 2;
    const topY = height * 0.12 + noise(i * 0.06, t) * height * 0.25;
    const h = (120 + noise(i * 0.06, t + 10) * 260) * glow[i];
    const hue = 120 + noise(i * 0.03, t + 5) * 120; // green → purple
    for (let seg = 0; seg < 10; seg++) {
      const yy = topY + (h / 10) * seg;
      stroke(hue, 80, 90, (1 - seg / 10) * 30 * glow[i]);
      strokeWeight(bw + 2);
      line(x, yy, x, yy + h / 10 + 1);
    }
  }
  colorMode(RGB, 255);
  pop();
  blendMode(BLEND);

  // Shooting stars.
  for (let i = shooters.length - 1; i >= 0; i--) {
    const sh = shooters[i];
    sh.x += sh.vx; sh.y += sh.vy; sh.life--;
    stroke(255, 255, 255, map(sh.life, 0, sh.maxLife, 0, 255));
    strokeWeight(2);
    line(sh.x, sh.y, sh.x - sh.vx * 4, sh.y - sh.vy * 4);
    if (sh.life <= 0 || sh.x > width || sh.y > height) shooters.splice(i, 1);
  }
}

let _pmx = 0, _pmy = 0;
function movedThisFrame() {
  const moved = mouseX !== _pmx || mouseY !== _pmy;
  _pmx = mouseX; _pmy = mouseY;
  return moved;
}

function mousePressed() {
  shooters.push({ x: mouseX, y: mouseY, vx: random(6, 12), vy: random(2, 6), life: 60, maxLife: 60 });
}

function windowResized() { resizeCanvas(windowWidth, windowHeight); }
