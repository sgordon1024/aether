// Particle field — thousands of agents streaming along a slowly evolving
// Perlin-noise flow field. The hallmark "silk / flow" aesthetic.
// Move the mouse to push particles around.

let particles = [];
const NUM = 1500;
let zoff = 0;

function setup() {
  createCanvas(windowWidth, windowHeight);
  background(11, 11, 15);
  for (let i = 0; i < NUM; i++) particles.push(new P());
  if (window.__sketchReady) window.__sketchReady();
}

function draw() {
  background(11, 11, 15, 14); // soft trails
  zoff += 0.003;
  for (const p of particles) {
    p.step();
    p.draw();
  }
}

class P {
  constructor() {
    this.pos = createVector(random(width), random(height));
    this.vel = createVector();
    this.life = random(100, 300);
    this.hue = random(200, 320);
  }
  step() {
    const scl = 0.0015;
    const a = noise(this.pos.x * scl, this.pos.y * scl, zoff) * TWO_PI * 3;
    const f = p5.Vector.fromAngle(a).mult(0.6);

    // Mouse repulsion.
    const m = createVector(mouseX, mouseY);
    const d = p5.Vector.sub(this.pos, m);
    if (d.mag() < 120) f.add(d.copy().setMag(1.5));

    this.vel.add(f).limit(3);
    this.pos.add(this.vel);
    this.life--;

    if (this.life < 0 || this.offscreen()) this.reset();
  }
  offscreen() {
    return this.pos.x < 0 || this.pos.x > width || this.pos.y < 0 || this.pos.y > height;
  }
  reset() {
    this.pos.set(random(width), random(height));
    this.vel.set(0, 0);
    this.life = random(100, 300);
  }
  draw() {
    colorMode(HSB, 360, 100, 100, 100);
    stroke(this.hue, 60, 100, 55);
    strokeWeight(1.4);
    point(this.pos.x, this.pos.y);
    colorMode(RGB, 255);
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  background(11, 11, 15);
}
