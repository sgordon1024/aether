// Water — interactive ripple pool using a classic height-field simulation.
// Two buffers store the surface; each frame the wave equation propagates energy.
// Click = a big splash, drag = a continuous wake.

let cols, rows;
const SCL = 6;        // pixels per simulation cell
const DAMP = 0.985;   // energy loss per step (closer to 1 = longer-lasting ripples)
let cur, prev, buf;

function setup() {
  createCanvas(windowWidth, windowHeight);
  pixelDensity(1);
  initGrid();
  if (window.__sketchReady) window.__sketchReady();
}

function initGrid() {
  cols = floor(width / SCL);
  rows = floor(height / SCL);
  cur = new Float32Array(cols * rows);
  prev = new Float32Array(cols * rows);
  buf = createImage(cols, rows);
}

function draw() {
  background(6, 14, 26);

  // Propagate the wave: new height = average of neighbors - old height.
  for (let y = 1; y < rows - 1; y++) {
    for (let x = 1; x < cols - 1; x++) {
      const i = x + y * cols;
      const avg = (prev[i - 1] + prev[i + 1] + prev[i - cols] + prev[i + cols]) / 2;
      cur[i] = (avg - cur[i]) * DAMP;
    }
  }
  // Swap so prev holds the freshest surface.
  const tmp = prev; prev = cur; cur = tmp;

  // Render the surface into the low-res image, then scale it up.
  buf.loadPixels();
  for (let i = 0; i < cols * rows; i++) {
    const v = prev[i];
    const idx = i * 4;
    buf.pixels[idx] = 20 + v * 0.6;       // r
    buf.pixels[idx + 1] = 90 + v * 0.9;   // g  (values auto-clamp to 0..255)
    buf.pixels[idx + 2] = 150 + v * 1.4;  // b
    buf.pixels[idx + 3] = 255;
  }
  buf.updatePixels();
  image(buf, 0, 0, width, height);
}

function disturb(mx, my, amount) {
  const x = floor(mx / SCL), y = floor(my / SCL);
  if (x > 1 && x < cols - 1 && y > 1 && y < rows - 1) {
    prev[x + y * cols] += amount;
  }
}

function mousePressed() { disturb(mouseX, mouseY, 1200); }
function mouseDragged() { disturb(mouseX, mouseY, 350); }

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  initGrid();
}
