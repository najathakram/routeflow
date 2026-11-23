/* The prices: ONE object. Swap the numbers here; site.js writes them into every [data-plan][data-field] and [data-addon][data-field].
   Source: apps/api/prisma/plan-catalog-v13.definitions.ts (newest catalog). v13 changes only Lite's flags, so
   prices and customers are the rows it inherits from v11/v12.
   Yearly price = monthly x 10 ("2 months free", billing-math.ts), computed below. Enterprise has no stored price.
   SA-1080 (2026-11-01): plans differ by price and customers included only. Seats are unlimited on every plan; routes and scans are not shown
   (messages are not shown either), and the Forecasting add-on is off the page (open to every plan). */
window.RF_PRICES = {
  catalogVersion: 13,
  currency: "USD",
  yearlyMonthsBilled: 10,
  trialDays: 14,
  plans: {
    STARTER: { name: "Starter", monthly: 99, customers: 100 },
    GROWTH: { name: "Growth", monthly: 249, customers: 250 },
    SCALE: { name: "Scale", monthly: 499, customers: 500 }
  },
  enterprise: { custom: true },
  /* Add-ons, billed monthly. Regulated items: $39 on Starter and Growth, no fee on Scale and Enterprise, switched on by us. */
  addons: {
    REGULATED: { name: "Regulated items", monthly: 39 },
    CUSTOMER_PACK: { name: "Customer pack", monthly: 50, customers: 100, stackable: true }
  }
};
(function () {
  var P = window.RF_PRICES;
  Object.keys(P.plans).forEach(function (k) { P.plans[k].yearly = P.plans[k].monthly * P.yearlyMonthsBilled; });
})();
