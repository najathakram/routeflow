// RouteFlow Unified — delight layer.
// Motion language: 120ms press · 240ms enter · 400ms celebrate · spring cubic-bezier(.3,1.4,.5,1)
// Honors prefers-reduced-motion. Load AFTER icons.js.
(function () {
  var reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  var css = [
    '.btn,.chip,.iconbtn,.pgbtn,.cb{transition:transform .13s cubic-bezier(.3,1.4,.5,1),background .12s,box-shadow .12s}',
    '.btn:active,.chip:active,.iconbtn:active,.pgbtn:active{transform:scale(.955)}',
    '.card{transition:box-shadow .18s}',
    '.stat{transition:transform .18s cubic-bezier(.2,.9,.3,1),box-shadow .18s}',
    '.stat:hover{transform:translateY(-2px);box-shadow:0 6px 18px rgba(15,27,45,.08)}',
    '@keyframes dl-rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}',
    '@keyframes dl-pop{0%{transform:scale(.4)}60%{transform:scale(1.3)}100%{transform:scale(1)}}',
    '@keyframes dl-ring{0%,100%{transform:rotate(0)}20%{transform:rotate(14deg)}40%{transform:rotate(-11deg)}60%{transform:rotate(7deg)}80%{transform:rotate(-4deg)}}',
    '@keyframes dl-dot{to{transform:translate(var(--dx),var(--dy)) rotate(240deg) scale(.3);opacity:0}}',
    '@keyframes dl-toast{from{opacity:0;transform:translateX(30px)}to{opacity:1;transform:none}}',
    '@keyframes dl-sweep{from{left:-40%}to{left:120%}}',
    '@keyframes dl-flash{0%{background:#DCFCE7}100%{background:transparent}}',
    '@keyframes dl-pulse{0%,100%{opacity:1}50%{opacity:.55}}',
    '.dl-rise{animation:dl-rise .4s cubic-bezier(.2,.9,.3,1) both}',
    '.toast{animation:dl-toast .34s .5s cubic-bezier(.2,.9,.3,1) both}',
    '@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}'
  ].join('\n');
  var st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  function onReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn); else fn();
  }

  // format helper: keeps $ prefix, commas, decimals of the original string
  function animateValue(el) {
    var raw = el.textContent.trim();
    var m = raw.match(/^(\$?)([\d,]+)(\.\d{2})?$/);
    if (!m) return;
    var prefix = m[1];
    var target = parseFloat((m[2] + (m[3] || '')).replace(/,/g, ''));
    var decimals = m[3] ? 2 : 0;
    var t0 = null, dur = 750;
    function fmt(v) {
      return prefix + v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    }
    function step(ts) {
      if (!t0) t0 = ts;
      var k = Math.min(1, (ts - t0) / dur);
      var e = 1 - Math.pow(1 - k, 3);
      el.textContent = fmt(target * e);
      if (k < 1) requestAnimationFrame(step); else el.textContent = raw;
    }
    requestAnimationFrame(step);
  }

  // confetti burst from an element's center
  function burst(el, n) {
    var r = el.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var colors = ['#14A39F', '#16A34A', '#D97706', '#7FD1CD', '#0284C7'];
    var host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:9999;pointer-events:none';
    document.body.appendChild(host);
    for (var i = 0; i < (n || 16); i++) {
      var d = document.createElement('span');
      var ang = Math.random() * Math.PI * 2;
      var dist = 44 + Math.random() * 66;
      var sz = 4 + Math.random() * 5;
      d.style.cssText = 'position:fixed;left:' + (cx - sz / 2) + 'px;top:' + (cy - sz / 2) + 'px;width:' + sz + 'px;height:' + sz + 'px;border-radius:' + (Math.random() > 0.5 ? '50%' : '2px') + ';background:' + colors[i % colors.length] + ';--dx:' + Math.cos(ang) * dist + 'px;--dy:' + (Math.sin(ang) * dist - 26) + 'px;animation:dl-dot ' + (550 + Math.random() * 300) + 'ms cubic-bezier(.2,.7,.4,1) both';
      host.appendChild(d);
    }
    setTimeout(function () { host.remove(); }, 1000);
  }
  window.rfBurst = burst;

  onReady(function () {
    // staggered card entrance + KPI count-up
    if (!reduced) {
      var i = 0;
      document.querySelectorAll('.card,.stat,.bulkbar,.panel').forEach(function (el) {
        el.classList.add('dl-rise');
        el.style.animationDelay = Math.min(i * 36, 420) + 'ms';
        i++;
      });
      document.querySelectorAll('.stat .v, .pipe .cell .n').forEach(animateValue);
    }

    // notification bell: shake + badge pop on click
    document.querySelectorAll('.iconbtn').forEach(function (b) {
      var badge = b.querySelector('.nbadge');
      if (!badge) return;
      b.addEventListener('click', function () {
        var svg = b.querySelector('svg');
        if (svg) { svg.style.animation = 'none'; void svg.offsetWidth; svg.style.animation = 'dl-ring .6s ease-in-out'; }
        badge.style.animation = 'none'; void badge.offsetWidth; badge.style.animation = 'dl-pop .4s cubic-bezier(.3,1.4,.5,1)';
      });
    });

    // checkboxes: toggle with a pop
    document.querySelectorAll('.cb').forEach(function (cb) {
      if (cb.classList.contains('ind')) return;
      cb.addEventListener('click', function (e) {
        e.stopPropagation();
        var on = cb.classList.toggle('on');
        cb.innerHTML = on ? '<span style="color:#fff;font-size:11px;line-height:1;font-weight:700">✓</span>' : '';
        if (on) { cb.style.animation = 'none'; void cb.offsetWidth; cb.style.animation = 'dl-pop .32s cubic-bezier(.3,1.4,.5,1)'; }
      });
    });

    // saved-view chips: single-active toggle
    document.querySelectorAll('.chip').forEach(function (ch) {
      ch.addEventListener('click', function () {
        var sibs = ch.parentElement.querySelectorAll('.chip');
        sibs.forEach(function (c) { c.classList.remove('active'); });
        ch.classList.add('active');
      });
    });

    // celebration on marked actions (deliver / save / complete)
    document.querySelectorAll('[data-celebrate]').forEach(function (b) {
      b.addEventListener('click', function () { burst(b); });
    });

    // urgent markers pulse gently
    document.querySelectorAll('tr.urgent i[data-ic="alert"], tr.urgent svg').forEach(function (el) {
      el.style.animation = 'dl-pulse 2.2s ease-in-out infinite';
    });

    // scan input demo: sweep + flash the first line row ("just-scanned auto-scroll" cue)
    document.querySelectorAll('.scaninput').forEach(function (s) {
      s.style.position = 'relative'; s.style.overflow = 'hidden';
      s.addEventListener('click', function () {
        var sweep = document.createElement('span');
        sweep.style.cssText = 'position:absolute;top:0;bottom:0;width:34%;left:-40%;background:linear-gradient(90deg,transparent,rgba(20,163,159,.22),transparent);animation:dl-sweep .55s ease-out both;pointer-events:none';
        s.appendChild(sweep);
        setTimeout(function () { sweep.remove(); }, 650);
        var row = document.querySelector('.lirow');
        if (row) { row.style.animation = 'none'; void row.offsetWidth; row.style.animation = 'dl-flash 1s ease-out'; }
      });
    });
  });
})();
