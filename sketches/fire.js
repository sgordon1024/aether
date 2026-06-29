// Fire — paint with living embers. Additive blending makes overlaps glow.
// Before you move the mouse, a campfire burns at the center. Then it follows you.
// Click = a burst of sparks.

let embers = [];
let hot, mid, cool;
let started = false;

function setup() {
  createCanvas(windowWidth, windowHeight);
  pixelDensity(1);
  hot = color(255, 245, 200);
  mid = color(255, 140, 30);
  cool = color(120, 20, 10);
  if (window.__sketchReady) window.__sketchReady();
}

function draw() {
  background(8, 6, 10, 55); // soft trails

  const sx = started ? mouseX : width / 2;
  const sy = started ? mouseY : height * 0.68;

  const rate = mouseIsPressed ? 16 : 7;
  for (let i = 0; i < rate; i++) embers.push(new Ember(sx, sy));

  blendMode(ADD);
  for (let i = embers.length - 1; i >= 0; i--) {
    const e = embers[i];
    e.update();
    e.show();
    if (e.dead()) embers.splice(i, 1);
  }
  blendMode(BLEND);
}

class Ember {
  constructor(x, y) {
    this.pos = createVector(x + random(-8, 8), y + random(-8, 8));
    this.vel = createVector(random(-0.6, 0.6), random(-2.6, -1.1));
    this.age = 0;
    this.life = random(40, 95);
    this.size = random(8, 22);
    this.seed = random(1000);
  }
  update() {
    this.age++;
    this.vel.x += (noise(this.seed, frameCount * 0.02) - 0.5) * 0.4; // flicker
    this.vel.y -= 0.02; // buoyancy
    this.pos.add(this.vel);
  }
  show() {
    const t = this.age / this.life;
    const c = t < 0.5 ? lerpColor(hot, mid, t * 2) : lerpColor(mid, cool, (t - 0.5) * 2);
    noStroke();
    fill(red(c), green(c), blue(c), (1 - t) * 170);
    circle(this.pos.x, this.pos.y, this.size * (1 - t * 0.6));
  }
  dead() { return this.age >= this.life; }
}

function mouseMoved() { started = true; }
function mouseDragged() { started = true; }

function mousePressed() {
  started = true;
  for (let i = 0; i < 130; i++) {
    const e = new Ember(mouseX, mouseY);
    e.vel = p5.Vector.fromAngle(random(TWO_PI)).mult(random(1, 7));
    embers.push(e);
  }
}

function windowResized() { resizeCanvas(windowWidth, windowHeight); }
