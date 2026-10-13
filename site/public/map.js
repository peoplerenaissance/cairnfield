/* Draws the map behind the page and the trail through it.
   Without this script the page keeps a simpler tiled contour pattern and a straight trail.
   It holds no color. The map's lines and spot heights take theirs from the palette of site.css at each draw,
   and the trail takes its stroke from a rule there, so the stylesheet alone says how both look in a light and a dark scheme. */
(function () {
  var PERIOD = 2400, CELL = 8;

  /* Height of the land at a point. It repeats every PERIOD pixels down the page, so one drawing can tile. */
  function height(x, y) {
    var a = 2 * Math.PI * y / PERIOD;
    return Math.sin(a + x / 310)
      + 0.7 * Math.sin(2 * a - x / 190 + 1.3)
      + 0.5 * Math.sin(3 * a + x / 130 + 2.1) * Math.cos(x / 420)
      + 0.6 * Math.cos(x / 260 + 0.5)
      + 0.35 * Math.sin(5 * a + x / 90);
  }
  function slope(x, y) {
    return [(height(x + 4, y) - height(x - 4, y)) / 8, (height(x, y + 4) - height(x, y - 4)) / 8];
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /* The colors of the map as the stylesheet holds them for the reader's scheme. A token's text can start with a space. Trimmed, a token that no rule sets is the empty text. */
  function palette() {
    var style = getComputedStyle(document.documentElement);
    function token(name) { return style.getPropertyValue(name).trim(); }
    return { line: token('--contour'), index: token('--contour-5'), spot: token('--spot') };
  }

  function drawTerrain(colors) {
    var W = Math.max(document.documentElement.clientWidth, 320);
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var canvas = document.createElement('canvas');
    canvas.width = W * dpr; canvas.height = PERIOD * dpr;
    var g = canvas.getContext('2d');
    if (!g) return;
    g.scale(dpr, dpr);
    var cols = Math.ceil(W / CELL) + 1, rows = PERIOD / CELL + 1;
    var v = new Float32Array(cols * rows), r, q;
    for (r = 0; r < rows; r++) for (q = 0; q < cols; q++) v[r * cols + q] = height(q * CELL, r * CELL);

    function mix(a, b, L) { return (L - a) / (b - a); }
    for (var i = -12; i <= 12; i++) {
      var L = i * 0.24 + 0.07, index = i % 5 === 0;
      g.beginPath();
      for (r = 0; r < rows - 1; r++) {
        for (q = 0; q < cols - 1; q++) {
          var a = v[r * cols + q], b = v[r * cols + q + 1], c = v[(r + 1) * cols + q + 1], d = v[(r + 1) * cols + q];
          var k = (a > L ? 8 : 0) | (b > L ? 4 : 0) | (c > L ? 2 : 0) | (d > L ? 1 : 0);
          if (k === 0 || k === 15) continue;
          var x = q * CELL, y = r * CELL;
          var T = [x + CELL * mix(a, b, L), y], R = [x + CELL, y + CELL * mix(b, c, L)];
          var B = [x + CELL * mix(d, c, L), y + CELL], Lf = [x, y + CELL * mix(a, d, L)];
          var segs = k === 1 || k === 14 ? [[Lf, B]] : k === 2 || k === 13 ? [[B, R]] : k === 3 || k === 12 ? [[Lf, R]]
            : k === 4 || k === 11 ? [[T, R]] : k === 6 || k === 9 ? [[T, B]] : k === 7 || k === 8 ? [[T, Lf]]
            : k === 5 ? [[T, R], [Lf, B]] : [[T, Lf], [B, R]];
          for (var n = 0; n < segs.length; n++) { g.moveTo(segs[n][0][0], segs[n][0][1]); g.lineTo(segs[n][1][0], segs[n][1][1]); }
        }
      }
      g.strokeStyle = index ? colors.index : colors.line;
      g.lineWidth = index ? 1.5 : 1;
      g.stroke();
    }

    /* Spot heights at the summits. */
    g.fillStyle = colors.spot; g.strokeStyle = colors.spot; g.lineWidth = 1;
    g.font = '500 10px "Spline Sans Mono", ui-monospace, monospace';
    for (r = 4; r < rows - 4; r += 2) {
      for (q = 6; q < cols - 10; q += 2) {
        var c0 = v[r * cols + q];
        if (c0 < 1.75) continue;
        var top = true;
        for (var dr = -4; dr <= 4 && top; dr += 2) for (var dq = -4; dq <= 4; dq += 2) {
          if ((dr || dq) && v[(r + dr) * cols + q + dq] >= c0) { top = false; break; }
        }
        if (!top) continue;
        var px = q * CELL, py = r * CELL;
        g.beginPath(); g.moveTo(px - 3, py); g.lineTo(px + 3, py); g.moveTo(px, py - 3); g.lineTo(px, py + 3); g.stroke();
        g.fillText(String(Math.round(400 + c0 * 90)), px + 6, py + 3);
      }
    }

    var body = document.body.style;
    body.backgroundImage = 'url(' + canvas.toDataURL('image/png') + ')';
    body.backgroundSize = W + 'px ' + PERIOD + 'px';
    body.backgroundRepeat = 'repeat-y';
    body.backgroundPosition = 'top left';
  }

  function drawTrail() {
    var old = document.getElementById('trail');
    if (old) old.remove();
    var root = document.documentElement;
    var marks = Array.prototype.filter.call(document.querySelectorAll('.waymark'), function (m) { return m.offsetParent !== null; });
    if (marks.length < 2) { root.classList.remove('js-trail'); return; }
    var sx = window.scrollX, sy = window.scrollY;
    var stops = marks.map(function (m) {
      var b = m.getBoundingClientRect();
      return { x: b.left + sx + b.width / 2, y: b.top + sy + b.height / 2 };
    });
    var content = document.querySelector('main .wrap').getBoundingClientRect().width;
    var wrapLeft = document.querySelector('main .wrap').getBoundingClientRect().left + sx;
    var lo = Math.max(14, stops[0].x - 130), hi = Math.min(stops[0].x + 22, wrapLeft + 14);
    var pts = [];

    for (var i = 0; i < stops.length - 1; i++) {
      var A = stops[i], B = stops[i + 1];
      var upper = B.y - 60, lower = B.y - 30;
      pts.push([A.x, A.y]);

      /* Down the margin: lean along the contour lines, and drift back toward the line of cairns. */
      var x = A.x;
      for (var y = A.y + 22; y < upper - 26; y += 20) {
        var s = slope(x, y), tx = -s[1], ty = s[0], len = Math.sqrt(tx * tx + ty * ty) || 1;
        tx /= len; ty /= len;
        if (ty < 0) { tx = -tx; ty = -ty; }
        x += clamp(tx / Math.max(ty, 0.45) * 11, -15, 15) + (A.x - 30 - x) * 0.035;
        x = clamp(x, lo, hi);
        pts.push([x, y]);
      }

      /* A switchback across the open ground between sections. Steeper ground gets a longer one. */
      var s2 = slope(A.x + 160, upper), steep = Math.sqrt(s2[0] * s2[0] + s2[1] * s2[1]);
      var reach = clamp(150 + steep * 9000, 170, content * 0.62);
      var x0 = B.x + 6, x1 = B.x + reach, step = 46, xx;
      pts.push([x0 - 2, upper - 14]);
      for (xx = x0 + step; xx < x1; xx += step) pts.push([xx, upper + 6 * Math.sin(xx / 64)]);
      pts.push([x1 + 12, (upper + lower) / 2]);
      for (xx = x1 - 4; xx > x0 + step / 2; xx -= step) pts.push([xx, lower + 5 * Math.sin(xx / 58 + 1.4)]);
      pts.push([B.x + 4, lower + 6]);
    }
    pts.push([stops[stops.length - 1].x, stops[stops.length - 1].y]);

    /* A smooth curve through the points. */
    var d = 'M' + pts[0][0].toFixed(1) + ' ' + pts[0][1].toFixed(1);
    for (var j = 0; j < pts.length - 1; j++) {
      var p0 = pts[Math.max(j - 1, 0)], p1 = pts[j], p2 = pts[j + 1], p3 = pts[Math.min(j + 2, pts.length - 1)];
      d += ' C' + (p1[0] + (p2[0] - p0[0]) / 6).toFixed(1) + ' ' + (p1[1] + (p2[1] - p0[1]) / 6).toFixed(1)
        + ' ' + (p2[0] - (p3[0] - p1[0]) / 6).toFixed(1) + ' ' + (p2[1] - (p3[1] - p1[1]) / 6).toFixed(1)
        + ' ' + p2[0].toFixed(1) + ' ' + p2[1].toFixed(1);
    }
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.id = 'trail';
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('width', root.scrollWidth);
    svg.setAttribute('height', root.scrollHeight);
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-dasharray', '7 7');
    path.setAttribute('stroke-linecap', 'round');
    svg.appendChild(path);
    document.body.appendChild(svg);
    root.classList.add('js-trail');
  }

  /* The map is baked again when the width or a color changed since the last bake, so a resize and a change of scheme take one path. */
  var baked = '', timer;
  function bake() {
    var colors = palette();
    var key = [document.documentElement.clientWidth, colors.line, colors.index, colors.spot].join(' ');
    /* A reader can hold an older stylesheet than this script, across a deploy, and that one sets none of the three.
       A canvas ignores an empty color and draws in black, so nothing is baked and the tile stays. */
    if (colors.line && colors.index && colors.spot && key !== baked) { baked = key; drawTerrain(colors); }
  }
  function redraw() { bake(); drawTrail(); }
  redraw();
  window.addEventListener('load', redraw);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(drawTrail);
  window.addEventListener('resize', function () { clearTimeout(timer); timer = setTimeout(redraw, 150); });
  /* The stylesheet's tokens already hold the new scheme's colors when this event arrives, so the map changes in the frame the ground does.
     The trail keeps its path, and the stylesheet gives it its new stroke. */
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', bake);
})();
