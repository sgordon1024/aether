// Shared boot for every piece page: a slide-out hamburger nav, a hint pill,
// and on-screen diagnostics. Defines window.__sketchReady() which each sketch
// calls from setup() to clear the loading banner. Uncaught errors show ON THE
// PAGE (no dev tools needed).
(function () {
  const GROUPS = [
    {
      label: "Elements",
      items: [
        { id: "water",  emoji: "🌊", name: "Ripple Pool", tag: "Water" },
        { id: "fire",   emoji: "🔥", name: "Emberfield",  tag: "Fire" },
        { id: "wind",   emoji: "🌾", name: "Meadow",      tag: "Wind" },
        { id: "tree",   emoji: "🌳", name: "Forest",      tag: "Earth" },
        { id: "aurora", emoji: "🌌", name: "Aurora",      tag: "Sky" },
      ],
    },
    {
      label: "Pushing limits",
      items: [
        { id: "reaction",  emoji: "🪸", name: "Coral",      tag: "Diffusion" },
        { id: "physarum",  emoji: "🍄", name: "Mycelium",   tag: "Emergence" },
        { id: "attractor", emoji: "✨", name: "Stardust",   tag: "Chaos" },
        { id: "fluid",     emoji: "💧", name: "Ink",        tag: "Fluid" },
        { id: "fractal",   emoji: "🔮", name: "Mandelbulb", tag: "Fractal", sub: {
          label: "Variations",
          items: [
            { id: "acidbulb", emoji: "🌈", name: "Acidbulb", tag: "Technicolor" },
          ],
        } },
        { id: "blackhole", emoji: "🕳️", name: "Event Horizon", tag: "Gravity" },
        { id: "genesis",   emoji: "🌟", name: "Genesis",       tag: "Volumetric" },
      ],
    },
  ];

  const P = window.PIECE || { title: "sketch", hint: "" };
  document.title = P.title + " · aether";
  const here = (location.pathname.split("/").pop() || "").replace(".html", "");

  // Hamburger toggle
  const toggle = document.createElement("button");
  toggle.className = "nav-toggle";
  toggle.setAttribute("aria-label", "Open menu");
  toggle.innerHTML = "<span></span><span></span><span></span>";

  // Dimmed backdrop
  const scrim = document.createElement("div");
  scrim.className = "nav-scrim";

  // Slide-out panel
  const panel = document.createElement("nav");
  panel.className = "nav-panel";
  let html = '<div class="nav-title">Aether</div>';
  for (const g of GROUPS) {
    html += '<div class="nav-head">' + g.label + "</div>";
    for (const pc of g.items) {
      const active = pc.id === here ? " active" : "";
      html +=
        '<a class="nav-item' + active + '" href="' + pc.id + '.html">' +
        '<span class="nav-emoji">' + pc.emoji + "</span>" +
        '<span class="nav-name">' + pc.name + "</span>" +
        '<span class="nav-tag">' + pc.tag + "</span></a>";

      // Optional nested sub-folder (e.g. variations of a piece).
      if (pc.sub) {
        html += '<div class="nav-subfolder">';
        html += '<div class="nav-sub-head">' + pc.sub.label + "</div>";
        for (const sc of pc.sub.items) {
          const sActive = sc.id === here ? " active" : "";
          html +=
            '<a class="nav-item nav-sub-item' + sActive + '" href="' + sc.id + '.html">' +
            '<span class="nav-emoji">' + sc.emoji + "</span>" +
            '<span class="nav-name">' + sc.name + "</span>" +
            '<span class="nav-tag">' + sc.tag + "</span></a>";
        }
        html += "</div>";
      }
    }
  }
  panel.innerHTML = html;

  // Hint pill + status banner
  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent = P.hint;

  const status = document.createElement("div");
  status.className = "status";
  status.textContent = "loading " + P.title + "…";

  function openNav() { document.body.classList.add("nav-open"); toggle.setAttribute("aria-expanded", "true"); }
  function closeNav() { document.body.classList.remove("nav-open"); toggle.setAttribute("aria-expanded", "false"); }
  function toggleNav() { document.body.classList.contains("nav-open") ? closeNav() : openNav(); }

  toggle.addEventListener("click", toggleNav);
  scrim.addEventListener("click", closeNav);
  window.addEventListener("keydown", function (e) { if (e.key === "Escape") closeNav(); });

  function mount() {
    document.body.classList.add("piece");
    document.body.appendChild(scrim);
    document.body.appendChild(panel);
    document.body.appendChild(toggle);
    document.body.appendChild(hint);
    document.body.appendChild(status);
    if (typeof p5 === "undefined") {
      status.classList.add("err");
      status.textContent = "p5 did not load (../lib/p5.min.js was blocked or missing).";
    }
  }
  if (document.body) mount();
  else window.addEventListener("DOMContentLoaded", mount);

  window.__sketchReady = function () { status.style.display = "none"; };

  window.addEventListener("error", function (e) {
    status.style.display = "block";
    status.classList.add("err");
    const file = (e.filename || "").split("/").pop();
    status.textContent =
      "Error: " + (e.message || e.error) + "  (" + file + ":" + (e.lineno || "?") + ")";
  });
})();
