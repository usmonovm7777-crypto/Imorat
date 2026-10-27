// Label artwork for product packaging, drawn on a 2D canvas and used as a texture by the renderer.
window.makeLabel = function (L) {
  const F = (w, size) => `${w} ${size}px Carlito, "DejaVu Sans", sans-serif`;
  const c = document.createElement("canvas");
  const g = c.getContext("2d");
  const logo = (x, y, s, col1, col2) => {
    const q = s / 2 - s * 0.04;
    g.fillStyle = col1; g.fillRect(x, y, q, q); g.fillStyle = col2; g.fillRect(x + s / 2, y, q, q);
    g.globalAlpha = 0.55; g.fillStyle = col1; g.fillRect(x, y + s / 2, q, q); g.globalAlpha = 1;
    g.fillStyle = col1; g.fillRect(x + s / 2, y + s / 2, q, q);
  };
  const fitText = (txt, x, y, maxW, size, weight, color, align = "center") => {
    let s = size; g.font = F(weight, s);
    while (g.measureText(txt).width > maxW && s > 10) { s -= 4; g.font = F(weight, s); }
    g.fillStyle = color; g.textAlign = align; g.textBaseline = "alphabetic"; g.fillText(txt, x, y);
  };
  if (L.kind === "bag") {
    c.width = 744; c.height = 1024;
    g.fillStyle = L.paper || "#d9c9a8"; g.fillRect(0, 0, c.width, c.height);
    // paper fibres
    for (let i = 0; i < 1400; i++) { g.fillStyle = `rgba(0,0,0,${Math.random() * 0.05})`; g.fillRect(Math.random() * 744, Math.random() * 1024, Math.random() * 3 + 1, 1); }
    g.fillStyle = L.band || "#0B6E69"; g.fillRect(0, 70, 744, 150);
    logo(60, 105, 80, "#ffffff", L.accent || "#E8662A");
    fitText(L.brand || "IMORAT", 175, 182, 420, 84, "bold", "#ffffff", "left");
    fitText(L.big, 372, 470, 640, 210, "bold", L.ink || "#1b1b1b");
    fitText(L.sub || "", 372, 560, 640, 54, "bold", L.ink || "#1b1b1b");
    g.save(); g.translate(0, 700); g.rotate(-0.12);
    g.fillStyle = L.accent || "#E8662A"; g.fillRect(-40, 0, 840, 110);
    fitText(L.line || "", 372, 72, 600, 46, "bold", "#ffffff"); g.restore();
    g.beginPath(); g.arc(600, 905, 78, 0, Math.PI * 2); g.fillStyle = L.band || "#0B6E69"; g.fill();
    fitText(L.kg || "", 600, 925, 130, 58, "bold", "#ffffff");
    fitText(L.tiny || "O'ZBEKISTONDA ISHLAB CHIQARILGAN", 60, 980, 440, 26, "normal", L.ink || "#1b1b1b", "left");
  } else if (L.kind === "wrap") {
    c.width = 2048; c.height = L.h || 480;
    const H = c.height;
    g.fillStyle = L.paper || "#ffffff"; g.fillRect(0, 0, 2048, H);
    const panel = cx => {
      const W = L.pw || 820;
      g.save(); g.beginPath(); g.rect(cx - W / 2, 0, W, H); g.clip();
      g.fillStyle = L.accent || "#0B6E69";
      g.beginPath(); g.moveTo(cx - W / 2, H * 0.72); g.bezierCurveTo(cx - W * 0.2, H * 0.55, cx + W * 0.15, H * 0.95, cx + W / 2, H * 0.7); g.lineTo(cx + W / 2, H); g.lineTo(cx - W / 2, H); g.fill();
      g.fillStyle = L.accent2 || "#E8662A";
      g.beginPath(); g.moveTo(cx - W / 2, H * 0.86); g.bezierCurveTo(cx - W * 0.1, H * 0.74, cx + W * 0.2, H * 1.02, cx + W / 2, H * 0.84); g.lineTo(cx + W / 2, H); g.lineTo(cx - W / 2, H); g.fill();
      logo(cx - W * 0.42, H * 0.08, H * 0.12, L.accent || "#0B6E69", L.accent2 || "#E8662A");
      fitText(L.brand || "IMORAT", cx - W * 0.42 + H * 0.16, H * 0.18, W * 0.5, H * 0.12, "bold", L.ink || "#17201e", "left");
      fitText(L.big, cx, H * 0.43, W * 0.88, H * 0.22, "bold", L.ink || "#17201e");
      fitText(L.sub || "", cx, H * 0.56, W * 0.85, H * 0.08, "bold", L.ink2 || "#55615e");
      if (L.vol) { g.beginPath(); g.arc(cx + W * 0.36, H * 0.17, H * 0.11, 0, Math.PI * 2); g.fillStyle = L.accent2 || "#E8662A"; g.fill();
      fitText(L.vol, cx + W * 0.36, H * 0.2, H * 0.2, H * 0.08, "bold", "#ffffff"); }
      g.restore();
    };
    const u = L.u ?? 0.6;
    panel(2048 * u); panel(2048 * ((u + 0.5) % 1));
  } else if (L.kind === "front") {
    c.width = 1024; c.height = L.h || 600;
    const H = c.height;
    g.fillStyle = L.paper || "#f2d34a"; g.fillRect(0, 0, 1024, H);
    g.fillStyle = L.band || "#17201e"; g.fillRect(0, H * 0.06, 1024, H * 0.2);
    logo(60, H * 0.09, H * 0.14, "#ffffff", L.accent || "#E8662A");
    fitText(L.brand || "IMORAT", 60 + H * 0.2, H * 0.215, 500, H * 0.13, "bold", "#ffffff", "left");
    fitText(L.big, 512, H * 0.56, 900, H * 0.24, "bold", L.ink || "#17201e");
    fitText(L.sub || "", 512, H * 0.7, 900, H * 0.09, "bold", L.ink || "#17201e");
    g.fillStyle = L.accent || "#E8662A"; g.fillRect(0, H * 0.82, 1024, H * 0.12);
    fitText(L.line || "", 512, H * 0.905, 900, H * 0.075, "bold", "#ffffff");
  } else if (L.kind === "sleeve") {
    c.width = 1024; c.height = 1024;
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, 1024, 1024);
    const cy = 1024 * 0.375, bh = 1024 * 0.36;
    g.fillStyle = L.accent || "#2b8bd1"; g.fillRect(0, cy + bh / 2 - 40, 1024, 40);
    g.fillStyle = L.accent2 || "#0d4c7a"; g.fillRect(0, cy - bh / 2, 1024, 26);
    logo(70, cy - bh / 2 + 50, 70, L.accent || "#2b8bd1", L.accent2 || "#0d4c7a");
    fitText(L.brand || "IMORAT", 160, cy - bh / 2 + 108, 300, 64, "bold", "#17201e", "left");
    fitText(L.big, 560, cy + 40, 720, 150, "bold", L.accent2 || "#0d4c7a");
    fitText(L.sub || "", 560, cy + 105, 720, 46, "bold", "#55615e");
  } else if (L.kind === "disc") {
    c.width = c.height = 1024;
    g.clearRect(0, 0, 1024, 1024);
    g.beginPath(); g.arc(512, 512, 505, 0, Math.PI * 2); g.fillStyle = L.paper || "#1f3d7a"; g.fill();
    g.beginPath(); g.arc(512, 512, 300, 0, Math.PI * 2); g.fillStyle = L.accent || "#E8662A"; g.fill();
    g.beginPath(); g.arc(512, 512, 150, 0, Math.PI * 2); g.fillStyle = "#c9ccd0"; g.fill();
    g.save(); g.translate(512, 512);
    const ring = (txt, r, size) => { g.font = F("bold", size); g.fillStyle = "#fff"; g.textAlign = "center"; const chars = txt.split(""); const step = 0.085; let a = -((chars.length - 1) * step) / 2 - Math.PI / 2; for (const ch of chars) { g.save(); g.rotate(a + Math.PI / 2); g.fillText(ch, 0, -r); g.restore(); a += step; } };
    ring("IMORAT · INOX · METALL", 400, 64);
    g.restore();
    fitText(L.big || "125", 512, 470, 260, 120, "bold", "#ffffff");
    fitText(L.sub || "1.2 mm", 512, 600, 260, 60, "bold", "#ffffff");
  }
  return c;
};
