# Aether

An interactive, zero-install gallery of generative art sketches — built with
[p5.js](https://p5js.org/). Twelve full-screen pieces spanning natural elements,
emergent systems, and the cosmos. p5.js is vendored locally (`lib/p5.min.js`), so
there's nothing to `npm install` and no network required to run it.

## Run it

From this folder, start any static server:

```bash
# Option A — Python (built in on macOS)
python3 -m http.server 8000

# Option B — Node
npx live-server     # auto-reloads on save
```

Then open **http://localhost:8000**. A local server is recommended over a plain
`file://` open (it avoids browser security quirks, and `live-server` gives you
auto-reload).

## The gallery

Every piece is full-screen and interactive. Use the **hamburger menu** (top-left)
to slide out the gallery and jump between pieces.

### Elements

| Piece | Element | Interaction |
|-------|---------|-------------|
| 🌊 Ripple Pool | Water | Click to splash · drag to ripple the surface |
| 🔥 Emberfield  | Fire  | Move to paint with embers · click for a burst |
| 🌾 Meadow      | Wind  | Move through the grass to part it · click for a gust |
| 🌳 Forest      | Earth | Click to plant a tree — it grows and sways |
| 🌌 Aurora      | Sky   | Drag to summon the lights · click for a shooting star |

### Pushing limits

| Piece | Technique | Interaction |
|-------|-----------|-------------|
| 🪸 Coral        | Gray-Scott reaction–diffusion (GPU ping-pong shaders) | Drag to grow · scroll brush · space/C/R |
| 🍄 Mycelium     | Physarum slime-mold agent simulation | Move & click to feed the swarm · scroll = tightness |
| ✨ Stardust     | 3D strange attractor, GPU particles | Drag to orbit · scroll to zoom · click to reshuffle |
| 💧 Ink          | GPU fluid (advection + curl) | Drag to inject ink and stir |
| 🔮 Mandelbulb   | Real-time raymarched 3D fractal | Drag to orbit · scroll to zoom |
| 🕳️ Event Horizon | Gravitationally-lensed black hole + accretion disk | Move to steer · drag to spin · scroll = mass |
| 🌟 Genesis      | Volumetric raymarched stellar nursery | Move to part the gas · click to ignite · scroll to fly in |

## How it's wired

- `index.html` — redirects to the first piece.
- `pieces/<id>.html` — a thin wrapper per piece: loads `lib/p5.min.js`, sets the
  piece title + hint, then loads `js/boot.js` and `sketches/<id>.js`.
- `js/boot.js` — shared chrome for every piece: the slide-out hamburger nav, the
  on-screen hint pill, and an **on-page error overlay** (so a failed sketch shows a
  readable message instead of a black screen).
- `sketches/<id>.js` — the actual p5 sketch, written in global mode.
- `css/style.css` — gallery + nav styling.

## The core idea

Every p5 sketch is two functions:

```js
function setup() { /* runs once */ }
function draw()  { /* runs ~60x per second */ }
```

That's the whole mental model. Tweak numbers, break things, re-run.

## Where to go next

- **p5.js reference:** https://p5js.org/reference/
- **The Coding Train** (Daniel Shiffman) — a great video intro to this world
- **Inigo Quilez** — https://iquilezles.org/articles/ — the canonical resource for the shader techniques behind the raymarched pieces
- **Level up to installations:** [openFrameworks](https://openframeworks.cc) (C++) for installation-grade work
