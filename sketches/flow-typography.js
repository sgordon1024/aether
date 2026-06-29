// Flow-field typography — kinetic type drifting along a flow field.
// Letters dissolve into particles that drift along a Perlin-noise flow field.
// Click to re-seed the word. Press any letter key to type your own.

let word = "PLAY";
let particles = [];
const FONT_SIZE = 320;
let pg; // offscreen buffer we sample letterforms from

function setup() {
  createCanvas(windowWidth, windowHeight);
  pixelDensity(1);
  pg = createGraphics(width, height);
  pg.pixelDensity(1); // critical: keep buffer at 1x so pixel-sampling math is correct on Retina
  buildParticlesFromWord();
  if (window.__sketchReady) window.__sketchReady();
}

function buildParticlesFromWord() {
  particles = [];
  pg.clear();
  pg.fill(255);
  pg.textAlign(CENTER, CENTER);
  pg.textStyle(BOLD);
  pg.textSize(FONT_SIZE);
  pg.text(word, width / 2, height / 2);
  pg.loadPixels();

  // Sample the rendered text on a grid; spawn a particle where there's ink.
  const step = 5;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const idx = 4 * (y * width + x);
      if (pg.pixels[idx + 3] > 128) {
        particles.push(new Particle(x, y));
      }
    }
  }
}

function draw() {
  // Trailing fade instead of a hard clear — this is what gives the "smear".
  background(11, 11, 15, 28);
  const t = frameCount * 0.0015;
  for (const p of particles) {
    p.follow(t);
    p.update();
    p.show();
  }
}

class Particle {
  constructor(hx, hy) {
    this.home = createVector(hx, hy);
    this.pos = createVector(random(width), random(height));
    this.vel = createVector();
    this.acc = createVector();
    this.maxSpeed = 4;
    this.hue = map(hx, 0, width, 180, 330);
  }
  follow(t) {
    // Blend a noise flow field with a gentle pull back toward the letter.
    const angle = noise(this.pos.x * 0.0018, this.pos.y * 0.0018, t) * TWO_PI * 2;
    const flow = p5.Vector.fromAngle(angle).mult(0.35);
    const homePull = p5.Vector.sub(this.home, this.pos).mult(0.01);
    this.acc.add(flow).add(homePull);
  }
  update() {
    this.vel.add(this.acc).limit(this.maxSpeed);
    this.pos.add(this.vel);
    this.acc.mult(0);
  }
  show() {
    colorMode(HSB, 360, 100, 100, 100);
    stroke(this.hue, 70, 100, 70);
    strokeWeight(2.2);
    point(this.pos.x, this.pos.y);
    colorMode(RGB, 255);
  }
}

function mousePressed() {
  for (const p of particles) p.pos.set(random(width), random(height));
}

function keyPressed() {
  if (key === "Backspace") word = word.slice(0, -1);
  else if (key.length === 1) word += key.toUpperCase();
  buildParticlesFromWord();
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  pg = createGraphics(width, height);
  pg.pixelDensity(1);
  buildParticlesFromWord();
}
