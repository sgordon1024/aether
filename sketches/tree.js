// Forest — click the ground to plant a tree. Each one grows from a seed via
// recursive branching, then sways in the wind. Leaves are deterministic (a stable
// noise lookup keyed by draw order) so they don't flicker frame to frame.

let trees = [];
let leafIndex = 0;
const GROUND = 60;

function setup() {
  createCanvas(windowWidth, windowHeight);
  pixelDensity(1);
  trees.push(makeTree(width / 2));
  if (window.__sketchReady) window.__sketchReady();
}

function makeTree(x) {
  return {
    x,
    growth: 0,
    len: random(90, 140),
    depth: floor(random(8, 10)),
    seed: random(1000),
    hue: random(90, 140),
  };
}

function draw() {
  background(20, 24, 38);
  noStroke();
  fill(28, 40, 30);
  rect(0, height - GROUND, width, GROUND);

  const t = frameCount * 0.01;
  leafIndex = 0; // reset each frame so leaf i maps to the same leaf every frame
  for (const tr of trees) {
    tr.growth = min(1, tr.growth + 0.02);
    push();
    translate(tr.x, height - GROUND);
    branch(tr, tr.len * tr.growth, tr.depth, t);
    pop();
  }
}

function branch(tr, len, depth, t) {
  if (depth <= 0 || len < 2) {
    const v = noise(leafIndex * 0.35);
    leafIndex++;
    colorMode(HSB, 360, 100, 100, 100);
    noStroke();
    fill((tr.hue + (v - 0.5) * 40 + 360) % 360, 55, 90, 80);
    circle(0, 0, 6 + v * 8);
    colorMode(RGB, 255);
    return;
  }

  const sway = sin(t + depth * 0.4 + tr.seed) * (0.04 + (tr.depth - depth) * 0.01);
  strokeWeight(map(depth, 0, tr.depth, 1, 9));
  stroke(70, 45, 35);
  line(0, 0, 0, -len);
  translate(0, -len);
  rotate(sway);

  const spread = 0.5;
  push(); rotate(spread + 0.1 * sin(tr.seed)); branch(tr, len * 0.72, depth - 1, t); pop();
  push(); rotate(-spread + 0.1 * cos(tr.seed)); branch(tr, len * 0.72, depth - 1, t); pop();
  if (depth % 2 === 0) { push(); rotate(0.05); branch(tr, len * 0.6, depth - 1, t); pop(); }
}

function mousePressed() {
  if (trees.length < 40) trees.push(makeTree(mouseX));
}

function windowResized() { resizeCanvas(windowWidth, windowHeight); }
