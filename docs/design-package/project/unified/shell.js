// RouteFlow Unified — shared shell renderer. Load in <head> AFTER rf.css link, use document.write in body.
// RFShell.operatorRail(activeKey) / RFShell.topbar(title) / RFShell.buyerRail(activeKey) / RFShell.adminRail(activeKey)
(function () {
  function nl(key, active, ic, label, indent) {
    return '<a class="nl' + (key === active ? ' active' : '') + '"' + (indent ? ' style="padding-left:36px;height:31px;font-size:12.5px"' : '') + '>' +
      (ic ? '<i data-ic="' + ic + '"></i>' : '') + label + '</a>';
  }
  function group(ic, label, open, kidsHtml) {
    return '<div class="ng' + (open ? ' open' : '') + '"><button class="ng-head"><i data-ic="' + ic + '"></i>' + label +
      '<i class="chev" data-ic="' + (open ? 'chevdown' : 'chevright') + '" data-sz="14"></i></button>' +
      (open ? '<div class="ng-kids">' + kidsHtml + '</div>' : '') + '</div>';
  }

  window.RFShell = {
    operatorRail: function (a) {
      var inOrders = a.indexOf('orders.') === 0, inDisp = a.indexOf('dispatch.') === 0,
          inWh = a.indexOf('wh.') === 0, inFin = a.indexOf('fin.') === 0;
      return '<aside class="rail">' +
        '<div class="rail-brand"><div class="rail-logo">GS</div><div><div class="t">Golden State Dist.</div><div class="s">RouteFlow</div></div></div>' +
        '<nav>' +
        nl('dashboard', a, 'grid', 'Dashboard') +
        group('package', 'Orders', inOrders,
          nl('orders.all', a, '', 'All Orders', 1) + nl('orders.returns', a, '', 'Returns', 1)) +
        group('truck', 'Dispatch', inDisp,
          nl('dispatch.overview', a, '', 'Overview', 1) + nl('dispatch.routes', a, '', 'Routes', 1) +
          nl('dispatch.drivers', a, '', 'Drivers', 1) + nl('dispatch.myruns', a, '', 'My Routes', 1)) +
        nl('customers', a, 'users', 'Customers') +
        nl('messages', a, 'chat', 'Messages') +
        group('warehouse', 'Warehouse', inWh,
          nl('wh.inventory', a, '', 'Inventory', 1) + nl('wh.products', a, '', 'Products', 1) +
          nl('wh.suppliers', a, '', 'Suppliers', 1) + nl('wh.bills', a, '', 'Bills &amp; Purchasing', 1)) +
        group('dollar', 'Finance', inFin,
          nl('fin.overview', a, '', 'Overview', 1) + nl('fin.invoices', a, '', 'Invoices', 1) +
          nl('fin.estimates', a, '', 'Estimates', 1) + nl('fin.credit', a, '', 'Credit Notes', 1) +
          nl('fin.payments', a, '', 'Payments', 1) + nl('fin.expenses', a, '', 'Expenses', 1) +
          nl('fin.reports', a, '', 'Reports', 1)) +
        nl('analytics', a, 'chart', 'Analytics') +
        nl('tobacco', a, 'shield', 'Regulated Items') +
        nl('settings', a, 'sliders', 'Settings') +
        '</nav><div class="rail-foot"><a class="nl"><i data-ic="chevleft"></i>Collapse</a></div></aside>';
    },

    topbar: function (title, extra) {
      return '<div class="topbar"><h1>' + title + '</h1>' + (extra || '') +
        '<div class="searchpill"><i data-ic="search" data-sz="15"></i>Search or jump to…<span class="kbd">⌘K</span></div>' +
        '<button class="iconbtn"><i data-ic="bell" data-sz="18"></i><span class="nbadge">3</span></button>' +
        '<div style="display:flex;align-items:center;gap:8px"><div class="avatar">ML</div>' +
        '<span style="font-size:13px;font-weight:600;color:var(--ink-900)">Maria</span>' +
        '<i data-ic="chevdown" data-sz="14" style="color:var(--ink-400)"></i></div></div>';
    },

    buyerRail: function (a) {
      function bl(key, ic, label, badge) {
        return '<a class="nl' + (key === a ? ' active' : '') + '"><i data-ic="' + ic + '"></i>' + label +
          (badge ? '<span style="margin-left:auto;min-width:18px;height:18px;padding:0 5px;border-radius:99px;background:var(--accent);color:#fff;font-size:10.5px;font-weight:700;display:grid;place-items:center">' + badge + '</span>' : '') + '</a>';
      }
      return '<aside class="rail" style="width:248px">' +
        '<div class="rail-brand"><div class="rail-logo">RF</div><div><div class="t">RouteFlow</div><div class="s">Buyer Portal</div></div>' +
        '<button class="iconbtn" style="margin-left:auto;color:rgba(255,255,255,.6)"><i data-ic="bell" data-sz="17"></i><span class="nbadge">2</span></button></div>' +
        '<nav>' + bl('settings', 'sliders', 'Settings') +
        '<div class="overline" style="color:rgba(255,255,255,.4);padding:14px 10px 6px">Your Sellers</div>' +
        '<div style="margin:0 6px 6px;padding:9px 10px;border-radius:8px;background:rgba(255,255,255,.1);display:flex;align-items:center;gap:9px">' +
        '<div style="width:26px;height:26px;border-radius:7px;background:var(--accent);display:grid;place-items:center;font-size:10.5px;font-weight:700;color:#fff">GS</div>' +
        '<div style="flex:1;min-width:0"><div style="font-size:12.5px;font-weight:600;color:#fff">Golden State Dist.</div><div style="font-size:10.5px;color:rgba(255,255,255,.45)">Sunrise Market</div></div>' +
        '<i data-ic="chevupdown" data-sz="13" style="color:rgba(255,255,255,.5)"></i></div>' +
        '<div class="overline" style="color:rgba(255,255,255,.4);padding:12px 10px 6px">Golden State Dist.</div>' +
        bl('dashboard', 'grid', 'Dashboard') + bl('shop', 'store', 'Shop', '3') + bl('favorites', 'heart', 'Favorites') +
        bl('orders', 'cart', 'Orders') + bl('invoices', 'filetext', 'Invoices') + bl('finances', 'chart', 'Finances') +
        bl('messages', 'chat', 'Messages', '1') + bl('standing', 'repeat', 'Standing Orders') + bl('account', 'user', 'Account') +
        '</nav><div class="rail-foot"><div style="padding:8px 10px;border-radius:8px;background:rgba(255,255,255,.06)">' +
        '<div style="font-size:12px;font-weight:600;color:#fff">Rosa Delgado</div><div style="font-size:11px;color:rgba(255,255,255,.45)">rosa@sunrisemkt.com</div></div></div></aside>';
    },

    adminRail: function (a) {
      function al(key, ic, label) { return '<a class="nl' + (key === a ? ' active' : '') + '"><i data-ic="' + ic + '"></i>' + label + '</a>'; }
      return '<aside class="rail">' +
        '<div class="rail-brand"><div class="rail-logo"><i data-ic="shield" data-sz="17"></i></div>' +
        '<div><div class="t">RouteFlow</div><div class="s" style="letter-spacing:.09em;text-transform:uppercase;font-size:9.5px">Platform Admin</div></div></div>' +
        '<nav>' + al('dashboard', 'grid', 'Dashboard') + al('tenants', 'store', 'Tenants') + al('buyers', 'users', 'Buyers') +
        al('merge', 'swap', 'Merge Requests') + al('plans', 'zap', 'Plans &amp; Features') + al('billing', 'card', 'Billing') +
        al('audit', 'filetext', 'Audit Logs') + al('ai', 'sliders', 'AI Settings') + al('profile', 'user', 'My Account') +
        '</nav><div class="rail-foot"><a class="nl" style="color:#FCA5A5"><i data-ic="x"></i>Sign out</a></div></aside>';
    }
  };
})();
