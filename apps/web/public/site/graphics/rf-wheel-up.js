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
    { k: "delivery", t: "Delivery", s: "Drivers see each stop and can start or skip it.", a: "mint", c: "#44bd92", w: "#27926e", i: "#003726", n: ADD },
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

  /* The still: a calm white dial. Used for no JavaScript and for a window under 500 px tall. */
  const R0 = 250, R1 = 480, r0 = 128, r1 = 236, HUB = 116, GAP = 7, RC = 10;
  const sector = (a, b, c, d, gap) => {
    const g = gap / 2 + RC, X = b - RC, Y = a + RC, dx = (g / X) / RAD, dy = (g / Y) / RAD;
    const P1 = pt(X, c + dx), P2 = pt(X, d - dx), P3 = pt(Y, d - dy), P4 = pt(Y, c + dy);
    return `M${P1}A${X} ${X} 0 0 1 ${P2}L${P3}A${Y} ${Y} 0 0 0 ${P4}Z`;
  };
  const pastel = (c, k) => "#" + [1, 3, 5].map((n) => Math.round(255 - (255 - parseInt(c.slice(n, n + 2), 16)) * k).toString(16).padStart(2, "0")).join("");
  const lines2 = (t) => (t.length > 9 ? t.replace(/ (?=\S+$)/, "\n").split("\n") : [t]);
  const piece = (d, i, A, B, step, inner) => {
    const a = -90 + i * step, s = sector(A, B, a - step / 2, a + step / 2, GAP), c = pt((A + B) / 2 + (inner ? 0 : 4), a);
    return `<path class="rfw-ln" d="${s}"/><path class="rfw-w${i % 2 ? " g" : ""}" style="fill:${pastel(d.c, inner ? 0.5 : 0.4)};stroke:${pastel(d.c, inner ? 0.5 : 0.4)}" d="${s}"/><g class="rfw-up" transform="translate(${c[0]} ${c[1]})"><g class="${inner ? "rfw-i2w" : "rfw-icw"}"><g class="rfw-ic" transform="translate(-24 -24)">${ICON[d.k]}</g></g>${inner ? "" : `<text class="rfw-lb" y="${lines2(d.t).length > 1 ? 46 : 54}">${lines2(d.t).map((l, j) => `<tspan x="0"${j ? ' dy="31"' : ""}>${l}</tspan>`).join("")}</text>`}</g>`;
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
  /* With ic the item leads with its own icon (the live wheel's legend); the still keeps its words alone. */
  const li = (d, o, ic) => `<li${o ? ' class="o"' : ""}>${ic ? `<svg class="rfw-ki" viewBox="0 0 48 48" aria-hidden="true"><g class="rfw-ic">${ICON[d.k]}</g></svg>` : ""}${d.t}<span>${d.s}${d.n ? ` ${d.n}.` : ""}</span></li>`;
  const keys = (ic) => `<p class="rfw-keyh">${EYE_O}</p><ul class="rfw-keys">${OUTER.map((d) => li(d, 1, ic)).join("")}</ul><p class="rfw-keyh">${EYE_I}</p><ul class="rfw-keys">${INNER.map((d) => li(d, 0, ic)).join("")}</ul>`;
  /* The one end-state button: here once, used by the still and the live wheel, and pasted byte for byte into the page's own still. */
  const GO = { lead: "Try it with your own orders.", text: "Start free trial", href: "/signup", track: "trial_start_click", where: "after_wheel" };
  const goHTML = () => `<div class="sy-go"><p class="sy-try">${GO.lead}</p><a class="btn btn-primary btn-lg" href="${GO.href}" data-track="${GO.track}" data-where="${GO.where}">${GO.text}</a></div>`;
  const staticHTML = () => `<div class="rfw-pin"><div class="rfw-wheel">${dial()}</div><div class="rfw-stage"><h2 class="rfw-title">${HERO[1].t}</h2><p class="rfw-sub">${HERO[0].s} ${HERO[1].s}</p>${goHTML()}${keys(false)}</div></div>`;
  const stopHTML = (d) => `<div class="rfw-s"><div class="rfw-t" style="--pc:${d.c}"><p class="rfw-eye">${INNER.includes(d) ? EYE_I : EYE_O}</p><p class="rfw-title">${d.t}</p><p class="rfw-sub">${d.s}</p></div><div class="rfw-card" style="--acc:var(--rf-${d.a})" role="img" aria-label="Illustration with sample data: ${d.t}.">${CARD[d.k]}</div></div>`;
  const liveHTML = () => `${DEFS}<div class="rfw-pin"><div class="rfw-tile"><div class="rfw-cvw"><canvas class="rfw-cv" aria-hidden="true"></canvas></div>` +
    `<div class="rfw-wheel" role="group" aria-label="The RouteFlow wheel. Use the arrow keys to look at each piece. Press Enter to go to it.">${ALL.map((d, i) => `<button type="button" class="rfw-b" data-i="${i}" tabindex="${i ? -1 : 0}" aria-pressed="false" aria-label="${d.t}: ${d.s}${d.n ? ` ${d.n}.` : ""}"></button>`).join("")}</div>` +
    `<div class="rfw-tok" aria-hidden="true">${tokenSVG}</div><div class="rfw-tip" aria-hidden="true"></div>` +
    `<div class="rfw-words"><p class="rfw-hint">${HINT}</p>${HERO.map((h, i) => `<div class="rfw-h h${i}">${i ? `<h2 class="rfw-title">${h.t}</h2>` : `<p class="rfw-title">${h.t}</p>`}<p class="rfw-sub">${h.s}</p>${i ? goHTML() : `<div class="rfw-legend" aria-hidden="true">${keys(true)}</div>`}</div>`).join("")}` +
    `</div>` +
    `</div></div><ol class="rfw-list">${ALL.map((d) => li(d)).join("")}</ol>`;

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
  /* At rest a piece already wears a soft tint of its own colour (the share of the full colour it carries), so the first screen is not white. */
  const REST_TINT = 0.4;
  const WHITE = [255, 255, 255], INK = [15, 27, 45], NVY = hex("#10264d"), HUBW = hex("#0a1a38");
  const NEU = [WHITE, hex("#fafafc")], WNEU = hex("#d6dee8"), MUTE = hex("#e2e8f0"), MUTEW = hex("#d6dee8");
  const THO = 40, THI = 34, THH = 58, DEPTH = 2000, FS = 46, FSI = 62, LF = 48, RT = 418, TOKW = 150, TILT = 68, YC = -260, HUB_R = 0.62, AIR = 90, DRIFT = 0.05, PITCH = 0.5, REST = 0.05;
  /* How the wheel comes apart. Every piece leaves straight out from the centre (EX, in wheel units), the layers part in
     height (OPEN) by one weight (S.lift), and the camera angle never changes once it is apart. One pose on every screen, so every
     camera z is OPEN times the lift. EDGE is the least air between the open wheel and the stage's edge (T3 needs 8); HINT_H is
     the hint's height (offsetHeight reads 0 after hintAt(false)); SH_REACH is how far of its radius a lifted piece's floor shadow
     still shows. */
  const EX = { o: 190, i: 104 }, OPEN = { zO: -170, zI: 390, zH: 720 }, EDGE = 12, HINT_H = 26, SH_REACH = 0.8, RIP_W = 40;
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
  /* Who is moving the page. A script must not write the scroll position (a snap, a refresh that puts the place back) while a
     person's own scroll may still be moving: it would cancel it. Every person's input and every scroll is noted here. */
  let lastIn = -1e9, lastMove = -1e9, lastRef = -1e9, pendRef = false;
  const now = () => (root.performance ? root.performance.now() : Date.now());
  const quiet = (ms) => now() - Math.max(lastIn, lastMove) > ms;
  const calm = () => document.readyState === "complete" && now() - lastRef > 600 && quiet(250);
  if (typeof document !== "undefined") {
    const inn = () => { lastIn = now(); }, mv = () => { lastMove = now(); }, o = { passive: true, capture: true };
    ["wheel", "touchstart", "touchmove", "keydown", "pointerdown"].forEach((n) => root.addEventListener(n, inn, o));
    root.addEventListener("scroll", mv, o);
  }
  /* A refresh re-measures and may put the place back, so it waits for a still page; one retry, on the end of the scroll. */
  const refreshCalm = () => {
    const ST = root.ScrollTrigger;
    if (!ST) return;
    if (quiet(200)) { pendRef = false; ST.refresh(); return; }
    if (pendRef) return;
    pendRef = true;
    let tm = 0;
    const again = () => { ST.removeEventListener("scrollEnd", again); clearTimeout(tm); if (pendRef) { pendRef = false; refreshCalm(); } };
    ST.addEventListener("scrollEnd", again);
    tm = setTimeout(again, 900);
  };
  let registered = false;
  function mount(el, opts) {
    if (el._rfw) return el._rfw;
    opts = opts || {};
    const g = root.gsap, ST = root.ScrollTrigger;
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
    let mm = null, dead = false;
    const inst = (el._rfw = { el, live: false, beats: planOf(false).BEATS.map((b) => b.slice()), destroy });
    el.classList.add("rfw");
    const still = () => { settled(); const tall = el.classList.contains("rfw-wait"); el.classList.add("rfw--static"); el.classList.remove("rfw-live", "rfw-wait"); el.innerHTML = staticHTML(); inst.live = false; if (tall && ST) Promise.resolve().then(refreshCalm); };
    const start = () => {
      if (!can) return still();
      if (!registered) { g.registerPlugin(ST); registered = true; }
      /* One matchMedia owns every tween, trigger and listener; a change of width class reverts all of it and
         builds again. The motion always runs (owner ruling 2026-11-03), on every height; a phone held sideways (narrow, short, wider than tall) gets the wide layout, the words beside the wheel. */
      mm = g.matchMedia(el);
      /* Every key is screen only (never a key named all, and print has its own context below); the stage is the window less 16 px
         across and less the header and 16 px down, so a stage under 200 px a side (a window under 216 by 284) gets the still. */
      const MQ = { wide: "(min-width: 900px)", land: "(max-width: 899.98px) and (max-height: 599.98px) and (min-aspect-ratio: 1/1)", narrow: "(max-width: 899.98px)", low: "(max-height: 499.98px)" };
      const conds = { screen: "screen", tiny: "screen and (max-width: 215.98px), screen and (max-height: 283.98px)" };
      for (const k in MQ) conds[k] = "screen and " + MQ[k];
      mm.add(conds, (c) => {
        return c.conditions.tiny ? void still() : live(g, ST, el, inst, !c.conditions.wide && !c.conditions.land, opts, c, { headerTop, pageTop, settled, slices: () => slow && !inst.built });
      });
      /* On paper the wheel is the still: no canvas, nothing to scroll. */
      mm.add("print", () => { still(); });
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
    function destroy() {
      if (dead) return;
      dead = true;
      settled();
      if (mm) mm.revert();
      el.innerHTML = saved.html;
      el.setAttribute("class", saved.cls);
      el.style.removeProperty("--rfw-top");
      el._rfw = null;
    }
    const liveWanted = can;
    const far = () => { const r = el.getBoundingClientRect(), h = root.innerHeight; return r.top > 2.5 * h || r.bottom < -1.5 * h; };
    if (opts.lazy && liveWanted && root.IntersectionObserver && far()) wait(); else start();
    return inst;
  }

  function live(g, ST, el, inst, phone, opts, mctx, site) {
    /* The small icon floor holds for a phone held either way; the layout is the wide one when it is held sideways. */
    const low = !!(mctx && mctx.conditions && mctx.conditions.low), small = phone || low || !!(mctx && mctx.conditions && mctx.conditions.land);
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
    const S = { wA: 0, wS: 0, wE: 0, lift: 0, dr: 0, spO: 0, spI: 0, u: ALL.indexOf(STORY[0]), hop: 0, fall: 1, obj: 0, focO: 0, rip: 0 };
    const P = ALL.map(() => ({ w: 0, h: 0, e: 0, c: 0 }));
    const { STOP, H: HOLD, S0, stopAt, C0, END, BEATS } = planOf(phone), GO_SHOW = phone ? C0 + 1.7 : C0 - 0.22, GO_AT = GO_SHOW + 0.2;
    inst.beats = BEATS.map((b) => b.slice());
    const WD = ALL.map((d, i) => {
      const o = i < NO, step = o ? STEP_O : 72, ca = (-90 + (o ? i : i - NO) * step) * RAD, hs = (step / 2) * RAD, L = outline(o ? R0 : r0, o ? R1 : r1, ca - hs, ca + hs, GAP);
      return { i, d, o, ca, pts: L.pts, n: L.pts.length / 2, rim: L.rim, mid: o ? (R0 + R1) / 2 + 4 : (r0 + r1) / 2, ic: new Path2D(icd(ICON[d.k])), col: hex(d.c), wall: hex(d.w), ink: o ? hex(d.i) : WHITE, neu: NEU[i % 2], jit: Math.sin(i * 2.4) * (o ? 44 : 30), rank: Math.floor(Math.abs(mod((-90 + (o ? i : i - NO) * step) - 90 + 180, 360) - 180) / step) };
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

    let hubUp = 0, hubF = 0, hubSet = false, dpr = 1, K = 1, cx = 0, cy = 0, ct = 1, st = 0, px = 0, py = 0, pp = 1, dirty = true, focusI = -1, hc = false, pinTop = 0, tokPx = 120, ox = 0, oy = 0, stageBg = "#f5f5f7", ringC = "#2b4c88";
    const F = { flat: { k: 0.4, x: 0, y: 0 }, end: { k: 0.4, x: 0, y: 0 }, open: { k: 0.4, x: 0, y: 0 }, stop: { k: 0.4, x: 0, y: 0 } };
    const cam = { tilt: 0, zO: 0, zI: 0, zH: 0, k: 0.4, x: 0, y: 0 };
    const mark = () => { dirty = true; };
    const KEYS = Object.keys(S), VAL = new Float64Array(KEYS.length + 2 + ALL.length * 4);
    let force = true;
    const unchanged = () => {
      let i = 0, same = true;
      const put = (v) => { if (VAL[i] !== v) { VAL[i] = v; same = false; } i++; };
      for (let j = 0; j < KEYS.length; j++) put(S[KEYS[j]]);
      put(Sp.o.x); put(Sp.i.x);
      for (let j = 0; j < P.length; j++) { const p = P[j]; put(p.w); put(p.h); put(p.e); put(p.c); }
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
    /* The layers leave and come home on one weight (S.lift), so every camera z is the open pose times it. The camera goes from the
       hero to the open frame, holds one framing for the words (the stops frame it a little differently only where the card needs room,
       on a phone), and home to where the last words leave it room. */
    const pose = () => {
      const e = S.wE, m = S.wA * (1 - e), R = F.flat, N = F.end, O = F.open, G = F.stop;
      cam.zO = OPEN.zO * S.lift; cam.zI = OPEN.zI * S.lift; cam.zH = OPEN.zH * S.lift;
      cam.tilt = TILT * m;
      cam.k = lerp(lerp(R.k, N.k, e), lerp(O.k, G.k, S.wS), m); cam.x = lerp(lerp(R.x, N.x, e), lerp(O.x, G.x, S.wS), m); cam.y = lerp(lerp(R.y, N.y, e), lerp(O.y, G.y, S.wS), m);
    };
    const plates = (list, spin, zB, th, outer) => {
      const cs = Math.cos(spin), sn = Math.sin(spin), far = (outer ? EX.o : EX.i) * (1 + DRIFT * S.dr);
      ord.length = 0;
      for (const w of list) ord.push(w);
      ord.sort((a, b) => Math.sin(a.ca + spin) * st * R1 + (P[a.i].w + P[a.i].h) * 300 - Math.sin(b.ca + spin) * st * R1 - (P[b.i].w + P[b.i].h) * 300);
      for (const w of ord) {
        const p = P[w.i], lift = Math.max(p.w, p.h * 0.6), e = p.e, a = w.ca + spin, ux = Math.cos(a), uy = Math.sin(a), sl = (lift * (outer ? FS : FSI) + e * far) * rg, b = e > 0 ? 4 * e * (1 - e) : 0, zT = zB + th + lift * LF + b * w.jit, q = b * PITCH + (e > 0 ? e : 0) * REST, n = w.n;
        rot(w.pts, n, cs, sn, ux * sl, uy * sl, zT, tx, ty, q, ux, uy, w.mid * rg); rot(w.pts, n, cs, sn, ux * sl, uy * sl, zT - th, bx, by, q, ux, uy, w.mid * rg);
        /* Neutral at rest, its own colour when apart; softened toward a light neutral while another piece has the stage. */
        const m = outer ? S.focO * (1 - lift) * 0.34 : S.focO * 0.2;
        const cc = Math.max(p.c, outer ? REST_TINT : REST_TINT + 0.1);
        let f = mix(w.neu, w.col, cc), wl = mix(WNEU, w.wall, cc);
        if (m > 0.001) { f = mix(f, MUTE, m * p.c); wl = mix(wl, MUTEW, m * p.c); }
        walls(n, css(wl));
        ctx.beginPath(); trace(tx, ty, n); ctx.fillStyle = css(f); ctx.fill();
        const edge = hc ? 0.55 : 0.08 * (1 - p.c);
        if (edge > 0.01) { ctx.lineWidth = dpr; ctx.strokeStyle = css(INK, edge); ctx.stroke(); }
        if (p.c > 0.02 && st > 0.05 && m < 0.5) { ctx.beginPath(); ctx.moveTo(tx[0], ty[0]); for (let j = 1; j < w.rim; j++) ctx.lineTo(tx[j], ty[j]); ctx.lineJoin = "miter"; ctx.lineWidth = 1.25 * dpr; ctx.strokeStyle = css(WHITE, 0.42 * p.c * (1 - m)); ctx.stroke(); }
        if (focusI === w.i) { ctx.beginPath(); trace(tx, ty, n); ctx.lineWidth = 3 * dpr; ctx.strokeStyle = ringC; ctx.stroke(); }
        /* Only the plate tilts; the icon stands centred on it. The piece the object stands on lets it have the spot. A piece's name is
           never painted: the legend, the 15 buttons and the name pill carry it. */
        const vis = (outer ? 1 - S.obj * p.w : 1) * (1 - m * 0.55);
        if (vis > 0.03) {
          proj(ux * (w.mid * rg + sl), uy * (w.mid * rg + sl), zT);
          const sc = K * pp, ax = px, ay = py, sq = 0.62 + 0.38 * ct;
          ctx.fillStyle = ctx.strokeStyle = css(mix(INK, w.ink, p.c));
          const is = Math.max(1.25 * sc, (small ? 0.62 : 0.8) * dpr) * (outer ? 1 : rg + lift * 0.4);
          ctx.globalAlpha = vis;
          if (ctx.globalAlpha > 0.01) {
            ctx.setTransform(is, 0, 0, is * sq, ax, ay); ctx.translate(-24, -24);
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
      /* On a phone, while the lid is a sliver the mark would be a squashed smear, so it stands upright and unsquashed on the front of
         the puck; as the lid opens to the eye the mark lies on it again. Never both at once: each fades out before the other fades in. */
      let up = 0, ft = -1e9, fb = -1e9, lt = 1e9;
      if (phone) {
        for (let j = 0; j < 48; j++) { if (ty[j] > ft) ft = ty[j]; if (ty[j] < lt) lt = ty[j]; if (by[j] > fb) fb = by[j]; }
        /* Looking straight down (the page at rest) the base sits inside the lid, so fb - ft is negative: no front face to stand on, the mark lies flat. */
        up = fb - ft > 1 ? clamp(0, 1, (1.6 * (fb - ft) - (ft - lt)) / (0.8 * (fb - ft))) : 0;
      }
      proj(0, 0, z + THH); const ox = px, oy = py; proj(100, 0, z + THH); const ax = (px - ox) / 100, ay = (py - oy) / 100; proj(0, 100 * hy, z + THH);
      /* Which mark stands is decided by the geometry with a margin (so it cannot flicker), and the fade between them runs on the clock
         (see tick), never on the scroll: a page can rest anywhere, and a fade tied to the scroll would rest half done. */
      if (up > 0.55) hubUp = 1; else if (up < 0.45) hubUp = 0;
      if (!hubSet) { hubSet = true; hubF = hubUp; }
      if (hubF < 0.5) {
        ctx.globalAlpha = (0.5 - hubF) * 2;
        ctx.setTransform(ax, ay, (px - ox) / 100, (py - oy) / 100, ox, oy); ctx.translate(-30, -40); ctx.scale(0.75, 0.75);
        ctx.lineWidth = 13; ctx.lineCap = ctx.lineJoin = "round"; ctx.strokeStyle = "#fff"; ctx.stroke(MARKP);
      }
      if (hubF > 0.5) {
        const s = (0.62 * (fb - ft)) / 96;
        ctx.globalAlpha = (hubF - 0.5) * 2;
        ctx.setTransform(s, 0, 0, s, ox - 40 * s, (ft + fb) / 2 - 49 * s);
        ctx.lineWidth = 15; ctx.lineCap = ctx.lineJoin = "round"; ctx.strokeStyle = "#fff"; ctx.stroke(MARKP);
      }
      ctx.globalAlpha = 1;
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
      if (S.rip > 0.001 && S.rip < 0.999) { ctx.beginPath(); for (let j = 0; j <= 96; j++) { const a = (j / 96) * TAU, r = R1 + 14 + S.rip * RIP_W; proj(r * Math.cos(a), r * Math.sin(a), 0); if (j) ctx.lineTo(px, py); else ctx.moveTo(px, py); } ctx.lineWidth = 1.25 * dpr; ctx.strokeStyle = css(NVY, 0.2 * (1 - S.rip)); ctx.stroke(); }
      /* The object lives in the world; it is sized once per layout and only moves here. */
      if (S.obj > 0.01) { proj(ax, ay, zo + THO + lz + S.hop * 70 + S.fall * 520); tok.style.transform = `translate3d(${(px / dpr + ox).toFixed(1)}px,${(py / dpr + oy).toFixed(1)}px,0)`; }
      /* The name pill: no piece carries its name, so every hover or focus gets it. */
      if (tipI >= 0) tip.classList.add("on");
      if (tipI >= 0) { const w = WD[tipI], p = P[tipI], o = w.o, a = w.ca + (o ? spo : spi), l = Math.max(p.w, p.h * 0.6), r = w.mid + l * (o ? FS : FSI) + p.e * (o ? EX.o : EX.i) * (1 + DRIFT * S.dr); proj(r * Math.cos(a), r * Math.sin(a), (o ? zo + THO : zi + THI) + l * LF); tip.style.transform = `translate3d(${(px / dpr + ox).toFixed(1)}px,${(py / dpr + oy - 46 * Math.max(0.6, K / dpr)).toFixed(1)}px,0) translateX(-50%)`; }
    };

    /* Fit: every pose is projected at unit scale and fitted into the box the words and the card leave free. It covers everything the
       canvas draws; with sh it also covers the floor shadow of a lifted piece (draw, the DISC under it), which reaches past the plate. */
    const bboxOf = (tilt, zo, zi, zh, eo, ei, sh) => {
      const t = tilt * RAD, c = Math.cos(t), s = Math.sin(t), lf = tilt ? LF : 0;
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      const add = (x, y, z) => { const Y = y * c - z * s, Z = y * s + z * c, p = DEPTH / (DEPTH - Z), X = x * p, V = (Y - YC) * p + YC; if (X < x0) x0 = X; if (X > x1) x1 = X; if (V < y0) y0 = V; if (V > y1) y1 = V; };
      for (let j = 0; j < 48; j++) {
        const a = (j / 48) * TAU, ca = Math.cos(a), sa = Math.sin(a), r = R1 + (eo || 0) + (tilt ? 8 + FS * Math.max(0, sa) * Math.max(0, sa) : 8), ri = r1 + (ei || 0) + (tilt ? FSI * Math.max(0, sa) * Math.max(0, sa) : 0);
        add(r * ca, r * sa, zo + THO + lf); add(r * ca, r * sa, zo); add(ri * ca, ri * sa, zi + THI + lf); add(HUB * ca, HUB * sa * Math.max(1, HUB_R / Math.max(c, 0.05)), zh + THH);
        if (sh && tilt) {
          const rs = (R0 + R1) / 2 + 4 + FS + (eo || 0), ys = rs * sa + 24, zs = zo - 1 - AIR * (tilt / TILT), Ys = ys * c - zs * s, ps = DEPTH / (DEPTH - (ys * s + zs * c)), xs = rs * ca * ps, vs = (Ys - YC) * ps + YC, ra = SH_REACH * 180 * ps, rd = ra * c;
          if (xs - ra < x0) x0 = xs - ra; if (xs + ra > x1) x1 = xs + ra; if (vs - rd < y0) y0 = vs - rd; if (vs + rd > y1) y1 = vs + rd;
        }
      }
      return { x0, y0, x1, y1 };
    };
    const fitTo = (bb, box, wMax) => {
      const k = Math.max(0.05, Math.min((box.r - box.l) / (bb.x1 - bb.x0), (box.b - box.t) / (bb.y1 - bb.y0), wMax == null ? Infinity : wMax / (bb.x1 - bb.x0)));
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
      const eo = EX.o * (1 + DRIFT), ei = EX.i * (1 + DRIFT);
      const flatBB = bboxOf(0, 0, 0, 0), endBB = bboxOf(0, 0, 0, 0, 14 + 0.81 * RIP_W), openBB = bboxOf(TILT, OPEN.zO, OPEN.zI, OPEN.zH, eo, ei, true), tr = tile.getBoundingClientRect();
      /* endBB: the wheel at the end with the air it needs: the seating ripple's reach (drawn out to about 0.8 of RIP_W) and the pieces still coming home while the camera closes in. */
      /* Where the hint goes, under the wheel at rest. */
      const hintAt = (show) => { hint.style.display = show ? "" : "none"; hint.style.left = F.flat.x + "px"; hint.style.top = F.flat.y + F.flat.k * flatBB.y1 + (phone ? 6 : 10) + "px"; };
      /* One frame for the open wheel, fitted once from what is in the DOM: the words, the legend, the card. Every box keeps EDGE from the tile. */
      if (phone) {
        /* The words sit above the wheel and the legend below it, all in the one tile. The wheel takes the band between them (a little less air from the words on a small band); at rest
           it leaves room for the hint; at a stop it takes what the stop's words and card leave; at the end what the last words leave. */
        const sub0 = hx[0].querySelector(".rfw-sub"), leg = hx[0].querySelector(".rfw-legend");
        const headB = bottomOf(hx[0], sub0), legT = hx[0].offsetTop + leg.offsetTop, gy = clamp(8, EDGE, (legT - headB) * 0.06), box = { l: EDGE, t: headB + gy, r: W - EDGE, b: legT - gy };
        F.open = fitTo(openBB, box);
        F.flat = fitTo(flatBB, { l: box.l, t: box.t, r: box.r, b: box.b - HINT_H });
        hintAt(true);
        const textB = Math.max.apply(null, stops.map((s, i) => bottomOf(s, tx_[i]))), cardT = Math.min.apply(null, stops.map((s, i) => s.offsetTop + cards[i].offsetTop));
        F.stop = fitTo(openBB, { l: EDGE, t: textB + EDGE, r: W - EDGE, b: cardT - EDGE });
        F.end = fitTo(endBB, { l: pad, t: bottomOf(hx[1], hx[1].lastElementChild) + 18, r: W - pad, b: H - 18 });
      } else {
        /* The words keep one column, on the left where the hero's words were; the wheel keeps the right of the stage. */
        const cr = copy ? copy.getBoundingClientRect() : null, L = cr ? Math.max(pad, cr.left - tr.left) : pad, gap = Math.max(24, W * 0.02);
        tile.style.setProperty("--rfw-l", L + "px");
        const colR = hx[0].offsetLeft + hx[0].offsetWidth, restL = (cr ? cr.right - tr.left : colR) + gap;
        F.flat = fitTo(flatBB, { l: restL, t: pad, r: W - pad, b: H - pad - 28 }, H * 0.74);
        F.end = fitTo(endBB, { l: restL, t: pad, r: W - pad, b: H - pad - 28 }, H * 0.74);
        hintAt(true);
        F.open = F.stop = fitTo(openBB, { l: colR + gap, t: EDGE, r: W - EDGE, b: H - EDGE });
      }
      ringC = getComputedStyle(el).getPropertyValue("--b500").trim() || "#2b4c88";
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
      /* The object is sized once, where it stands: on the front piece of the exploded ring. */
      const Z = (RT + FS + eo) * Math.sin(TILT * RAD) + (OPEN.zO + THO + LF) * Math.cos(TILT * RAD);
      tokPx = Math.round(F.stop.k * (DEPTH / (DEPTH - Z)) * TOKW);
      tok.style.setProperty("--tok", tokPx + "px");
      force = true;
      if (resized) draw(); else mark();
    };

    pinTop = parseFloat(getComputedStyle(pin).top) || 0;
    /* One timeline holds the whole story and owns the one ScrollTrigger. Scroll is its playhead, so it reverses exactly. */
    let hov = -1, tipI = -1, tipT = 0, focused = false, curP = -1, drag = null, goTw = null, ready = false;
    const IO = "power2.inOut", OUT = "power3.out", IN = "power2.in", rp = opts.refreshPriority == null ? 0 : opts.refreshPriority, scrub = opts.scrub == null ? (root.matchMedia("(hover: none) and (pointer: coarse)").matches ? 0.3 : 0.7) : opts.scrub;
    /* The trial button below the words is clickable only from GO_AT on, when its words are up (rfw-go-on); rfw-go-in says it is on screen. */
    let goOn = false;
    const T = g.timeline({ defaults: { ease: "none" }, onUpdate: () => { mark(); const on = T.time() >= GO_AT; if (on !== goOn) { goOn = on; el.classList.toggle("rfw-go-on", on); } }, paused: true });
    /* Made once the timeline is whole, so scroll only ever plays a finished story. */
    let trig = null;
    /* Rest on a label where there is something to read. Through the come-apart and the way home the scroll just holds the pieces
       wherever it stops, so a long flight never pulls against the hand. */
    const nearBeat = (v, self) => {
      /* v is where the hand's speed would carry the page; it only picks the beat. Where nothing is chosen the page stays at its own progress, so it never moves after the hand stops. */
      const stay = self ? self.progress : v;
      if (!calm()) return stay;
      const t = v * END;
      if ((t > 0.15 && t < T_OPEN - 0.5) || (t > C0 && t < END - 1.1)) return stay;
      let b = BEATS[0][0];
      for (const x of BEATS) if (Math.abs(x[0] - t) < Math.abs(b - t)) b = x[0];
      return b / END;
    };
    const link = () => {
      trig = ST.create({
        animation: T, trigger: el, start: phone ? () => "top " + pinTop + "px" : 0, end: "bottom bottom",
        scrub,
        snap: opts.snap === false ? false : { snapTo: nearBeat, duration: { min: 0.35, max: 0.8 }, delay: 0.3, ease: "power2.out", inertia: true },
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
    if (!phone && copy) T.to(copy, { autoAlpha: 0, y: -28, duration: 0.5, ease: IN }, 0.1);
    if (phone) g.set(hx[0], { autoAlpha: 1, y: 0 }); else show(hx[0], 0.1, 0.5);
    hide(hint, 0.02, 0.3);
    T.to(S, { wA: 1, duration: 4.4, ease: "power1.inOut" }, 0.05);
    T.to(S, { spO: 54, spI: -36, duration: 7, ease: HEAVY }, 0.6);
    T.to(S, { lift: 1, duration: 5.2, ease: HEAVY }, 0.7);
    T.to(S, { dr: 1, duration: 5, ease: "sine.out" }, 3.3);
    WD.forEach((w) => {
      const p = P[w.i], at = w.o ? 1.4 + w.rank * 0.4 : 1.1 + w.rank * 0.36;
      T.to(p, { e: -0.03, duration: 0.5, ease: "sine.inOut" }, 0.35);
      T.to(p, { e: 1, duration: 4.5, ease: HEAVY }, at);
      T.to(p, { c: 1, duration: 1.2, ease: IO }, at + 0.5);
    });
    /* The legend carries every name while the wheel is open; the first stop's words take its place as they leave. */
    hide(hx[0], S0 - HOLD);
    /* The ring brings the first stop to the front and the object drops onto it. The pieces stay apart. */
    T.to(S, { spO: TURN[0], duration: 0.8, ease: IO }, T_SEEN + 0.05);
    T.to(S, { wS: 1, duration: 0.5, ease: IO }, S0 - HOLD - 0.3);
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
      T.fromTo(tx_[i], { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.3, ease: OUT }, i ? stopAt(i - 1) + HOLD - 0.22 : S0 - HOLD);
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
    T.to(S, { wE: 1, duration: 2.8, ease: IO }, C0 + 0.3);
    T.to(S, { lift: 0, duration: 2.7, ease: HOME }, C0 + 0.05);
    WD.forEach((w) => {
      const p = P[w.i], at = C0 + (w.o ? 0.05 + (5 - w.rank) * 0.1 : 0.05 + (2 - w.rank) * 0.12);
      T.to(p, { e: 0, duration: 2.6, ease: HOME }, at);
      T.to(p, { c: 0, duration: 0.5, ease: IO }, C0 + 3.45 + (w.i % 7) * 0.03);
    });
    T.fromTo(S, { rip: 0 }, { rip: 1, duration: 0.35, ease: "power2.out", immediateRender: false }, C0 + 3);
    show(hx[1], C0 - 0.22, 0.4);
    /* On a phone the trial lead and button sit over the stop's frame until the camera is well on its way, so they come up later than the heading. */
    if (phone) T.fromTo(hx[1].querySelector(".sy-go"), { opacity: 0 }, { opacity: 1, duration: 0.4, ease: OUT }, GO_SHOW);
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
      goTw = g.to(o, { y, duration: clamp(0.4, 0.9, 0.4 + dist * 2), ease: IO, onUpdate: () => trig.scroll(o.y) });
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
      if (hubF !== hubUp) { hubF = hubF < hubUp ? Math.min(hubUp, hubF + dt * 8) : Math.max(hubUp, hubF - dt * 8); force = true; mark(); }
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
    /* The trial button is reachable by Tab while its words are away; focus brings the end of the story to it. */
    const goLink = $(".rfw-h .sy-go a"), onGoFocus = () => { if (T.time() < GO_AT) goTo("one"); };
    /* The person's own hand wins: any wheel, touch or key stops a tile's glide at once. */
    const stopGo = () => { if (goTw) { goTw.kill(); goTw = null; } }, hand = { passive: true, capture: true };
    let goIO = null;
    const onFocus = (e) => { const i = +e.target.dataset.i; if (e.target.matches(":focus-visible")) { focused = true; focusI = i; force = true; over(i); mark(); } };
    const onBlur = () => { focused = false; focusI = -1; force = true; over(-1); mark(); };
    const onKey = (e) => {
      const i = +e.target.dataset.i;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); goTo(beatOf(i)); }
      const k = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (k) { e.preventDefault(); const n = mod(i + k, N); btns[i].tabIndex = -1; btns[n].tabIndex = 0; btns[n].focus(); }
    };
    const on = [[cv, "pointerdown", onDown], [cv, "pointermove", onMove], [cv, "pointerup", onUp], [cv, "pointercancel", onUp], [cv, "pointerleave", onLeave], [wheelBox, "focusin", onFocus], [wheelBox, "focusout", onBlur], [wheelBox, "keydown", onKey], [goLink, "focusin", onGoFocus]];
    const onRI = () => layout();
    let roSeen = false, alive = true, jobId = 0;
    /* The first report only repeats the layout the build has just done. */
    const ro = new ResizeObserver(() => { if (!roSeen) { roSeen = true; return; } layout(); draw(); });
    /* The first scroll should not meet cold code. In idle moments, draw each kind of pose, then put the true state back and
       draw that in the same moment, so nothing ever shows. */
    const OPENED = { wA: 1, lift: 1, dr: 1 };
    const WARMS = [Object.assign({ spO: 54, spI: -36 }, OPENED), Object.assign({ wS: 1, spO: 54, spI: -36 }, OPENED), Object.assign({ wS: 1, focO: 1, obj: 1, u: 2.4, hop: 0.5, fall: 0, spO: 90 }, OPENED), Object.assign({}, OPENED, { wS: 1, wE: 0.5, lift: 0.5, rip: 0.5, spO: 320, spI: -240 })];
    let warmId = 0, warmN = 0;
    const warm = () => {
      warmId = 0;
      if (!alive || trig.isActive) return;
      const keepS = Object.assign({}, S), keepP = P.map((p) => Object.assign({}, p)), w = WARMS[warmN % WARMS.length];
      Object.assign(S, w);
      P.forEach((p, i) => { p.c = 1; p.e = warmN % 2 ? 0.5 : 1; p.w = i === (warmN * 3) % P.length ? 1 : 0; });
      for (let j = 0; j < 3; j++) { force = true; S.spO += 7; S.spI += 5; draw(); }
      Object.assign(S, keepS);
      P.forEach((p, i) => Object.assign(p, keepP[i]));
      force = true; draw();
      warmN++;
      if (warmN < WARMS.length * 3) warmId = idle(warm);
      else { force = true; draw(); }
    };
    const fontsIn = () => { if (!alive) return; const h0 = ends(); layout(); if (Math.abs(h0 - ends()) > 0.5) refreshCalm(); else trig.refresh(); };
    /* The build as a short list of jobs: each stop with its own DOM, then the canvas and its listeners, then the finish. Lazily, one per idle moment. */
    /* Where the visitor is in the story, kept as they scroll, so a turn of the phone (the wheel is built again for the other shape) puts them back at the same place. */
    const trackKeep = () => {
      if (!trig) return;
      const y = root.scrollY, a = trig.start, z = trig.end;
      inst.keep = y < a ? { m: 0, y } : y > z ? { m: 2, d: y - z } : { m: 1, p: (y - a) / Math.max(1, z - a) };
    };
    const onRefreshed = () => { lastRef = now(); };
    const arm = () => {
      root.addEventListener("scroll", trackKeep, { passive: true });
      ["wheel", "touchstart", "keydown"].forEach((n) => root.addEventListener(n, stopGo, hand));
      ST.addEventListener("refresh", onRefreshed);
      if (root.IntersectionObserver) { goIO = new IntersectionObserver((es) => { es.forEach((e) => el.classList.toggle("rfw-go-in", e.isIntersecting)); }, { rootMargin: "-68px 0px 0px 0px" }); goIO.observe(goLink); }
      on.forEach(([t, n, f]) => t.addEventListener(n, f));
      g.ticker.add(tick);
      ST.addEventListener("refreshInit", onRI);
      ro.observe(tile);
      layout();
      link();
      ready = true;
    };
    const finish = () => {
      if (Math.abs(held0 - ends()) > 0.5) Promise.resolve().then(() => { if (alive) refreshCalm(); }); else ST.sort();
      if (document.fonts && document.fonts.status !== "loaded" && document.fonts.ready) document.fonts.ready.then(fontsIn);
      delete inst.flush;
      /* Built again after a turn: back to the same place. */
      const k = inst.keep;
      if (k && inst.rebuilt) {
        const put = () => { if (!alive || !trig) return; const y = k.m === 0 ? k.y : k.m === 1 ? trig.start + k.p * (trig.end - trig.start) : trig.end + k.d; const s0 = html.style.scrollBehavior; html.style.scrollBehavior = "auto"; root.scrollTo(0, y); html.style.scrollBehavior = s0; };
        put(); Promise.resolve().then(put); root.requestAnimationFrame(put);
      }
      inst.rebuilt = true;
      Object.assign(inst, { live: true, built: true, T, trig, S, P, Sp, cam: () => ({ ...cam }), at: (t) => trig.start + ((trig.end - trig.start) * t) / END, redraw: () => { force = true; whole = true; draw(); } });
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
      root.removeEventListener("scroll", trackKeep);
      ["wheel", "touchstart", "keydown"].forEach((n) => root.removeEventListener(n, stopGo, hand));
      ST.removeEventListener("refresh", onRefreshed);
      if (goIO) goIO.disconnect();
      el.classList.remove("rfw-go-on", "rfw-go-in");
      on.forEach(([t, n, f]) => t.removeEventListener(n, f));
      clearTimeout(tipT);
      if (goTw) goTw.kill();
      html.style.scrollBehavior = "";
      if (!pageTop) el.style.removeProperty("--rfw-top");
      ["T", "trig", "S", "P", "Sp", "cam", "at", "redraw", "flush"].forEach((k) => { delete inst[k]; });
      inst.live = false;
    };
  }

  const api = { mount, staticHTML, goHTML, go: GO, refresh: refreshCalm, cards: CARD, data: ALL, icons: ICON, beats: planOf(false).BEATS };
  root.RFWheel = api;
  if (typeof document !== "undefined") {
    const all = () => { if (root.RFScenes) root.RFScenes.wheel = mount; document.querySelectorAll('[data-scene="wheel"]').forEach((e) => mount(e)); };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", all); else all();
  }
})(typeof window !== "undefined" ? window : globalThis);
