// Animated masked grid — a tiling of cells whose contents rotate and pulse
// out of phase, driven by distance from the mouse. Rhythmic, systemic,
// very much in the daily-sketch spirit.

let cols, rows;
const CELL = 64;

function setup() {
  createCanvas(windowWidth, windowHeight);
  computeGrid();
  noStroke();
  if (window.__sketchReady) window.__sketchReady();
}

function computeGrid() {
  cols = ceil(width / CELL);
  rows = ceil(height / CELL);
}

function draw() {
  background(11, 11, 15);
  const t = frameCount * 0.02;

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const cx = i * CELL + CELL / 2;
      const cy = j * CELL + CELL / 2;
      const d = dist(cx, cy, mouseX, mouseY);
      const phase = t - d * 0.01;
      const s = (sin(phase) * 0.5 + 0.5);

      push();
      translate(cx, cy);
      rotate(phase * 0.5);

      colorMode(HSB, 360, 100, 100, 100);
      fill((i * 8 + j * 8 + frameCount) % 360, 65, 100, 90);

      const r = s * CELL * 0.7 + 4;
      // Alternate squares and circles in a checkerboard.
      if ((i + j) % 2 === 0) rectMode(CENTER), rect(0, 0, r, r, 4);
      else circle(0, 0, r);

      colorMode(RGB, 255);
      pop();
    }
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  computeGrid();
}
