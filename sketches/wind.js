// Wind — a meadow of grass blades. A Perlin-noise wind sweeps the field;
// the mouse parts the blades as it passes, and a click sends a gust rippling out.

let blades = [];
let gusts = [];

function setup() {
  createCanvas(windowWidth, windowHeight);
  pixelDensity(1);
  buildBlades();
  if (window.__sketchReady) window.__sketchReady();
}

function buildBlades() {
  blades = [];
  const spacing = 7;
  for (let x = 0; x <= width; x += spacing) {
    blades.push({
      x: x + random(-2, 2),
      h: random(height * 0.18, height * 0.42),
      phase: random(TWO_PI),
      hue: random(95, 140),
    });
  }
}

function drawSky() {
  for (let y = 0; y < height; y += 2) {
    stroke(lerpColor(color(34, 46, 78), color(196, 162, 116), y / height));
    line(0, y, width, y);
  }
}

function draw() {
  drawSky();
  const t = frameCount * 0.012;
  const baseY = height;

  for (let i = gusts.length - 1; i >= 0; i--) {
    gusts[i].r += 9;
    gusts[i].life--;
    if (gusts[i].life <= 0) gusts.splice(i, 1);
  }

  colorMode(HSB, 360, 100, 100, 100);
  noFill();
  strokeWeight(2);
  for (const b of blades) {
    const wind = (noise(b.x * 0.004, t) - 0.5) * 2;
    let bend = wind * b.h * 0.5 + sin(t * 1.3 + b.phase) * 6;

    // Mouse parts the grass it moves through.
    const dx = b.x - mouseX;
    if (abs(dx) < 140 && mouseY > baseY - b.h - 60) {
      bend += (1 - abs(dx) / 140) * 65 * Math.sign(dx || 1);
    }
    // Expanding gust rings from clicks.
    for (const g of gusts) {
      const ring = abs(abs(b.x - g.x) - g.r);
      if (ring < 45) {
        bend += (1 - ring / 45) * 55 * Math.sign(b.x - g.x || 1) * (g.life / g.maxLife);
      }
    }

    const tipX = b.x + bend, tipY = baseY - b.h;
    const cX = b.x + bend * 0.5, cY = baseY - b.h * 0.5;

    stroke(b.hue, 70, 55 + (b.h / (height * 0.42)) * 28, 92);
    beginShape();
    for (let s = 0; s <= 6; s++) {
      const u = s / 6;
      const px = (1 - u) * (1 - u) * b.x + 2 * (1 - u) * u * cX + u * u * tipX;
      const py = (1 - u) * (1 - u) * baseY + 2 * (1 - u) * u * cY + u * u * tipY;
      vertex(px, py);
    }
    endShape();
  }
  colorMode(RGB, 255);
}

function mousePressed() {
  gusts.push({ x: mouseX, r: 0, life: 70, maxLife: 70 });
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  buildBlades();
}
