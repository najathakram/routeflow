/**
 * Buyer Portal E2E Test Script
 *
 * Tests all buyer portal API endpoints against a running server.
 * Creates test data, runs assertions, and cleans up.
 *
 * Usage:
 *   DATABASE_URL=... node apps/api/scripts/test-buyer-portal.js
 *
 * Prerequisites:
 *   - API server running on localhost:3000
 *   - Database with seed data (run fresh-data.js first)
 *   - `harbor_cafe` customer with `Customer1!` password
 */

const API = "http://localhost:3000/api/v1";
let BUYER_TOKEN = "";
let TENANT_SLUG = "";
let MANIFEST = { favorites: [], orders: [] };

async function api(method, path, body, headers = {}) {
  const h = { "Content-Type": "application/json", ...headers };
  if (BUYER_TOKEN) h["Authorization"] = `Bearer ${BUYER_TOKEN}`;
  if (TENANT_SLUG) h["X-Tenant-Slug"] = TENANT_SLUG;

  const opts = { method, headers: h };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${API}${path}`, opts);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`  PASS: ${msg}`);
  }
}

async function run() {
  console.log("\n=== Buyer Portal E2E Tests ===\n");

  // 1. Buyer Login
  console.log("1. Buyer Authentication");
  const loginRes = await api("POST", "/buyer/auth/login", {
    email: "harbor@cafe.com",
    password: "Customer1!",
  });
  if (loginRes.status !== 200 && loginRes.status !== 201) {
    console.error(
      "  FAIL: Could not login as buyer. Is the server running with seed data?",
      loginRes.data,
    );
    console.log("\n  Skipping remaining tests (no auth).");
    return;
  }
  BUYER_TOKEN = loginRes.data.access_token;
  assert(!!BUYER_TOKEN, "Buyer login returns access_token");

  // 2. Get Sellers
  console.log("\n2. List Sellers");
  const sellers = await api("GET", "/buyer/sellers");
  assert(sellers.status === 200, `GET /buyer/sellers returns 200 (got ${sellers.status})`);
  assert(Array.isArray(sellers.data), "Sellers is an array");
  if (sellers.data.length > 0) {
    TENANT_SLUG = sellers.data[0].tenant?.slug || "";
    console.log(`  Using tenant slug: ${TENANT_SLUG}`);
  } else {
    console.log("  No sellers found, skipping seller-scoped tests");
    return;
  }

  // 3. Product Catalog
  console.log("\n3. Product Catalog");
  const products = await api("GET", "/buyer/products?page=1&limit=5");
  assert(products.status === 200, `GET /buyer/products returns 200 (got ${products.status})`);
  assert(products.data.data?.length >= 0, "Products returns paginated data array");
  assert(products.data.meta?.total !== undefined, "Products returns meta.total");

  // Test search
  const searchRes = await api("GET", "/buyer/products?search=bread");
  assert(searchRes.status === 200, "Product search works");

  // Test categories
  const categories = await api("GET", "/buyer/products/categories");
  assert(
    categories.status === 200,
    `GET /buyer/products/categories returns 200 (got ${categories.status})`,
  );
  assert(Array.isArray(categories.data), "Categories is an array");

  // Test price sort
  const priceSorted = await api("GET", "/buyer/products?sort=price_asc&page=1&limit=5");
  assert(priceSorted.status === 200, "Price sort returns 200");
  if (priceSorted.data.data?.length > 1) {
    const prices = priceSorted.data.data.map((p) => p.buyerPrice);
    const isSorted = prices.every((p, i) => i === 0 || p >= prices[i - 1]);
    assert(isSorted, "Price-sorted products are in ascending order");
  }

  // Test product detail
  if (products.data.data?.length > 0) {
    const pid = products.data.data[0].id;
    const detail = await api("GET", `/buyer/products/${pid}`);
    assert(detail.status === 200, `GET /buyer/products/:id returns 200`);
    assert(detail.data.buyerPrice !== undefined, "Product detail has buyerPrice");
  }

  // 4. Dashboard
  console.log("\n4. Dashboard");
  const dashboard = await api("GET", "/buyer/dashboard");
  assert(dashboard.status === 200, `GET /buyer/dashboard returns 200 (got ${dashboard.status})`);
  assert(dashboard.data.stats !== undefined, "Dashboard has stats");
  assert(dashboard.data.recentOrders !== undefined, "Dashboard has recentOrders");
  assert(dashboard.data.frequentlyOrdered !== undefined, "Dashboard has frequentlyOrdered");
  assert(dashboard.data.newFromSeller !== undefined, "Dashboard has newFromSeller");
  assert(dashboard.data.suggestedItems !== undefined, "Dashboard has suggestedItems");
  assert(dashboard.data.featuredItems !== undefined, "Dashboard has featuredItems");

  // Test frequent window filter
  const dash30d = await api("GET", "/buyer/dashboard?frequentWindow=30d");
  assert(dash30d.status === 200, "Dashboard with frequentWindow=30d returns 200");

  // 5. Orders
  console.log("\n5. Orders");
  const orders = await api("GET", "/buyer/orders?page=1&limit=10");
  assert(orders.status === 200, `GET /buyer/orders returns 200 (got ${orders.status})`);

  // Create a test order
  if (products.data.data?.length > 0) {
    const testProduct = products.data.data[0];
    const createRes = await api("POST", "/buyer/orders", {
      items: [{ productId: testProduct.id, qty: 2 }],
      notes: "E2E test order",
      status: "DRAFT",
    });
    assert(
      createRes.status === 201 || createRes.status === 200,
      `Create order returns 200/201 (got ${createRes.status})`,
    );
    if (createRes.data?.id) {
      MANIFEST.orders.push(createRes.data.id);
      console.log(`  Created test order: ${createRes.data.orderNumber || createRes.data.id}`);

      // Get order detail
      const orderDetail = await api("GET", `/buyer/orders/${createRes.data.id}`);
      assert(orderDetail.status === 200, "GET /buyer/orders/:id returns 200");
      assert(orderDetail.data.lineItems?.length > 0, "Order has line items");

      // Edit order items
      const editRes = await api("PATCH", `/buyer/orders/${createRes.data.id}/items`, {
        items: [{ productId: testProduct.id, qty: 5 }],
      });
      assert(
        editRes.status === 200,
        `PATCH /buyer/orders/:id/items returns 200 (got ${editRes.status})`,
      );

      // Cancel order
      const cancelRes = await api("POST", `/buyer/orders/${createRes.data.id}/cancel`);
      assert(
        cancelRes.status === 200,
        `POST /buyer/orders/:id/cancel returns 200 (got ${cancelRes.status})`,
      );
    }
  }

  // 6. Favorites
  console.log("\n6. Favorites");
  if (products.data.data?.length > 0) {
    const favProduct = products.data.data[0];

    // Add favorite
    const addFav = await api("POST", `/buyer/favorites/${favProduct.id}`);
    assert(
      addFav.status === 201 || addFav.status === 200,
      `Add favorite returns 201 (got ${addFav.status})`,
    );
    MANIFEST.favorites.push(favProduct.id);

    // List favorites
    const favList = await api("GET", "/buyer/favorites");
    assert(favList.status === 200, "GET /buyer/favorites returns 200");
    assert(Array.isArray(favList.data), "Favorites is an array");
    const hasFav = favList.data.some((f) => f.productId === favProduct.id);
    assert(hasFav, "Favorited product appears in list");

    // Duplicate add should conflict
    const dupFav = await api("POST", `/buyer/favorites/${favProduct.id}`);
    assert(dupFav.status === 409, `Duplicate favorite returns 409 (got ${dupFav.status})`);

    // Remove favorite
    const remFav = await api("DELETE", `/buyer/favorites/${favProduct.id}`);
    assert(remFav.status === 200, `Remove favorite returns 200 (got ${remFav.status})`);
    MANIFEST.favorites = [];
  }

  // 7. Templates
  console.log("\n7. Templates");
  const templates = await api("GET", "/buyer/templates");
  assert(templates.status === 200, `GET /buyer/templates returns 200 (got ${templates.status})`);

  // 8. Route ordering verification
  console.log("\n8. Route Ordering");
  const routeProducts = await api("GET", "/buyer/products");
  assert(routeProducts.status === 200, "GET /buyer/products is NOT shadowed by :id route");
  assert(routeProducts.data.data !== undefined, "Returns paginated data (not product detail)");

  console.log("\n=== Test Summary ===");
  console.log(`Test orders to clean up: ${MANIFEST.orders.length}`);
  console.log(`Test favorites to clean up: ${MANIFEST.favorites.length}`);

  // Cleanup
  console.log("\n=== Cleanup ===");
  for (const fav of MANIFEST.favorites) {
    await api("DELETE", `/buyer/favorites/${fav}`);
    console.log(`  Removed favorite: ${fav}`);
  }
  // Orders are already cancelled, no further cleanup needed
  console.log("  Cleanup complete.");
}

run().catch(console.error);
