/* RouteFlow wheel, hero variant: the hero's dial IS the wheel. On the first scroll it grows out of the hero, comes apart with every
   piece named, stops on what a first-time wholesaler most needs, and goes back together as "One system."
   const w = RFWheel.mount(el, { refreshPriority: 0, scrub: 0.7, snap: true, top: null, copy: ".hx-copy" }); w.destroy() reverts every
   tween, trigger and listener and puts the element back as it was. <div data-scene="wheel" data-copy=".hx-copy"></div> mounts by itself.
   Every number below is made-up sample data. */
(function (root) {
  "use strict";
  const RAD = Math.PI / 180, PI = Math.PI, TAU = PI * 2, f2 = (n) => +n.toFixed(2);
  const pt = (r, a) => [f2(r * Math.cos(a * RAD)), f2(r * Math.sin(a * RAD))];
  const usd = (n) => "$" + (Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const int = (n) => Math.round(n).toLocaleString("en-US");
  const mod = (a, n) => ((a % n) + n) % n;
  const clamp = (a, b, v) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const ADD = "If you deliver";

  /* c is the solid colour a piece takes when it comes apart. One OKLCH family: the daily-work ring shares one lightness
     and chroma while the hue walks from cool work to warm money; the core ring is the signature navy family.
     w is the same hue, darker, for the side wall. i is the icon ink on the colour: a deep tone of the same hue. */
  const OUTER = [
    { k: "purchases", t: "Purchases", s: "Buy from your suppliers. Goods go into stock.", a: "sun", c: "#6277d9", w: "#4656a2", i: "#1c244f" },
    { k: "bills", t: "Supplier bills", s: "See what you owe.", a: "coral", c: "#4c7dd9", w: "#2f57a4", i: "#1a2d51" },
    { k: "inventory", t: "Inventory", s: "See what you have, box by box.", a: "mint", c: "#4397db", w: "#256fa8", i: "#07304e" },
    { k: "orders", t: "Orders", s: "Take orders in boxes or pieces.", a: "coral", c: "#4caed9", w: "#2f84a8", i: "#023345" },
    { k: "routes", t: "Routes", s: "Put the stops in a good order.", a: "sun", c: "#33afb1", w: "#108586", i: "#023536", n: ADD },
    { k: "delivery", t: "Delivery", s: "The driver can take a signature and a photo at each stop.", a: "mint", c: "#44bd92", w: "#27926e", i: "#003726", n: ADD },
    { k: "invoices", t: "Invoices", s: "Turn the order into an invoice. Send it after delivery.", a: "sun", c: "#e7b64a", w: "#b88e31", i: "#3c2b02" },
    { k: "payments", t: "Payments", s: "Record the check. The balance goes to zero, and you see who still owes you.", a: "mint", c: "#ec9040", w: "#b96c26", i: "#472302" },
    { k: "customers", t: "Customers", s: "One page for each customer.", a: "coral", c: "#e56a5d", w: "#b0493f", i: "#4b1e19" },
    { k: "reports", t: "Reports", s: "See your sales, your profit, and who owes you.", a: "sun", c: "#a462b4", w: "#7a4685", i: "#381b3f" },
  ];
  const INNER = [
    { k: "boxpiece", t: "Box or piece", s: "Sell a full box or one piece.", a: "sun", c: "#355695", w: "#183366" },
    { k: "price", t: "Each buyer’s price", s: "Give one store its own price.", a: "mint", c: "#4d5da4", w: "#2e3a74" },
    { k: "store", t: "Store ordering", s: "Stores see their own prices and order online.", a: "coral", c: "#244f7c", w: "#062c51" },
    { k: "counter", t: "Counter sales", s: "Select it when you set up your account. No fee. Scan, record the payment, print a receipt.", a: "sun", c: "#6261af", w: "#403e7e" },
    { k: "returns", t: "Returns", s: "Take goods back. Give store credit. Give cash back if the invoice is paid.", a: "coral", c: "#2d4470", w: "#102246" },
  ];
  const ALL = OUTER.concat(INNER), NO = OUTER.length, N = ALL.length, STEP_O = 360 / NO;
  /* Nothing has been shown yet when the wheel opens, so it stops only on what a first-time wholesaler asks first: what did they
     order, what do I have, who owes me. Every other piece comes off and gets its name in the air; its detail is in the use cases. */
  const STORY = ["orders", "inventory", "payments"].map((k) => ALL.find((d) => d.k === k));
  const EYE_O = "Your daily work", EYE_I = "How you sell";
  const HINT = "Scroll to look inside";
  const HERO = [
    { t: "Look inside.", s: "Buy, sell, get paid. Then buy again." },
    { t: "One system.", s: "Every step is in RouteFlow." },
  ];

  /* Fine-line icons on a 48 grid. Our own drawings. */
  const ICON = {
    purchases: '<path d="M8 17l16-9 16 9v15l-16 9-16-9z"/><path d="M8 17l16 9 16-9M24 26v15"/>',
    bills: '<path d="M12 6h24v36l-4-3.5-4 3.5-4-3.5-4 3.5-4-3.5-4 3.5z"/><path d="M18 15h12M18 22h12M18 29h7"/>',
    inventory: '<rect x="7" y="26" width="16" height="14" rx="2.5"/><rect x="25" y="26" width="16" height="14" rx="2.5"/><rect x="16" y="9" width="16" height="14" rx="2.5"/>',
    orders: '<rect x="11" y="7" width="26" height="35" rx="4"/><path d="M18 17h12M18 24h12M18 31h7"/>',
    routes: '<circle cx="12" cy="37" r="4"/><circle cx="36" cy="11" r="4"/><path d="M16 37h15a7 7 0 0 0 0-14H17a6 6 0 0 1 0-12h15"/>',
    delivery: '<path d="M9 35H4V12h25v23H17M29 19h8l7 8v8h-5M31 35h-2"/><circle cx="13" cy="36" r="4"/><circle cx="35" cy="36" r="4"/>',
    invoices: '<path d="M13 6h15l9 9v27H13z"/><path d="M28 6v9h9M19 24h12M19 31h12"/>',
    payments: '<circle cx="24" cy="24" r="17"/><path d="M16 24.5l6 6 11-12"/>',
    customers: '<path d="M8 20l3-11h26l3 11M8 20a5.3 5.3 0 0 0 10.7 0 5.3 5.3 0 0 0 10.6 0 5.3 5.3 0 0 0 10.7 0M11 25v15h26V25M21 40v-9h6v9"/>',
    reports: '<path d="M7 41h34"/><rect x="11" y="25" width="7" height="11" rx="1.5"/><rect x="21" y="16" width="7" height="20" rx="1.5"/><rect x="31" y="8" width="7" height="28" rx="1.5"/>',
    boxpiece: '<path d="M6 16l13-7 13 7v13l-13 7-13-7zM6 16l13 7 13-7M19 23v13"/><rect x="33" y="30" width="10" height="10" rx="2"/>',
    price: '<path d="M8 8h15l17 17-15 15L8 23z"/><circle cx="16" cy="16" r="2.5"/>',
    store: '<rect x="14" y="5" width="20" height="38" rx="4.5"/><path d="M21 37h6"/>',
    counter: '<path d="M6 13V9h6M36 9h6v4M42 35v4h-6M12 39H6v-4M13 16v16M19 16v16M25 16v16M30 16v16M35 16v16"/>',
    returns: '<path d="M18 11L8 21l10 10"/><path d="M8 21h23a9 9 0 0 1 0 18h-8"/>',
  };
  const icd = (s) => s.replace(/<rect x="(\S+)" y="(\S+)" width="(\S+)" height="(\S+)" rx="(\S+)"\/>/g, (m, x, y, w, h, r) => {
    [x, y, w, h, r] = [x, y, w, h, r].map(Number);
    return `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 -${r} ${r}h-${w - 2 * r}a${r} ${r} 0 0 1 -${r} -${r}v-${h - 2 * r}a${r} ${r} 0 0 1 ${r} -${r}z`;
  }).replace(/<circle cx="(\S+)" cy="(\S+)" r="(\S+)"\/>/g, (m, x, y, r) => `M${+x - +r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 -${2 * r} 0z`).replace(/<path d="([^"]+)"\/>/g, "$1 ");

  /* The still: a calm white dial. Used for reduced motion and no JavaScript. */
  const R0 = 250, R1 = 480, r0 = 128, r1 = 236, HUB = 116, GAP = 7, RC = 10;
  const sector = (a, b, c, d, gap) => {
    const g = gap / 2 + RC, X = b - RC, Y = a + RC, dx = (g / X) / RAD, dy = (g / Y) / RAD;
    const P1 = pt(X, c + dx), P2 = pt(X, d - dx), P3 = pt(Y, d - dy), P4 = pt(Y, c + dy);
    return `M${P1}A${X} ${X} 0 0 1 ${P2}L${P3}A${Y} ${Y} 0 0 0 ${P4}Z`;
  };
  const lines2 = (t) => (t.length > 9 ? t.replace(/ (?=\S+$)/, "\n").split("\n") : [t]);
  const piece = (d, i, A, B, step, inner) => {
    const a = -90 + i * step, s = sector(A, B, a - step / 2, a + step / 2, GAP), c = pt((A + B) / 2 + (inner ? 0 : 4), a);
    return `<path class="rfw-ln" d="${s}"/><path class="rfw-w${i % 2 ? " g" : ""}" d="${s}"/><g class="rfw-up" transform="translate(${c[0]} ${c[1]})"><g class="${inner ? "rfw-i2w" : "rfw-icw"}"><g class="rfw-ic" transform="translate(-24 -24)">${ICON[d.k]}</g></g>${inner ? "" : `<text class="rfw-lb" y="${lines2(d.t).length > 1 ? 46 : 54}">${lines2(d.t).map((l, j) => `<tspan x="0"${j ? ' dy="31"' : ""}>${l}</tspan>`).join("")}</text>`}</g>`;
  };
  const dial = () => `<svg class="rfw-svg" viewBox="-520 -520 1040 1040" role="img" aria-label="The RouteFlow wheel: ${OUTER.map((d) => d.t.toLowerCase()).join(", ")}, around ${INNER.map((d) => d.t.toLowerCase()).join(", ")}, all one system.">${OUTER.map((d, i) => piece(d, i, R0, R1, STEP_O)).join("")}${INNER.map((d, i) => piece(d, i, r0, r1, 72, 1)).join("")}<circle r="${HUB}" fill="#10264d"/><g transform="translate(-30 -40) scale(.75)"><g class="mk"><path d="M0 96V34a18 18 0 0 1 18-18h56"/><path d="M66 2l14 14l-14 14"/><path d="M26 96V52a8 8 0 0 1 8-8h22a15 15 0 0 1 0 30h-14l24 22"/></g></g></svg>`;

  /* Small pieces of the product, using the labels the product uses. Made-up sample data, one delivery from one supplier. */
  const TK = '<svg class="rfw-tk" viewBox="0 0 20 20" aria-hidden="true"><path pathLength="1" d="M4 10.5l4 4 8-9"/></svg>';
  const num = (a, b, f) => `<span data-from="${a}" data-to="${b}" data-f="${f}">${f === "u" ? usd(b) : int(b)}</span>`;
  const hd = (a, b, p, was) => `<div class="rfw-hd"><div class="rfw-id"><b>${a}</b><span>${b}</span></div>${p ? `<span class="rfw-pill"${was ? ` data-was="${was}"` : ""}>${p}</span>` : ""}</div>`;
  const row = (n, q, m, c) => `<div class="rfw-row${c ? " " + c : ""}" data-r><span class="n">${n}</span>${q ? `<span class="q">${q}</span>` : ""}${m != null ? `<span class="m">${m}</span>` : ""}</div>`;
  const CARD = {
    orders: hd("ORD-01042", "Corner Market", "Confirmed", "Pending") + row("Sparkling water", "2 boxes + 6 pcs", "$45.00") + row("Spring water", "3 boxes", "$36.00") + row("Mixed nuts", "1 box", "$30.00") + row("Total", "", "$111.00", "t"),
    inventory: hd("Bottled water", "In stock") + `<div class="rfw-big" data-r>${num(88, 128, "i")}<small>boxes</small></div>` + row("Stock Value (cost)", "", num(1584, 2304, "u")),
    payments: hd("INV-2026-0147", "Lake Mart", "Paid", "Sent") + row("Check", "Nov 10, 2026", "$163.80") + row("Payments received", "", "$163.80") + row("Balance due", "", "$0.00", "t"),
  };

  /* The one object, drawn from one isometric projection: the order, then the goods on the shelf, then the check. */
  const iso = (x, y, z) => [f2((x - y) * 0.866), f2((x + y) * 0.5 - (z || 0))];
  const BOX = ["#fcd9aa", "#f3ba76", "#dd9b57"], PAPER = ["#ffffff", "#e3e9f4", "#c4d0e4"];
  const Rc = (x, y, w, h, r, f, a) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${f}"${a ? " " + a : ""}/>`;
  const Gp = (s, a) => `<g${a ? " " + a : ""}>${s}</g>`;
  const Ci = (x, y, r, f) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${f}"/>`;
  const Ln = (d, c, w) => `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
  const poly = (p, f) => `<path d="M${p.map((q) => q.join(" ")).join("L")}Z" fill="${f}" stroke="${f}" stroke-width="1.6" stroke-linejoin="round"/>`;
  const cube = (x, y, z, w, d, h, c) => {
    const A = iso(x, y, z + h), B = iso(x + w, y, z + h), C = iso(x + w, y + d, z + h), D = iso(x, y + d, z + h), E = iso(x + w, y + d, z), F = iso(x, y + d, z), H = iso(x + w, y, z);
    return poly([D, C, E, F], c[1]) + poly([C, B, H, E], c[2]) + poly([A, B, C, D], c[0]);
  };
  const face = {
    top: (x, y, z, s) => `<g transform="matrix(.866 .5 -.866 .5 ${iso(x, y, z).join(" ")})">${s}</g>`,
    left: (x, y, z, s) => `<g transform="matrix(.866 .5 0 1 ${iso(x, y, z).join(" ")})">${s}</g>`,
    right: (x, y, z, s) => `<g transform="matrix(.866 -.5 0 1 ${iso(x, y, z).join(" ")})">${s}</g>`,
  };
  const shadow = (x, y, w, d, o, z) => face.top(x, y, z || 0, `<rect x="${f2(-w * 0.14)}" y="${f2(-d * 0.14)}" width="${f2(w * 1.28)}" height="${f2(d * 1.28)}" fill="url(#rfwsd)" opacity="${o || 0.9}"/>`);
  const slab = (x, y, z, w, d, h, rx, top, side) => face.top(x, y, z, Rc(0, 0, w, d, rx, side)) + face.top(x, y, z + h / 2, Rc(0, 0, w, d, rx, side)) + face.top(x, y, z + h, Rc(0, 0, w, d, rx, top));
  const carton = (x, y, z, s, a) => {
    const h = s * 0.84, m = s * 0.42, n = s * 0.16, tp = z + h;
    return Gp(cube(x, y, z, s, s, h, BOX) + poly([iso(x + m, y, tp), iso(x + m + n, y, tp), iso(x + m + n, y + s, tp), iso(x + m, y + s, tp)], "#2b4c88") +
      poly([iso(x + m, y + s, tp), iso(x + m + n, y + s, tp), iso(x + m + n, y + s, z + h * 0.62), iso(x + m, y + s, z + h * 0.62)], "#2b4c88"), a);
  };
  /* One soft neutral contact shadow under each form, drawn once into the object's own picture. */
  const DEFS = '<svg class="rfw-defs" width="0" height="0" aria-hidden="true"><defs><radialGradient id="rfwsd"><stop offset=".34" stop-color="#0f1b2d" stop-opacity=".34"/><stop offset=".72" stop-color="#0f1b2d" stop-opacity=".14"/><stop offset="1" stop-color="#0f1b2d" stop-opacity="0"/></radialGradient></defs></svg>';
  const FORMS = [
    shadow(-44, -56, 88, 112) + slab(-42, -54, 0, 84, 108, 5, 5, "#fff", "#cfdaec") + face.top(-42, -54, 5, Rc(10, 12, 40, 7, 3.5, "#2b4c88") + Rc(10, 30, 64, 5, 2.5, "#dfe6f2") + Rc(10, 42, 64, 5, 2.5, "#dfe6f2") + Rc(10, 54, 64, 5, 2.5, "#dfe6f2") + Rc(44, 78, 30, 12, 6, "#e56a5d")),
    shadow(-56, -30, 112, 58, 0.8) + carton(-52, -26, 0, 50) + carton(2, -26, 0, 50) + carton(-26, -26, 42, 50),
    shadow(-62, -32, 124, 64) + slab(-60, -30, 0, 120, 60, 5, 5, "#ecfdf5", "#a7f3d0") + face.top(-60, -30, 5, Rc(10, 10, 46, 6, 3, "#059669") + Rc(10, 24, 72, 4, 2, "#a7f3d0") + Rc(10, 36, 52, 4, 2, "#a7f3d0") + Ci(100, 30, 11, "#14c98f") + Ln("M95 30l3.6 3.6l6.4 -7", "#fff", 2.4)),
  ];
  const tokenSVG = `<svg viewBox="-90 -115 180 160" aria-hidden="true">${FORMS.map((f) => `<g class="rfw-f">${f}</g>`).join("")}</svg>`;
  const li = (d, o) => `<li${o ? ' class="o"' : ""}>${d.t}<span>${d.s}${d.n ? ` ${d.n}.` : ""}</span></li>`;
  const staticHTML = () => `<div class="rfw-pin"><div class="rfw-wheel">${dial()}</div><div class="rfw-stage"><h2 class="rfw-title">${HERO[1].t}</h2><p class="rfw-sub">${HERO[0].s} ${HERO[1].s}</p><p class="rfw-keyh">${EYE_O}</p><ul class="rfw-keys">${OUTER.map((d) => li(d, 1)).join("")}</ul><p class="rfw-keyh">${EYE_I}</p><ul class="rfw-keys">${INNER.map((d) => li(d)).join("")}</ul></div></div>`;
  const stopHTML = (d) => `<div class="rfw-s"><div class="rfw-t" style="--pc:${d.c}"><p class="rfw-eye">${INNER.includes(d) ? EYE_I : EYE_O}</p><p class="rfw-title">${d.t}</p><p class="rfw-sub">${d.s}</p></div><div class="rfw-card" style="--acc:var(--rf-${d.a})" role="img" aria-label="Illustration with sample data: ${d.t}.">${CARD[d.k]}</div></div>`;
  const liveHTML = () => `${DEFS}<div class="rfw-pin"><div class="rfw-tile"><div class="rfw-cvw"><canvas class="rfw-cv" aria-hidden="true"></canvas></div>` +
    `<div class="rfw-wheel" role="group" aria-label="The RouteFlow wheel. Use the arrow keys to look at each piece. Press Enter to go to it.">${ALL.map((d, i) => `<button type="button" class="rfw-b" data-i="${i}" tabindex="${i ? -1 : 0}" aria-pressed="false" aria-label="${d.t}: ${d.s}${d.n ? ` ${d.n}.` : ""}"></button>`).join("")}</div>` +
    `<div class="rfw-tok" aria-hidden="true">${tokenSVG}</div><div class="rfw-tip" aria-hidden="true"></div>` +
    `<div class="rfw-words"><p class="rfw-hint">${HINT}</p>${HERO.map((h, i) => `<div class="rfw-h h${i}">${i ? `<h2 class="rfw-title">${h.t}</h2>` : `<p class="rfw-title">${h.t}</p>`}<p class="rfw-sub">${h.s}</p></div>`).join("")}` +
    `</div>` +
    `</div></div><ol class="rfw-list">${ALL.map((d) => li(d)).join("")}</ol>`;
  const forced = () => !!(root.location && /[?&]motion=on(&|$)/.test(root.location.search));

  /* A stop's act: its screen card rises as one piece, then the one thing that matters on it happens. No bounce anywhere. */
  function act(g, card, d) {
    const q = (s) => Array.from(card.querySelectorAll(s));
    const tl = g.timeline({ defaults: { ease: "power3.out", duration: 0.5 } });
    tl.fromTo(card, { y: 22, opacity: 0 }, { y: 0, opacity: 1, duration: 0.7 }, 0);
    const tk = q(".rfw-tk path");
    if (tk.length) tl.fromTo(tk, { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 0.36, ease: "power2.inOut", stagger: 0.14 }, 0.48);
    q("[data-to]").forEach((e) => {
      const fmt = e.dataset.f === "u" ? usd : int, a = +e.dataset.from, b = +e.dataset.to, p = { v: a };
      let shown = fmt(a);
      e.textContent = shown;
      tl.to(p, { v: b, duration: 0.95, ease: "power2.inOut", onUpdate: () => { const v = fmt(p.v); if (v !== shown) { shown = v; e.textContent = v; } } }, 0.5);
    });
    q("[data-was]").forEach((p) => {
      const fin = p.textContent, was = p.dataset.was, o = { v: 0 }, set = () => { const on = o.v > 0.5; p.textContent = on ? fin : was; p.classList.toggle("was", !on); };
      set();
      tl.to(o, { v: 1, duration: 0.04, ease: "none", onUpdate: set }, 1.3);
    });
    return tl;
  }

  /* A real outline with rounded corners, so plates need no stroke to look soft. */
  const outline = (A, B, c, d, gap) => {
    const g = gap / 2 + RC, X = B - RC, Y = A + RC, o = g / X, q = g / Y, P = [], a0 = c + o, a1 = d - o, b0 = c + q, b1 = d - q, n = Math.ceil((d - c) / (4 * RAD));
    const cor = (r, a, s, e) => { const x = r * Math.cos(a), y = r * Math.sin(a); for (let j = 0; j <= 3; j++) { const t = s + ((e - s) * j) / 3; P.push(x + RC * Math.cos(t), y + RC * Math.sin(t)); } };
    for (let j = 0; j <= n; j++) { const t = a0 + ((a1 - a0) * j) / n; P.push(B * Math.cos(t), B * Math.sin(t)); }
    cor(X, a1, a1, d + PI / 2);
    cor(Y, b1, d + PI / 2, b1 + PI);
    for (let j = 0; j <= n; j++) { const t = b1 + ((b0 - b1) * j) / n; P.push(A * Math.cos(t), A * Math.sin(t)); }
    cor(Y, b0, b0 + PI, c + 1.5 * PI);
    cor(X, a0, c + 1.5 * PI, a0 + TAU);
    return { pts: new Float32Array(P), rim: n + 1 };
  };
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const css = (c, al) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${al == null ? 1 : +al.toFixed(3)})`;
  const WHITE = [255, 255, 255], INK = [15, 27, 45], NVY = hex("#10264d"), HUBW = hex("#0a1a38");
  const NEU = [WHITE, hex("#fafafc")], WNEU = hex("#d6dee8"), MUTE = hex("#e2e8f0"), MUTEW = hex("#d6dee8");
  const THO = 40, THI = 34, THH = 58, DEPTH = 2000, FS = 46, FSI = 62, LF = 48, RT = 418, TOKW = 150, TILT = 68, YC = -260, HUB_R = 0.62, AIR = 90, DRIFT = 0.05, PITCH = 0.5, REST = 0.05;
  /* How the wheel comes apart. Every piece leaves straight out from the centre (EX, in wheel units), the layers part in
     height (POSE), and the camera angle never changes once it is apart. */
  const EXD = { o: 190, i: 104 }, EXP = { o: 92, i: 52 }, NOTE_K = 0.42;
  const POSE_D = { apart: { zO: -160, zI: 350, zH: 620 }, story: { zO: -170, zI: 390, zH: 720 } };
  const POSE_P = { apart: { zO: -200, zI: 400, zH: 800 }, story: { zO: -170, zI: 300, zH: 680 } };
  /* The story on one playhead, mapped evenly to scroll from the top of the page: the come-apart, every piece named, a few stops,
     the way home. Each label sits in the middle of its hold. The phone has less scroll for each unit, so a stop spends more units
     and keeps about the same room to read. The ring makes one whole turn on the way: the first stop is near where it lands. */
  const T_OPEN = 6.7, T_APART = 7.7, T_SEEN = 8.3;
  const TURN = [72, 108, 288];
  const planOf = (phone) => {
    const STOP = phone ? 2 : 1.6, H = STOP / 2, S0 = T_SEEN + 1 + H, stopAt = (i) => S0 + i * STOP, C0 = stopAt(STORY.length - 1) + H, END = C0 + 4.5;
    return { STOP, H, S0, stopAt, C0, END, BEATS: [[0, "rest"], [T_APART, "apart"]].concat(STORY.map((d, i) => [f2(stopAt(i)), d.k]), [[f2(END - 0.3), "one"]]) };
  };
  /* Weight: a piece starts slowly, flies, then settles over a long tail. The way home is the same curve run backward. */
  const HEAVY = (t) => { const a = clamp(0, 1, t / 0.55); return (1 - Math.pow(1 - t, 2.2)) * a * a * (3 - 2 * a); };
  const HOME = (t) => 1 - HEAVY(1 - t);

  const idle = (f, ms) => (root.requestIdleCallback ? root.requestIdleCallback(f, { timeout: ms || 1500 }) : setTimeout(f, ms ? 200 : 60));
  const unidle = (id) => (root.cancelIdleCallback ? root.cancelIdleCallback(id) : clearTimeout(id));
  let registered = false;
  function mount(el, opts) {
    if (el._rfw) return el._rfw;
    opts = opts || {};
    const g = root.gsap, ST = root.ScrollTrigger, html = document.documentElement;
    const saved = { html: el.innerHTML, cls: el.getAttribute("class") || "" };
    /* Keep the stage clear of a sticky page header, unless the page sets --rfw-top or opts.top itself. */
    const pageTop = getComputedStyle(el).getPropertyValue("--rfw-top").trim();
    const headerTop = () => {
      if (opts.top != null) { el.style.setProperty("--rfw-top", +opts.top + "px"); return; }
      if (pageTop) return;
      const h = document.querySelector("body > header, header.site-header, [role=banner]"), cs = h && getComputedStyle(h);
      const v = cs && (cs.position === "sticky" || cs.position === "fixed") && Math.abs(parseFloat(cs.top) || 0) < 1 ? h.offsetHeight : 0;
      el.style.setProperty("--rfw-top", v + "px");
    };
    const can = !!(g && ST && g.matchMedia && root.Path2D && root.ResizeObserver);
    let mm = null, rm = html.classList.contains("rm"), dead = false;
    const inst = (el._rfw = { el, live: false, beats: planOf(false).BEATS.map((b) => b.slice()), destroy });
    el.classList.add("rfw");
    const still = () => { settled(); const tall = el.classList.contains("rfw-wait"); el.classList.add("rfw--static"); el.classList.remove("rfw-live", "rfw-wait"); el.innerHTML = staticHTML(); inst.live = false; if (tall && ST) Promise.resolve().then(() => ST.refresh()); };
    const start = () => {
      if (!can) return still();
      if (!registered) { g.registerPlugin(ST); registered = true; }
      /* One matchMedia owns every tween, trigger and listener; a change of width class, motion setting or the site's
         Reduce motion switch reverts all of it and builds again. ?motion=on keeps it live for a review. */
      mm = g.matchMedia(el);
      mm.add({ wide: "(min-width: 900px)", narrow: "(max-width: 899.98px)", reduce: "(prefers-reduced-motion: reduce)", short: "(max-height: 499.98px)" }, (c) => {
        if (c.conditions.short || (!forced() && (c.conditions.reduce || html.classList.contains("rm")))) { still(); return undefined; }
        return live(g, ST, el, inst, !c.conditions.wide, opts, c, { headerTop, pageTop, settled, slices: () => slow && !inst.built });
      });
    };
    /* opts.lazy: the section's height is reserved now, so nothing below it ever shifts. The build waits for an idle moment
       after load and runs in small idle slices. If the visitor comes within reach first, whatever is left runs at once. */
    let waiting = false, slow = false, io = null, idleId = 0;
    const kick = () => { idleId = idle(begin, 2500); };
    const begin = () => { if (idleId) { unidle(idleId); idleId = 0; } if (waiting) { waiting = false; start(); } };
    const settled = () => {
      waiting = false;
      if (io) { io.disconnect(); io = null; }
      root.removeEventListener("load", kick);
      if (idleId) { unidle(idleId); idleId = 0; }
    };
    inst.build = () => { begin(); if (inst.flush) inst.flush(); };
    const wait = () => {
      waiting = slow = true;
      el.classList.add("rfw-wait");
      headerTop();
      io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) inst.build(); }, { rootMargin: "150% 0px" });
      io.observe(el);
      if (document.readyState === "complete") kick(); else root.addEventListener("load", kick);
    };
    const watch = root.MutationObserver && new MutationObserver(() => {
      const now = html.classList.contains("rm");
      if (now === rm || dead) return;
      rm = now;
      settled();
      slow = false;
      if (mm) mm.revert();
      start();
    });
    if (watch) watch.observe(html, { attributes: true, attributeFilter: ["class"] });
    function destroy() {
      if (dead) return;
      dead = true;
      settled();
      if (watch) watch.disconnect();
      if (mm) mm.revert();
      el.innerHTML = saved.html;
      el.setAttribute("class", saved.cls);
      el.style.removeProperty("--rfw-top");
      el._rfw = null;
    }
    const liveWanted = can && (forced() || !(rm || root.matchMedia("(prefers-reduced-motion: reduce)").matches));
    const far = () => { const r = el.getBoundingClientRect(), h = root.innerHeight; return r.top > 2.5 * h || r.bottom < -1.5 * h; };
    if (opts.lazy && liveWanted && root.IntersectionObserver && far()) wait(); else start();
    return inst;
  }

  function live(g, ST, el, inst, phone, opts, mctx, site) {
    const { headerTop, pageTop, settled, slices } = site;
    const ends = () => el.getBoundingClientRect().bottom + root.scrollY, held0 = ends();
    headerTop();
    el.classList.remove("rfw--static", "rfw-wait");
    el.classList.add("rfw-live");
    el.innerHTML = liveHTML();
    const html = document.documentElement, $ = (s) => el.querySelector(s), $$ = (s) => Array.from(el.querySelectorAll(s));
    const pin = $(".rfw-pin"), tile = $(".rfw-tile"), cvw = $(".rfw-cvw"), cv = $(".rfw-cv"), ctx = cv.getContext("2d", { alpha: false }), tok = $(".rfw-tok"), tip = $(".rfw-tip"), wheelBox = $(".rfw-wheel");
    const words = $(".rfw-words"), hx = $$(".rfw-h"), hint = $(".rfw-hint"), stops = [], tx_ = [], cards = [], fm = $$(".rfw-f"), btns = $$(".rfw-b");
    const copySel = opts.copy || el.dataset.copy, copy = copySel ? document.querySelector(copySel) : null;
    const hcMQ = root.matchMedia("(prefers-contrast: more)");

    /* Everything the timeline moves is a unitless weight; the camera reads the fitted framing at draw time,
       so a resize re-fits without re-recording a single tween. */
    const S = { wA: 0, wL: 0, wS: 0, wE: 0, lO: 0, lI: 0, lH: 0, hO: 0, hI: 0, hH: 0, dr: 0, spO: 0, spI: 0, u: ALL.indexOf(STORY[0]), hop: 0, fall: 1, obj: 0, focO: 0, rip: 0 };
    const P = ALL.map(() => ({ w: 0, h: 0, e: 0, c: 0, n: 0 }));
    const EX = phone ? EXP : EXD, POSE = Object.assign({}, phone ? POSE_P : POSE_D), { STOP, H: HOLD, S0, stopAt, C0, END, BEATS } = planOf(phone);
    inst.beats = BEATS.map((b) => b.slice());
    const WD = ALL.map((d, i) => {
      const o = i < NO, step = o ? STEP_O : 72, ca = (-90 + (o ? i : i - NO) * step) * RAD, hs = (step / 2) * RAD, L = outline(o ? R0 : r0, o ? R1 : r1, ca - hs, ca + hs, GAP);
      return { i, d, o, ca, pts: L.pts, n: L.pts.length / 2, rim: L.rim, mid: o ? (R0 + R1) / 2 + 4 : (r0 + r1) / 2, ic: new Path2D(icd(ICON[d.k])), col: hex(d.c), wall: hex(d.w), ink: o ? hex(d.i) : WHITE, neu: NEU[i % 2], jit: Math.sin(i * 2.4) * (o ? 44 : 30), rank: Math.floor(Math.abs(mod((-90 + (o ? i : i - NO) * step) - 90 + 180, 360) - 180) / step), lines: lines2(d.t) };
    });
    const OW = WD.slice(0, NO), IW = WD.slice(NO), HC = new Float32Array(96), ord = [];
    for (let j = 0; j < 48; j++) { const a = (j / 48) * TAU; HC[2 * j] = HUB * Math.cos(a); HC[2 * j + 1] = HUB * Math.sin(a); }
    const MARKP = new Path2D("M0 96V34a18 18 0 0 1 18-18h56M66 2l14 14l-14 14M26 96V52a8 8 0 0 1 8-8h22a15 15 0 0 1 0 30h-14l24 22");
    const tx = new Float32Array(80), ty = new Float32Array(80), bx = new Float32Array(80), by = new Float32Array(80);
    /* Soft neutral shadows are two sprites drawn once; each frame only places them. */
    const sprite = (fn) => {
      const c = document.createElement("canvas"), x = c.getContext("2d"), G = x.createRadialGradient(128, 128, 0, 128, 128, 128);
      c.width = c.height = 256;
      for (let j = 0; j <= 24; j++) G.addColorStop(j / 24, `rgba(15,27,45,${fn(j / 24).toFixed(3)})`);
      x.fillStyle = G; x.fillRect(0, 0, 256, 256);
      return c;
    };
    const smooth = (a, b, t) => { const v = clamp(0, 1, (t - a) / (b - a)); return v * v * (3 - 2 * v); };
    const DISC = sprite((t) => Math.pow(1 - smooth(0.5, 1, t), 1.5));
    const RING = sprite((t) => smooth(0.2, 0.62, t) * Math.pow(1 - smooth(0.72, 1, t), 1.5));
    const FLOOR = sprite((t) => smooth(0.42, 0.52, t) * Math.pow(1 - smooth(0.74, 1, t), 1.5));

    let dpr = 1, K = 1, cx = 0, cy = 0, ct = 1, st = 0, px = 0, py = 0, pp = 1, dirty = true, focusI = -1, hc = false, pinTop = 0, tokPx = 120, ox = 0, oy = 0, stageBg = "#f5f5f7";
    const F = { flat: { k: 0.4, x: 0, y: 0 }, end: { k: 0.4, x: 0, y: 0 }, burst: { k: 0.4, x: 0, y: 0 }, apart: { k: 0.4, x: 0, y: 0 }, story: { k: 0.4, x: 0, y: 0 } };
    const cam = { tilt: 0, zO: 0, zI: 0, zH: 0, k: 0.4, x: 0, y: 0 };
    const mark = () => { dirty = true; };
    const KEYS = Object.keys(S), VAL = new Float64Array(KEYS.length + 2 + ALL.length * 5);
    let force = true;
    const unchanged = () => {
      let i = 0, same = true;
      const put = (v) => { if (VAL[i] !== v) { VAL[i] = v; same = false; } i++; };
      for (let j = 0; j < KEYS.length; j++) put(S[KEYS[j]]);
      put(Sp.o.x); put(Sp.i.x);
      for (let j = 0; j < P.length; j++) { const p = P[j]; put(p.w); put(p.h); put(p.e); put(p.c); put(p.n); }
      return same;
    };
    const proj = (x, y, z) => { const Y = y * ct - z * st, Z = y * st + z * ct; pp = DEPTH / (DEPTH - Z); px = cx + K * x * pp; py = cy + K * ((Y - YC) * pp + YC); };
    const unproj = (mx, my, z) => { const dx = (mx - cx) / K, dy = (my - cy) / K, E = dy - YC, y = (DEPTH * dy + z * (DEPTH * st - E * ct)) / (DEPTH * ct + E * st), p = DEPTH / (DEPTH - y * st - z * ct); return [dx / p, y]; };
    const rot = (pts, n, cs, sn, ox, oy, z, X, Y, q, ux, uy, m) => { for (let j = 0; j < n; j++) { const a = pts[2 * j], b = pts[2 * j + 1], x = (a * cs - b * sn) * rg, y = (a * sn + b * cs) * rg * ry; proj(x + ox, y + oy, q ? z - q * (x * ux + y * uy - m) : z); X[j] = px; Y[j] = py; } };
    let rg = 1, ry = 1;
    const trace = (X, Y, n) => { ctx.moveTo(X[0], Y[0]); for (let j = 1; j < n; j++) ctx.lineTo(X[j], Y[j]); ctx.closePath(); };
    const walls = (n, fill) => {
      if (st < 0.02) return;
      ctx.fillStyle = fill;
      ctx.beginPath();
      for (let j = 0; j < n; j++) { const k = j + 1 === n ? 0 : j + 1; if ((tx[k] - tx[j]) * (by[j] - ty[j]) - (ty[k] - ty[j]) * (bx[j] - tx[j]) < 0) { ctx.moveTo(tx[k], ty[k]); ctx.lineTo(tx[j], ty[j]); ctx.lineTo(bx[j], by[j]); ctx.lineTo(bx[k], by[k]); ctx.closePath(); } }
      ctx.fill();
    };
    const shade = (c, spr, x, y, z, R, a) => {
      if (a < 0.004) return;
      proj(x, y, z);
      const sx = K * pp * R, sy = sx * Math.max(ct, 0.06);
      c.globalAlpha = a; c.drawImage(spr, px - sx, py - sy, 2 * sx, 2 * sy); c.globalAlpha = 1;
    };
    /* The stage and the large soft shadows change only when the camera or the layers move. While they move, they are drawn
       straight onto the frame. Once they hold still they wait in their own picture, and while the ring turns each frame
       just copies back the part of it the wheel can touch; the rest of the canvas is already right. The shadows are so faint
       that plain sampling looks the same as smooth sampling, at a fraction of the cost. */
    const fc = document.createElement("canvas"), fctx = fc.getContext("2d", { alpha: false }), FK = new Float64Array(8), CL = [0, 0, 0, 0];
    let held = 0, cached = false, whole = true;
    const stage = (c, zo, zi, zh, W, H, ea) => {
      c.fillStyle = stageBg; c.fillRect(0, 0, W, H);
      const lift = cam.tilt / TILT, fl = zo - 1 - AIR * lift, gi = zi - fl, gh = zh - fl;
      shade(c, FLOOR, 0, 14 + 12 * lift, fl, (R1 + EX.o * ea) * 1.2, (0.1 + 0.05 * lift) * (1 - ea));
      shade(c, RING, 0, 10 + gi * 0.05, fl, (r1 + EX.i * ea) * (1.12 + gi * 0.0005), 0.1 * clamp(0, 1, gi / 60) * (1 - 0.6 * ea) * (1 - clamp(0, 1, gi / 1500)));
      shade(c, DISC, 0, 8 + gh * 0.05, fl, HUB * (1.5 + gh * 0.001), 0.1 * clamp(0, 1, gh / 60) * (1 - 0.6 * ea) * (1 - clamp(0, 1, gh / 1800)));
    };
    const floor = (zo, zi, zh, W, H, ea) => {
      if (!(FK[0] === K && FK[1] === cx && FK[2] === cy && FK[3] === ct && FK[4] === zo && FK[5] === zi && FK[6] === zh && FK[7] === ea)) {
        FK[0] = K; FK[1] = cx; FK[2] = cy; FK[3] = ct; FK[4] = zo; FK[5] = zi; FK[6] = zh; FK[7] = ea;
        held = 0; cached = false;
      }
      if (!cached && held++ < 1) { stage(ctx, zo, zi, zh, W, H, ea); whole = true; return; }
      if (!cached) {
        if (fc.width !== W || fc.height !== H) { fc.width = W; fc.height = H; fctx.imageSmoothingEnabled = false; }
        stage(fctx, zo, zi, zh, W, H, ea);
        cached = true; whole = true;
        /* What a turning ring can touch: the wheel, plus the reach of a lifted piece's soft shadow. */
        const b = bboxOf(cam.tilt, zo, zi, zh, EX.o * ea * (1 + DRIFT), EX.i * ea * (1 + DRIFT)), m = 240 * K, x0 = Math.max(0, Math.floor(cx + K * b.x0 - m)), y0 = Math.max(0, Math.floor(cy + K * b.y0 - m * ct));
        CL[0] = x0; CL[1] = y0; CL[2] = Math.min(W, Math.ceil(cx + K * b.x1 + m)) - x0; CL[3] = Math.min(H, Math.ceil(cy + K * b.y1 + m * ct)) - y0;
      }
      if (whole || CL[2] < 1 || CL[3] < 1) ctx.drawImage(fc, 0, 0);
      else ctx.drawImage(fc, CL[0], CL[1], CL[2], CL[3], CL[0], CL[1], CL[2], CL[3]);
      whole = false;
    };
    /* The layers leave and come home one at a time. The camera goes from the hero to centre stage, then makes room for the words,
       and home to where the last words leave it room. */
    const pose = () => {
      const A = POSE.apart, B = POSE.story, s = S.wS, e = S.wE, l = S.wL;
      cam.zO = lerp(lerp(lerp(0, A.zO, S.lO), B.zO, s), 0, S.hO);
      cam.zI = lerp(lerp(lerp(0, A.zI, S.lI), B.zI, s), 0, S.hI);
      cam.zH = lerp(lerp(lerp(0, A.zH, S.lH), B.zH, s), 0, S.hH);
      const m = S.wA * (1 - e), M = F.burst, L = F.apart, G = F.story, R = F.flat, N = F.end;
      cam.tilt = TILT * m;
      cam.k = lerp(lerp(R.k, N.k, e), lerp(lerp(M.k, L.k, l), G.k, s), m); cam.x = lerp(lerp(R.x, N.x, e), lerp(lerp(M.x, L.x, l), G.x, s), m); cam.y = lerp(lerp(R.y, N.y, e), lerp(lerp(M.y, L.y, l), G.y, s), m);
    };
    const plates = (list, spin, zB, th, outer) => {
      const cs = Math.cos(spin), sn = Math.sin(spin), flat = 1 - clamp(0, 1, cam.tilt / 22), far = (outer ? EX.o : EX.i) * (1 + DRIFT * S.dr);
      ord.length = 0;
      for (const w of list) ord.push(w);
      ord.sort((a, b) => Math.sin(a.ca + spin) * st * R1 + (P[a.i].w + P[a.i].h) * 300 - Math.sin(b.ca + spin) * st * R1 - (P[b.i].w + P[b.i].h) * 300);
      for (const w of ord) {
        const p = P[w.i], lift = Math.max(p.w, p.h * 0.6), e = p.e, a = w.ca + spin, ux = Math.cos(a), uy = Math.sin(a), sl = (lift * (outer ? FS : FSI) + e * far) * rg, b = e > 0 ? 4 * e * (1 - e) : 0, zT = zB + th + lift * LF + b * w.jit, q = b * PITCH + (e > 0 ? e : 0) * REST, n = w.n;
        rot(w.pts, n, cs, sn, ux * sl, uy * sl, zT, tx, ty, q, ux, uy, w.mid * rg); rot(w.pts, n, cs, sn, ux * sl, uy * sl, zT - th, bx, by, q, ux, uy, w.mid * rg);
        /* Neutral at rest, its own colour when apart; softened toward a light neutral while another piece has the stage. */
        const m = outer ? S.focO * (1 - lift) * 0.34 : S.focO * 0.2;
        let f = mix(w.neu, w.col, p.c), wl = mix(WNEU, w.wall, p.c);
        if (m > 0.001) { f = mix(f, MUTE, m * p.c); wl = mix(wl, MUTEW, m * p.c); }
        walls(n, css(wl));
        ctx.beginPath(); trace(tx, ty, n); ctx.fillStyle = css(f); ctx.fill();
        const edge = hc ? 0.55 : 0.08 * (1 - p.c);
        if (edge > 0.01) { ctx.lineWidth = dpr; ctx.strokeStyle = css(INK, edge); ctx.stroke(); }
        if (p.c > 0.02 && st > 0.05 && m < 0.5) { ctx.beginPath(); ctx.moveTo(tx[0], ty[0]); for (let j = 1; j < w.rim; j++) ctx.lineTo(tx[j], ty[j]); ctx.lineJoin = "miter"; ctx.lineWidth = 1.25 * dpr; ctx.strokeStyle = css(WHITE, 0.42 * p.c * (1 - m)); ctx.stroke(); }
        if (focusI === w.i) { ctx.beginPath(); trace(tx, ty, n); ctx.lineWidth = 3 * dpr; ctx.strokeStyle = "#2b4c88"; ctx.stroke(); }
        /* Words stay upright and readable; only the plate tilts. The piece the object stands on lets it have the spot. */
        const vis = (outer ? 1 - S.obj * p.w : 1) * (1 - m * 0.55);
        if (vis > 0.03) {
          proj(ux * (w.mid * rg + sl), uy * (w.mid * rg + sl), zT);
          const sc = K * pp, ax = px, ay = py, sq = 0.62 + 0.38 * ct, size = (sc / dpr) * 31, nk = Math.max(phone ? sc * 1.22 : sc, ((phone ? 13 : 10.5) * dpr) / 31), nq = phone ? 0.9 : sq;
          /* A piece's name: on the plate at rest, then back on it in the air as it comes off. A daily-work plate is big enough to
             carry its name. A core plate is not, so its name hangs in the clear air beside it. The names keep a readable size
             whatever the plate's. At the stops one piece is featured, so the rest carry their icons and no words. */
          const name = outer ? Math.max(!phone && size >= 13 ? flat : 0, p.n) : p.n;
          ctx.fillStyle = ctx.strokeStyle = css(mix(INK, w.ink, p.c));
          if (name > 0.01) {
            ctx.globalAlpha = vis * name;
            if (outer) {
              const two = w.lines.length > 1, note = w.d.n && p.n > 0.01, y0 = p.n > 0.01 ? 12 - (two ? 16 : 0) - (note && noteTwo ? 24 : 0) : 54 - (two ? 8 : 0);
              ctx.setTransform(nk, 0, 0, nk * nq, ax, ay);
              for (let j = 0; j < w.lines.length; j++) ctx.fillText(w.lines[j], 0, y0 + j * 31);
              if (note) { const m2 = Math.max(phone ? nk * 0.62 : sc * 0.56, ((phone ? 12 : 10) * dpr) / 31), yn = ((y0 + 34) * nk) / m2, ls = noteTwo ? lines2(w.d.n) : [w.d.n]; ctx.setTransform(m2, 0, 0, m2 * nq, ax, ay); for (let j = 0; j < ls.length; j++) ctx.fillText(ls[j], 0, yn + j * 34); }
            } else {
              const side = Math.abs(ux) > 0.7, r = (side || uy < 0 ? r1 : r0) + sl, gap = (phone ? 6 : 12) * dpr, ck = Math.max(phone ? sc * 0.9 : sc * 0.76, ((phone ? 13 : 10.5) * dpr) / 31);
              proj(ux * r, uy * r, zT);
              ctx.textAlign = side ? (ux > 0 ? "left" : "right") : "center";
              ctx.fillStyle = css(INK);
              ctx.setTransform(ck, 0, 0, ck * nq, px + (side ? (ux > 0 ? gap : -gap) : 0), py + (side ? 5 * dpr : -gap));
              const ls = phone && side ? w.lines : [w.d.t];
              for (let j = 0; j < ls.length; j++) ctx.fillText(ls[j], 0, (j - (ls.length - 1) / 2) * 34);
              ctx.textAlign = "center"; ctx.fillStyle = css(mix(INK, w.ink, p.c));
            }
          }
          const is = Math.max(1.25 * sc, (phone ? 0.62 : 0.8) * dpr) * (outer ? 1 : rg + lift * 0.4);
          /* Once it is named, a daily-work plate carries the name alone: its icon would crowd it. */
          ctx.globalAlpha = vis * (outer ? 1 - p.n * (1 - flat) : 1);
          if (ctx.globalAlpha > 0.01) {
            ctx.setTransform(is, 0, 0, is * sq, ax, ay - (outer ? 24 * sc * sq * flat : 0)); ctx.translate(-24, -24);
            ctx.lineWidth = ((outer ? 1.35 : 1.35 + lift * 0.5) * dpr) / is; ctx.lineCap = ctx.lineJoin = "round"; ctx.stroke(w.ic);
          }
          ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1;
        }
      }
    };
    const hub = (z) => {
      const hy = Math.max(1, HUB_R / Math.max(ct, 0.05));
      ry = hy; rot(HC, 48, 1, 0, 0, 0, z + THH, tx, ty); rot(HC, 48, 1, 0, 0, 0, z, bx, by); ry = 1;
      walls(48, css(HUBW));
      ctx.beginPath(); trace(tx, ty, 48); ctx.fillStyle = css(NVY); ctx.fill();
      proj(0, 0, z + THH); const ox = px, oy = py; proj(100, 0, z + THH); const ax = (px - ox) / 100, ay = (py - oy) / 100; proj(0, 100 * hy, z + THH);
      ctx.setTransform(ax, ay, (px - ox) / 100, (py - oy) / 100, ox, oy); ctx.translate(-30, -40); ctx.scale(0.75, 0.75);
      ctx.lineWidth = 13; ctx.lineCap = ctx.lineJoin = "round"; ctx.strokeStyle = "#fff"; ctx.stroke(MARKP);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    };
    /* How far the path has risen with the piece under it, so the line and the object stay on the piece. The step at a
       piece's edge eases in and out (smoothstep), so the line bends as one curve, never a corner. */
    const onWedge = (v) => { const x = mod(v, NO), i = Math.round(x), d = Math.abs(x - i), k = clamp(0, 1, (d - 0.26) / 0.24); return P[i % NO].w * (1 - k * k * (3 - 2 * k)); };
    const draw = () => {
      dirty = false;
      if (unchanged() && !force) return;
      force = false;
      pose();
      const W = cv.width, H = cv.height, t = cam.tilt * RAD;
      ct = Math.cos(t); st = Math.sin(t);
      K = cam.k * dpr; cx = (cam.x - ox) * dpr; cy = (cam.y - oy) * dpr;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const zo = cam.zO, zi = cam.zI, zh = cam.zH, fl = zo - 1 - AIR * (cam.tilt / TILT), far = EX.o * (1 + DRIFT * S.dr);
      let ea = 0;
      for (let j = 0; j < NO; j++) ea += Math.max(0, P[j].e);
      ea /= NO;
      const spo = (S.spO + Sp.o.x) * RAD, spi = (S.spI + Sp.i.x) * RAD;
      /* The stage with the soft neutral shadows the stack casts on the floor, then the soft shadow of the lifted piece. */
      floor(zo, zi, zh, W, H, ea);
      for (const w of OW) { const p = P[w.i], al = Math.max(0.15 * p.w, 0.12 * Math.max(0, p.e)); if (al > 0.006) { const a = w.ca + spo, r = w.mid + p.w * FS + p.e * far; shade(ctx, DISC, r * Math.cos(a), r * Math.sin(a) + 24, fl, 180, al); } }
      plates(OW, spo, zo, THO, true);
      const A = (-90 + S.u * STEP_O) * RAD + spo, tl = onWedge(S.u), lz = tl * LF, tr = RT + tl * FS + far, ax = tr * Math.cos(A), ay = tr * Math.sin(A);
      if (S.obj > 0.01) shade(ctx, DISC, ax, ay + 6, zo + THO + lz, 56 + S.hop * 30 + S.fall * 220, 0.18 * S.obj * Math.min(1, (S.hop + S.fall) * 3) * (1 - S.fall * 0.6));
      plates(IW, spi, zi, THI, false);
      rg = 1;
      hub(zh);
      if (S.rip > 0.001 && S.rip < 0.999) { ctx.beginPath(); for (let j = 0; j <= 96; j++) { const a = (j / 96) * TAU, r = R1 + 14 + S.rip * 110; proj(r * Math.cos(a), r * Math.sin(a), 0); if (j) ctx.lineTo(px, py); else ctx.moveTo(px, py); } ctx.lineWidth = 1.25 * dpr; ctx.strokeStyle = css(NVY, 0.2 * (1 - S.rip)); ctx.stroke(); }
      /* The object lives in the world; it is sized once per layout and only moves here. */
      if (S.obj > 0.01) { proj(ax, ay, zo + THO + lz + S.hop * 70 + S.fall * 520); tok.style.transform = `translate3d(${(px / dpr + ox).toFixed(1)}px,${(py / dpr + oy).toFixed(1)}px,0)`; }
      if (tipI >= 0) { const w = WD[tipI], p = P[tipI], o = w.o, a = w.ca + (o ? spo : spi), l = Math.max(p.w, p.h * 0.6), r = w.mid + l * (o ? FS : FSI) + p.e * (o ? EX.o : EX.i) * (1 + DRIFT * S.dr); proj(r * Math.cos(a), r * Math.sin(a), (o ? zo + THO : zi + THI) + l * LF); tip.style.transform = `translate3d(${(px / dpr + ox).toFixed(1)}px,${(py / dpr + oy - 46 * Math.max(0.6, K / dpr)).toFixed(1)}px,0) translateX(-50%)`; }
    };

    /* Fit: every pose is projected at unit scale and fitted into the box the words and the card leave free. */
    const bboxOf = (tilt, zo, zi, zh, eo, ei) => {
      const t = tilt * RAD, c = Math.cos(t), s = Math.sin(t), lf = tilt ? LF : 0;
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      const add = (x, y, z) => { const Y = y * c - z * s, Z = y * s + z * c, p = DEPTH / (DEPTH - Z), X = x * p, V = (Y - YC) * p + YC; if (X < x0) x0 = X; if (X > x1) x1 = X; if (V < y0) y0 = V; if (V > y1) y1 = V; };
      for (let j = 0; j < 48; j++) {
        const a = (j / 48) * TAU, ca = Math.cos(a), sa = Math.sin(a), r = R1 + (eo || 0) + (tilt ? 8 + FS * Math.max(0, sa) * Math.max(0, sa) : 8), ri = r1 + (ei || 0) + (tilt ? FSI * Math.max(0, sa) * Math.max(0, sa) : 0);
        add(r * ca, r * sa, zo + THO + lf); add(r * ca, r * sa, zo); add(ri * ca, ri * sa, zi + THI + lf); add(HUB * ca, HUB * sa * Math.max(1, HUB_R / Math.max(c, 0.05)), zh + THH);
      }
      return { x0, y0, x1, y1 };
    };
    let noteTwo = false;
    const fitTo = (bb, box, wMax) => {
      const k = Math.min((box.r - box.l) / (bb.x1 - bb.x0), (box.b - box.t) / (bb.y1 - bb.y0), wMax / (bb.x1 - bb.x0));
      return { k, x: (box.l + box.r) / 2 - (k * (bb.x0 + bb.x1)) / 2, y: (box.t + box.b) / 2 - (k * (bb.y0 + bb.y1)) / 2 };
    };
    const bottomOf = (h, e) => h.offsetTop + e.offsetTop + e.offsetHeight;
    const layout = () => {
      headerTop();
      pinTop = parseFloat(getComputedStyle(pin).top) || 0;
      const W = tile.clientWidth, H = tile.clientHeight;
      if (W < 2 || H < 2) return;
      hc = hcMQ.matches;
      const pad = phone ? 14 : Math.round(clamp(28, 56, W * 0.042));
      tile.style.setProperty("--rfw-in", pad + "px");
      const eo = EX.o * (1 + DRIFT), ei = EX.i * (1 + DRIFT), box3 = (k) => bboxOf(TILT, POSE[k].zO, POSE[k].zI, POSE[k].zH, eo, ei);
      const flatBB = bboxOf(0, 0, 0, 0), apartBB = box3("apart"), storyBB = box3("story"), tr = tile.getBoundingClientRect();
      /* Where the hint goes, under the wheel at rest. */
      const hintAt = (show) => { hint.style.display = show ? "" : "none"; hint.style.left = F.flat.x + "px"; hint.style.top = F.flat.y + F.flat.k * flatBB.y1 + (phone ? 6 : 10) + "px"; };
      if (phone) {
        /* The hero's words sit above the stage, in the page. At rest the wheel takes what the first screen shows of the stage, and at
           the end what the last words leave it. A short phone shows the top of it and scrolling brings the rest. */
        const elTop = el.getBoundingClientRect().top + root.scrollY, vis = pin.offsetHeight + pinTop - elTop - tile.offsetTop, low = Math.min(W * 0.72, 460) + 14, room = vis > low + 36;
        F.flat = fitTo(flatBB, { l: pad, t: 14, r: W - pad, b: clamp(low, H - 14, vis - (room ? 40 : 14)) }, W * 0.86);
        hintAt(room);
        F.end = fitTo(flatBB, { l: pad, t: bottomOf(hx[1], hx[1].querySelector(".rfw-sub")) + 18, r: W - pad, b: H - 18 }, W * 0.86);
        const zs = (p, u) => ({ zO: p.zO * u, zI: p.zI * u, zH: p.zH * u }), aBand = { l: 8, t: bottomOf(hx[0], hx[0].querySelector(".rfw-sub")) + 12, r: W - 8, b: H - 30 };
        for (let u = 1; u >= 0.55; u -= 0.05) {
          POSE.apart = zs(POSE_P.apart, u);
          const bb = box3("apart");
          F.apart = fitTo(bb, aBand, W - 16);
          F.burst = fitTo(bb, { l: 8, t: 14, r: W - 8, b: H - 14 }, W - 16);
          if ((bb.x1 - bb.x0) * F.apart.k >= (W - 16) * 0.84) break;
        }
        const textB = Math.max.apply(null, stops.map((s, i) => bottomOf(s, tx_[i]))), cardT = Math.min.apply(null, stops.map((s, i) => s.offsetTop + cards[i].offsetTop));
        const band = { l: 8, t: textB + 10, r: W - 8, b: cardT - 10 };
        /* On a short screen the layers part a little less, so the wheel keeps most of its width instead of shrinking to fit the air. */
        for (let u = 1; u >= 0.55; u -= 0.05) {
          POSE.story = zs(POSE_P.story, u);
          const bb = box3("story");
          F.story = fitTo(bb, band, W - 16);
          if ((bb.x1 - bb.x0) * F.story.k >= (W - 16) * 0.84) break;
        }
      } else {
        /* The words keep one column, on the left where the hero's words were; the wheel keeps the right of the stage. */
        const cr = copy ? copy.getBoundingClientRect() : null, L = cr ? Math.max(pad, cr.left - tr.left) : pad, gap = Math.max(24, W * 0.02);
        tile.style.setProperty("--rfw-l", L + "px");
        const colR = hx[0].offsetLeft + hx[0].offsetWidth, restL = (cr ? cr.right - tr.left : colR) + gap, side = { l: colR + gap, t: pad, r: W - pad, b: H - pad };
        F.flat = F.end = fitTo(flatBB, { l: restL, t: pad, r: W - pad, b: H - pad - 28 }, H * 0.74);
        hintAt(true);
        /* Centre stage: for this one moment the words have gone, so it may use the whole tile. */
        F.burst = fitTo(apartBB, { l: pad, t: Math.round(pad * 0.7), r: W - pad, b: H - Math.round(pad * 0.7) }, W - 2 * pad);
        F.apart = fitTo(apartBB, side, side.r - side.l);
        F.story = fitTo(storyBB, side, side.r - side.l);
        noteTwo = false;
      }
      /* The canvas covers the whole tile, since a piece in flight may go anywhere on the stage. It is opaque, and its wrapper keeps it inside the rounded corners. */
      const cw = W, ch = H;
      ox = 0; oy = 0;
      const d = Math.min(root.devicePixelRatio || 1, 2, Math.sqrt(3.6e6 / (cw * ch))), bw = Math.round(cw * d), bh = Math.round(ch * d), resized = bw !== cv.width || bh !== cv.height;
      dpr = d;
      if (resized) {
        cv.width = bw; cv.height = bh;
        cvw.style.cssText = `left:${ox}px;top:${oy}px;width:${cw}px;height:${ch}px`;
        cv.style.width = cw + "px"; cv.style.height = ch + "px";
      }
      cv.style.transformOrigin = `${(F.flat.x - ox).toFixed(1)}px ${(F.flat.y - oy).toFixed(1)}px`;
      stageBg = getComputedStyle(tile).backgroundColor || stageBg;
      FK[0] = NaN;
      ctx.imageSmoothingEnabled = false;
      ctx.font = `600 31px ${root.getComputedStyle(el).fontFamily || "sans-serif"}`; ctx.textAlign = "center";
      /* The object is sized once, where it stands: on the front piece of the exploded ring. */
      const Z = (RT + FS + eo) * Math.sin(TILT * RAD) + (POSE.story.zO + THO + LF) * Math.cos(TILT * RAD);
      tokPx = Math.round(F.story.k * (DEPTH / (DEPTH - Z)) * TOKW);
      tok.style.setProperty("--tok", tokPx + "px");
      force = true;
      if (resized) draw(); else mark();
    };

    pinTop = parseFloat(getComputedStyle(pin).top) || 0;
    /* One timeline holds the whole story and owns the one ScrollTrigger. Scroll is its playhead, so it reverses exactly. */
    let hov = -1, tipI = -1, tipT = 0, focused = false, curP = -1, drag = null, goTw = null, ready = false;
    const IO = "power2.inOut", OUT = "power3.out", IN = "power2.in", rp = opts.refreshPriority == null ? 0 : opts.refreshPriority, scrub = opts.scrub == null ? 0.7 : opts.scrub;
    const T = g.timeline({ defaults: { ease: "none" }, onUpdate: mark, paused: true });
    /* Made once the timeline is whole, so scroll only ever plays a finished story. */
    let trig = null;
    /* Rest on a label where there is something to read. Through the come-apart and the way home the scroll just holds the pieces
       wherever it stops, so a long flight never pulls against the hand. */
    const nearBeat = (v) => {
      const t = v * END;
      if ((t > 0.15 && t < T_OPEN - 0.5) || (t > C0 && t < END - 1.1)) return v;
      let b = BEATS[0][0];
      for (const x of BEATS) if (Math.abs(x[0] - t) < Math.abs(b - t)) b = x[0];
      return b / END;
    };
    const link = () => {
      trig = ST.create({
        animation: T, trigger: el, start: 0, end: "bottom bottom",
        scrub,
        snap: opts.snap === false ? false : { snapTo: nearBeat, duration: { min: 0.35, max: 0.8 }, delay: 0.3, ease: IO, inertia: false },
        refreshPriority: rp,
        onRefresh: mark,
        onToggle: (self) => { html.style.scrollBehavior = self.isActive ? "auto" : ""; },
        onUpdate: () => { if (!ready) return; if (hov >= 0 && !focused) over(-1); homeSpin(); pressed(); },
      });
    };
    const show = (e, at, d) => T.fromTo(e, { autoAlpha: 0, y: 16 }, { autoAlpha: 1, y: 0, duration: d || 0.3, ease: OUT }, at);
    const hide = (e, at, d) => T.to(e, { autoAlpha: 0, y: -10, duration: d || 0.16, ease: IN }, at);
    g.set(fm.slice(1), { autoAlpha: 0 });
    g.set(fm, { svgOrigin: "0 0" });
    g.set(tok, { autoAlpha: 0 });
    g.set(hint, { xPercent: -50 });
    /* The first scroll. The hero's words make way; on a phone they are above the stage and the scroll itself carries them off. The
       wheel lifts out of the hero, draws in for a breath, and comes apart: the hub first, then the core, then the daily-work ring opens
       from the front around to the back, turning as it goes. Each piece takes its colour as it leaves, gets its name in the air, and
       lands with a long soft tail. */
    if (!phone && copy) T.to(copy, { autoAlpha: 0, y: -28, duration: 0.7, ease: IN }, 0.1);
    hide(hint, 0.02, 0.3);
    T.to(S, { wA: 1, duration: 4.4, ease: "power1.inOut" }, 0.05);
    T.to(S, { spO: 54, spI: -36, duration: 7, ease: HEAVY }, 0.6);
    T.to(S, { lH: 1, duration: 5.2, ease: HEAVY }, 0.7);
    T.to(S, { lI: 1, duration: 5.2, ease: HEAVY }, 1.1);
    T.to(S, { lO: 1, duration: 5.2, ease: HEAVY }, 1.3);
    T.to(S, { dr: 1, duration: 5, ease: "sine.out" }, 3.3);
    WD.forEach((w) => {
      const p = P[w.i], at = w.o ? 1.4 + w.rank * 0.4 : 1.1 + w.rank * 0.36;
      T.to(p, { e: -0.03, duration: 0.5, ease: "sine.inOut" }, 0.35);
      T.to(p, { e: 1, duration: 4.5, ease: HEAVY }, at);
      T.to(p, { c: 1, duration: 1.2, ease: IO }, at + 0.5);
      T.to(p, { n: 1, duration: 0.45, ease: OUT }, at + 1.7);
      T.to(p, { n: 0, duration: 0.3, ease: IO }, T_SEEN + 0.1);
    });
    /* Every piece has its name. The camera makes room and one line says what it all is. */
    T.to(S, { wL: 1, duration: 1, ease: IO }, T_OPEN);
    show(hx[0], T_OPEN + 0.1, 0.4);
    hide(hx[0], T_SEEN);
    /* The ring brings the first stop to the front and the object drops onto it. The pieces stay apart. */
    T.to(S, { wS: 1, spO: TURN[0], duration: 0.8, ease: IO }, T_SEEN + 0.05);
    T.to(S, { focO: 1, duration: 0.4, ease: IO }, S0 - HOLD);
    T.to(tok, { autoAlpha: 1, duration: 0.06 }, S0 - HOLD + 0.06);
    T.to(S, { obj: 1, duration: 0.1 }, S0 - HOLD + 0.06);
    T.to(S, { fall: 0, duration: 0.32, ease: "power2.in" }, S0 - HOLD + 0.06);
    /* Each stop: its words and its screen card arrive, then hold, while the other pieces stay apart. Showing or hiding a layer
       costs a repaint, so a stop's layers wake up during the hold before it and sleep during the hold after it, while the
       canvas is still; while a ring turns, only opacity and transform change. */
    const stopTweens = (d, i) => {
      words.insertAdjacentHTML("beforeend", stopHTML(d));
      stops[i] = words.lastElementChild; tx_[i] = stops[i].firstElementChild; cards[i] = stops[i].lastElementChild;
      const L = stopAt(i), n = ALL.indexOf(d), a = act(g, cards[i], d), both = [tx_[i], cards[i]];
      T.set(both, { visibility: "visible" }, i ? L - STOP + 0.05 : T_SEEN + 0.1);
      T.fromTo(tx_[i], { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.3, ease: OUT }, L - HOLD);
      a.timeScale(a.totalDuration() / 0.55);
      T.add(a, L - HOLD - 0.05);
      T.to(P[n], { w: 1, duration: 0.36, ease: OUT }, L - HOLD);
      T.to(both, { opacity: 0, y: -10, duration: 0.16, ease: IN }, L + HOLD - 0.22);
      T.set(both, { visibility: "hidden" }, i < STORY.length - 1 ? L + STOP + 0.05 : C0 - 0.05);
      T.to(P[n], { w: 0, duration: 0.3, ease: IO }, L + HOLD - 0.22);
    };
    /* Orders to inventory: the object stands at the front and the ring turns one piece under it. */
    const stepAt = (i) => stopAt(i) + HOLD - 0.22, HOP = stepAt(0), MID = HOP + 0.3;
    T.to(S, { u: ALL.indexOf(STORY[1]), spO: TURN[1], duration: 0.6, ease: IO }, HOP);
    T.to(S, { hop: 1, duration: 0.3, ease: "power1.out" }, HOP);
    T.to(S, { hop: 0, duration: 0.3, ease: "power1.in" }, MID);
    T.to(fm[0], { autoAlpha: 0, scale: 0.86, duration: 0.12, ease: IN }, MID - 0.12);
    T.fromTo(fm[1], { autoAlpha: 0, scale: 0.86 }, { autoAlpha: 1, scale: 1, duration: 0.14, ease: OUT, immediateRender: false }, MID);
    /* Inventory to payments: the ring swings the money round to the front, and the check drops onto it. */
    const LAST = stepAt(1), DROP = stopAt(2) - HOLD + 0.42;
    T.to(tok, { autoAlpha: 0, duration: 0.14 }, LAST);
    T.to(S, { obj: 0, duration: 0.14 }, LAST);
    T.to(S, { spO: TURN[2], duration: 0.85, ease: IO }, LAST);
    T.set(S, { u: ALL.indexOf(STORY[2]), fall: 1, hop: 0 }, LAST + 0.2);
    T.set(fm[1], { autoAlpha: 0 }, LAST + 0.2);
    T.set(fm[2], { autoAlpha: 1, scale: 1 }, LAST + 0.2);
    T.to(tok, { autoAlpha: 1, duration: 0.06 }, DROP);
    T.to(S, { obj: 1, duration: 0.1 }, DROP);
    T.to(S, { fall: 0, duration: 0.32, ease: "power2.in" }, DROP);
    /* Back together, along the same paths with the same curve run backward: the rings finish their turn, the slices close in from
       the back around to the front, the core comes down and the hub seats last, with weight. The colour holds until it is whole,
       then leaves, so it ends as calm as it began. */
    T.to(tok, { autoAlpha: 0, duration: 0.14 }, C0);
    T.to(S, { obj: 0, duration: 0.14 }, C0);
    T.to(S, { focO: 0, duration: 0.5, ease: IO }, C0);
    T.to(S, { spO: 360, spI: -360, duration: 3.1, ease: HOME }, C0 - 0.1);
    T.to(S, { wE: 1, duration: 3, ease: IO }, C0 + 0.05);
    T.to(S, { hO: 1, duration: 2.7, ease: HOME }, C0 + 0.05);
    T.to(S, { hI: 1, duration: 2.7, ease: HOME }, C0 + 0.2);
    T.to(S, { hH: 1, duration: 2.7, ease: HOME }, C0 + 0.35);
    WD.forEach((w) => {
      const p = P[w.i], at = C0 + (w.o ? 0.05 + (5 - w.rank) * 0.1 : 0.05 + (2 - w.rank) * 0.12);
      T.to(p, { e: 0, duration: 2.6, ease: HOME }, at);
      T.to(p, { c: 0, duration: 0.5, ease: IO }, C0 + 3.45 + (w.i % 7) * 0.03);
    });
    T.fromTo(S, { rip: 0 }, { rip: 1, duration: 0.35, ease: "power2.out", immediateRender: false }, C0 + 3);
    show(hx[1], C0 + 2.9);
    T.to({}, { duration: 0.001 }, END - 0.001);
    BEATS.forEach(([t, name]) => T.addLabel(name, t));
    /* On load, not on scroll: the wheel settles into the hero. A small turn and a small scale on the canvas's own layer, so nothing is
       drawn for it at all, on any device. */
    const arrive = g.fromTo(cv, { rotation: -16, scale: 0.96, opacity: 0 }, { rotation: 0, scale: 1, opacity: 1, duration: 1.5, ease: "expo.out" });

    /* Hover and focus lift a piece and name it without moving the page. Tap and Enter go to its stop. */
    const lift = P.map((p) => g.quickTo(p, "h", { duration: 0.45, ease: OUT, onUpdate: mark }));
    const beatOf = (i) => (STORY.includes(ALL[i]) ? ALL[i].k : "apart");
    const goTo = (name) => {
      const y = trig.labelToScroll(name), o = { y: trig.scroll() }, dist = Math.abs(y - o.y) / Math.max(1, trig.end - trig.start);
      if (goTw) goTw.kill();
      goTw = g.to(o, { y, duration: clamp(0.5, 1.6, 0.5 + dist * 3), ease: IO, onUpdate: () => trig.scroll(o.y) });
    };
    const showTip = (i) => {
      clearTimeout(tipT);
      if (i >= 0) { tipI = i; tip.textContent = ALL[i].t; tip.classList.add("on"); force = true; mark(); } else tipT = setTimeout(() => { tip.classList.remove("on"); tipI = -1; }, 160);
    };
    const over = (i) => {
      if (i === hov) return;
      if (hov >= 0) lift[hov](0);
      hov = i;
      if (i >= 0) lift[i](1);
      cv.style.cursor = i >= 0 ? "pointer" : "";
      showTip(i);
    };
    const pressed = () => {
      const t = T.time();
      let b = BEATS[0];
      for (const x of BEATS) if (Math.abs(x[0] - t) < Math.abs(b[0] - t)) b = x;
      const i = ALL.findIndex((d) => d.k === b[1]);
      if (i === curP) return;
      if (curP >= 0) btns[curP].setAttribute("aria-pressed", "false");
      curP = i;
      if (i >= 0) btns[i].setAttribute("aria-pressed", "true");
    };
    const hit = (e) => {
      if (g.getProperty(cv, "scaleX") < 0.999) return null;
      const r = cv.getBoundingClientRect(), mx = (e.clientX - r.left) * dpr, my = (e.clientY - r.top) * dpr;
      const q = unproj(mx, my, cam.zH + THH);
      if (Math.hypot(q[0], q[1]) < HUB) return null;
      const a = unproj(mx, my, cam.zI + THI), ra = Math.hypot(a[0], a[1]);
      const dr = 1 + DRIFT * S.dr, oi = P[NO].e * EX.i * dr, oo = P[0].e * EX.o * dr;
      if (ra >= r0 + oi && ra <= r1 + oi + FSI) { const ang = Math.atan2(a[1], a[0]), sp = (S.spI + Sp.i.x) * RAD; return { ring: "i", i: NO + mod(Math.round((ang - sp + PI / 2) / (72 * RAD)), 5) }; }
      const b = unproj(mx, my, cam.zO + THO), rb = Math.hypot(b[0], b[1]);
      if (rb >= R0 + oo && rb <= R1 + oo + FS) { const ang = Math.atan2(b[1], b[0]), sp = (S.spO + Sp.o.x) * RAD; return { ring: "o", i: mod(Math.round((ang - sp + PI / 2) / (STEP_O * RAD)), NO) }; }
      return null;
    };
    const planeAng = (e, ring) => { const r = cv.getBoundingClientRect(), z = ring === "i" ? cam.zI + THI : cam.zO + THO, q = unproj((e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr, z); return Math.atan2(q[1], q[0]); };

    /* Flick: a critically damped spring that starts at the finger's speed and rests where momentum points. */
    const Sp = { o: { x: 0, v: 0, to: 0, on: false }, i: { x: 0, v: 0, to: 0, on: false } }, OM = TAU / 0.5;
    const project = (v) => (v / 1000) * (0.998 / (1 - 0.998));
    const stepSp = (s, dt) => {
      const A = s.x - s.to, B = s.v + OM * A, e = Math.exp(-OM * dt), xn = (A + B * dt) * e;
      s.v = (B - OM * (A + B * dt)) * e; s.x = s.to + xn;
      if (Math.abs(xn) < 0.02 && Math.abs(s.v) < 0.6) { s.x = s.to; s.v = 0; s.on = false; }
      mark();
    };
    const homeSpin = () => { ["o", "i"].forEach((k) => { const s = Sp[k]; if (!drag && s.x !== 0 && !s.home) { s.home = true; s.to = Math.round(s.x / 360) * 360; s.on = true; } }); };
    const tick = (t, ms) => {
      const dt = Math.min(ms / 1000, 0.05);
      if (Sp.o.on) stepSp(Sp.o, dt); else Sp.o.home = false;
      if (Sp.i.on) stepSp(Sp.i, dt); else Sp.i.home = false;
      if (dirty) draw();
    };
    const onDown = (e) => {
      const h = hit(e);
      if (!h) return;
      const s = Sp[h.ring];
      s.on = false; s.v = 0;
      drag = { ring: h.ring, i: h.i, a: planeAng(e, h.ring), x: e.clientX, y: e.clientY, moved: false, hist: [] };
    };
    const onMove = (e) => {
      if (!drag) { if (e.pointerType !== "touch") { const h = hit(e); over(h ? h.i : -1); } return; }
      if (!drag.moved) {
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 10) return;
        drag.moved = true; drag.a = planeAng(e, drag.ring); cv.setPointerCapture(e.pointerId); cv.style.cursor = "grabbing"; over(-1);
      }
      const a = planeAng(e, drag.ring), da = (mod(a - drag.a + PI, TAU) - PI) / RAD;
      drag.a = a; Sp[drag.ring].x += da;
      drag.hist.push([performance.now(), Sp[drag.ring].x]);
      if (drag.hist.length > 6) drag.hist.shift();
      mark();
    };
    const onUp = (e) => {
      if (!drag) return;
      const d = drag, s = Sp[d.ring], step = d.ring === "o" ? STEP_O : 72;
      drag = null; cv.style.cursor = "";
      if (!d.moved) { if (e.type === "pointerup") goTo(beatOf(d.i)); return; }
      const h = d.hist, a = h[0], b = h[h.length - 1], dt = a && b ? (b[0] - a[0]) / 1000 : 0, old = performance.now() - (b ? b[0] : 0) > 90, v = dt > 0.005 && !old ? (b[1] - a[1]) / dt : 0;
      s.v = clamp(-900, 900, v); s.to = Math.round((s.x + project(s.v)) / step) * step; s.on = true;
      /* Never let the hand-off carry past the stop: critically damped, no overshoot. */
      const left = s.to - s.x;
      if (left * s.v <= 0) s.v = 0; else if (Math.abs(s.v) > OM * Math.abs(left)) s.v = OM * left;
    };
    const onLeave = (e) => { if (!drag && e.pointerType !== "touch") over(-1); };
    const onFocus = (e) => { const i = +e.target.dataset.i; if (e.target.matches(":focus-visible")) { focused = true; focusI = i; force = true; over(i); mark(); } };
    const onBlur = () => { focused = false; focusI = -1; force = true; over(-1); mark(); };
    const onKey = (e) => {
      const i = +e.target.dataset.i;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); goTo(beatOf(i)); }
      const k = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (k) { e.preventDefault(); const n = mod(i + k, N); btns[i].tabIndex = -1; btns[n].tabIndex = 0; btns[n].focus(); }
    };
    const on = [[cv, "pointerdown", onDown], [cv, "pointermove", onMove], [cv, "pointerup", onUp], [cv, "pointercancel", onUp], [cv, "pointerleave", onLeave], [wheelBox, "focusin", onFocus], [wheelBox, "focusout", onBlur], [wheelBox, "keydown", onKey]];
    const onRI = () => layout();
    let roSeen = false, alive = true, jobId = 0;
    /* The first report only repeats the layout the build has just done. */
    const ro = new ResizeObserver(() => { if (!roSeen) { roSeen = true; return; } layout(); draw(); });
    /* The first scroll should not meet cold code. In idle moments, draw each kind of pose, then put the true state back and
       draw that in the same moment, so nothing ever shows. */
    const OPENED = { wA: 1, lO: 1, lI: 1, lH: 1, dr: 1 };
    const WARMS = [Object.assign({ spO: 54, spI: -36 }, OPENED), Object.assign({ wL: 1, spO: 54, spI: -36 }, OPENED), Object.assign({ wL: 1, wS: 1, focO: 1, obj: 1, u: 2.4, hop: 0.5, fall: 0, spO: 90 }, OPENED), Object.assign({ wL: 1, wS: 1, wE: 0.5, hO: 0.5, hI: 0.5, hH: 0.5, rip: 0.5, spO: 320, spI: -240 }, OPENED)];
    let warmId = 0, warmN = 0;
    const warm = () => {
      warmId = 0;
      if (!alive || trig.isActive) return;
      const keepS = Object.assign({}, S), keepP = P.map((p) => Object.assign({}, p)), w = WARMS[warmN % WARMS.length];
      Object.assign(S, w);
      P.forEach((p, i) => { p.c = 1; p.e = warmN % 2 ? 0.5 : 1; p.n = 1; p.w = i === (warmN * 3) % P.length ? 1 : 0; });
      for (let j = 0; j < 3; j++) { force = true; S.spO += 7; S.spI += 5; draw(); }
      Object.assign(S, keepS);
      P.forEach((p, i) => Object.assign(p, keepP[i]));
      force = true; draw();
      warmN++;
      if (warmN < WARMS.length * 3) warmId = idle(warm);
      else { force = true; draw(); }
    };
    const fontsIn = () => { if (!alive) return; const h0 = ends(); layout(); if (Math.abs(h0 - ends()) > 0.5) ST.refresh(); else trig.refresh(); };
    /* The build as a short list of jobs: each stop with its own DOM, then the canvas and its listeners, then the finish. Lazily, one per idle moment. */
    const arm = () => {
      on.forEach(([t, n, f]) => t.addEventListener(n, f));
      g.ticker.add(tick);
      ST.addEventListener("refreshInit", onRI);
      ro.observe(tile);
      layout();
      link();
      ready = true;
    };
    const finish = () => {
      if (Math.abs(held0 - ends()) > 0.5) Promise.resolve().then(() => { if (alive) ST.refresh(); }); else ST.sort();
      if (document.fonts && document.fonts.status !== "loaded" && document.fonts.ready) document.fonts.ready.then(fontsIn);
      delete inst.flush;
      Object.assign(inst, { live: true, built: true, T, trig, S, P, Sp, at: (t) => trig.start + ((trig.end - trig.start) * t) / END, redraw: () => { force = true; whole = true; draw(); } });
      settled();
      warmId = idle(warm);
    };
    const jobs = STORY.map((d, i) => () => mctx.add(() => stopTweens(d, i))).concat(() => mctx.add(arm), finish);
    const flush = () => { if (jobId) unidle(jobId); jobId = 0; while (alive && jobs.length) jobs.shift()(); };
    const step = () => { jobId = 0; if (alive && jobs.length) { jobs.shift()(); if (jobs.length) jobId = idle(step); } };
    if (slices()) { inst.flush = flush; jobId = idle(step); } else flush();
    return () => {
      alive = false;
      if (jobId) unidle(jobId);
      if (warmId) unidle(warmId);
      g.ticker.remove(tick);
      ST.removeEventListener("refreshInit", onRI);
      ro.disconnect();
      on.forEach(([t, n, f]) => t.removeEventListener(n, f));
      clearTimeout(tipT);
      if (goTw) goTw.kill();
      html.style.scrollBehavior = "";
      if (!pageTop) el.style.removeProperty("--rfw-top");
      ["T", "trig", "S", "P", "Sp", "at", "redraw", "flush"].forEach((k) => { delete inst[k]; });
      inst.live = false;
    };
  }

  const api = { mount, staticHTML, cards: CARD, data: ALL, icons: ICON, beats: planOf(false).BEATS };
  root.RFWheel = api;
  if (typeof document !== "undefined") {
    const all = () => { if (root.RFScenes) root.RFScenes.wheel = mount; document.querySelectorAll('[data-scene="wheel"]').forEach((e) => mount(e)); };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", all); else all();
  }
})(typeof window !== "undefined" ? window : globalThis);
