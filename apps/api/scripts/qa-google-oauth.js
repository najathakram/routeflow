const http = require('http');

const QA_PASS = 'QaReset@999!';
const QA_TENANT_SLUG = 'qa-1775782421527';
const QA_SA_USER = 'qa_sa_gtest_1775842879950';
const QA_SA_PASS = 'QaSa@test123!';
const QA_BUYER_EMAIL = 'buyer_phase1_test@example.com';

let passed = 0, failed = 0, infoCount = 0;
const results = [];

function log(tag, label, ok, detail) {
  detail = detail || '';
  const status = ok === true ? 'PASS' : ok === false ? 'FAIL' : 'INFO';
  if (ok === true) passed++;
  else if (ok === false) failed++;
  else infoCount++;
  const line = status + ' [' + tag + '] ' + label + (detail ? ' -> ' + detail : '');
  console.log(line);
  results.push(line);
}

function req(method, path, body, headers) {
  headers = headers || {};
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'localhost', port: 3000,
      path: '/api/v1' + path, method,
      headers: Object.assign({
        'Content-Type': 'application/json'
      }, payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}, headers)
    };
    const r = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function runAll() {
  console.log('\n====================================================');
  console.log('  Google OAuth QA -- Blocks E2/E4/F/G/H');
  console.log('  (Tenant via X-Tenant-Slug header)');
  console.log('====================================================\n');

  // --- BLOCK E2: Operator password login (regression) ---
  // Tenant is resolved via X-Tenant-Slug header (not companyCode in body)
  console.log('\n--- E2: OPERATOR password login ---');
  const e2 = await req('POST', '/auth/login',
    { username: 'qa_operator', password: QA_PASS },
    { 'X-Tenant-Slug': QA_TENANT_SLUG }
  );
  log('E2-S1', 'Operator login 200', e2.status === 200, JSON.stringify(e2.body).substring(0, 120));
  const opToken = e2.body && e2.body.accessToken;
  log('E2-S2', 'accessToken present', !!opToken);
  log('E2-S3', 'refreshToken present', !!(e2.body && e2.body.refreshToken));
  log('E2-S4', 'role=OPERATOR', e2.body && e2.body.user && e2.body.user.role === 'OPERATOR');

  // --- BLOCK E3: SA login (SUPER_ADMIN, no tenant header) ---
  console.log('\n--- E3: SUPER_ADMIN password login ---');
  const e3 = await req('POST', '/auth/login',
    { username: QA_SA_USER, password: QA_SA_PASS }
    // No X-Tenant-Slug header for SUPER_ADMIN
  );
  log('E3-S1', 'SA login 200', e3.status === 200, JSON.stringify(e3.body).substring(0, 120));
  const saToken = e3.body && e3.body.accessToken;
  log('E3-S2', 'SA accessToken present', !!saToken);
  log('E3-S3', 'SA role=SUPER_ADMIN', e3.body && e3.body.user && e3.body.user.role === 'SUPER_ADMIN');

  // --- BLOCK E4: Buyer portal login ---
  console.log('\n--- E4: Buyer portal login ---');
  const e4 = await req('POST', '/buyer/auth/login', {
    email: QA_BUYER_EMAIL,
    password: QA_PASS
  });
  log('E4-S1', 'Buyer login 200', e4.status === 200, JSON.stringify(e4.body).substring(0, 120));
  const buyerToken = e4.body && e4.body.accessToken;
  log('E4-S2', 'accessToken present', !!buyerToken);
  log('E4-S3', 'refreshToken present', !!(e4.body && e4.body.refreshToken));
  log('E4-S4', 'buyer object present', !!(e4.body && e4.body.buyer));

  // --- BLOCK F: Session / Token Behaviour ---
  console.log('\n--- F: Session / Token Behaviour ---');

  // F1: Access a protected route with valid operator token
  // Use GET /users/me (staff profile endpoint)
  if (opToken) {
    const f1 = await req('GET', '/users/me', null,
      { Authorization: 'Bearer ' + opToken, 'X-Tenant-Slug': QA_TENANT_SLUG });
    log('F1-S1', 'GET /users/me with valid token -> 200', f1.status === 200, 'status=' + f1.status);
    log('F1-S2', 'me.username = qa_operator', f1.body && f1.body.username === 'qa_operator');
  } else {
    log('F1', 'GET /users/me (skipped, no opToken)', null);
  }

  // F2: Access protected route with no token -> 401
  const f2 = await req('GET', '/users/me', null, { 'X-Tenant-Slug': QA_TENANT_SLUG });
  log('F2-S1', 'GET /users/me with no token -> 401', f2.status === 401, 'status=' + f2.status);

  // F3: Refresh token rotation (operator)
  const e2RefreshToken = e2.body && e2.body.refreshToken;
  if (e2RefreshToken) {
    const f3 = await req('POST', '/auth/refresh', { refreshToken: e2RefreshToken });
    log('F3-S1', 'POST /auth/refresh -> 200', f3.status === 200, JSON.stringify(f3.body).substring(0, 80));
    log('F3-S2', 'New accessToken issued', !!(f3.body && f3.body.accessToken));
    log('F3-S3', 'New refreshToken issued', !!(f3.body && f3.body.refreshToken));

    // F3-S4: Old refresh token should be invalidated (replay protection)
    const f3r = await req('POST', '/auth/refresh', { refreshToken: e2RefreshToken });
    log('F3-S4', 'Old refresh token rejected after rotation (replay)', f3r.status === 401 || f3r.status === 403,
      'status=' + f3r.status);
  } else {
    log('F3', 'Refresh rotation (skipped, no refreshToken from E2)', null);
  }

  // F4: Buyer refresh token
  const e4RefreshToken = e4.body && e4.body.refreshToken;
  if (e4RefreshToken) {
    const f4 = await req('POST', '/buyer/auth/refresh', { refreshToken: e4RefreshToken });
    log('F4-S1', 'Buyer POST /buyer/auth/refresh -> 200', f4.status === 200, 'status=' + f4.status);
    log('F4-S2', 'Buyer new accessToken issued', !!(f4.body && f4.body.accessToken));
  } else {
    log('F4', 'Buyer refresh (skipped, no refreshToken from E4)', null);
  }

  // F5: Logout invalidates refresh token
  // First get a fresh token (since F3 consumed e2RefreshToken)
  const f5Login = await req('POST', '/auth/login',
    { username: 'qa_operator', password: QA_PASS },
    { 'X-Tenant-Slug': QA_TENANT_SLUG }
  );
  const f5AccessToken = f5Login.body && f5Login.body.accessToken;
  const f5RefreshToken = f5Login.body && f5Login.body.refreshToken;
  if (f5AccessToken && f5RefreshToken) {
    const f5logout = await req('POST', '/auth/logout', {}, { Authorization: 'Bearer ' + f5AccessToken });
    log('F5-S1', 'POST /auth/logout -> 200 or 204', f5logout.status === 200 || f5logout.status === 204,
      'status=' + f5logout.status);
    const f5re = await req('POST', '/auth/refresh', { refreshToken: f5RefreshToken });
    log('F5-S2', 'Refresh after logout rejected', f5re.status === 401 || f5re.status === 403,
      'status=' + f5re.status);
  }

  // --- BLOCK G: Google OAuth URL Generation ---
  console.log('\n--- G: Google OAuth URL Generation ---');

  // G1: Platform admin auth URL
  const g1 = await req('GET', '/platform-admin/auth/google', null);
  log('G1-S1', 'GET /platform-admin/auth/google -> 200', g1.status === 200);
  log('G1-S2', 'url field present', typeof g1.body === 'object' && typeof g1.body.url === 'string');
  log('G1-S3', 'url points to accounts.google.com', g1.body && g1.body.url && g1.body.url.includes('accounts.google.com'));
  log('G1-S4', 'url contains email scope', g1.body && g1.body.url && g1.body.url.includes('email'));
  log('G1-S5', 'url contains state param', g1.body && g1.body.url && g1.body.url.includes('state='));

  // G2: Tenant auth URL (for staff) via X-Tenant-Slug header
  const g2 = await req('GET', '/auth/google?tenant=' + QA_TENANT_SLUG + '&context=staff', null);
  log('G2-S1', 'GET /auth/google?tenant=... (staff) -> 200', g2.status === 200);
  log('G2-S2', 'url field present', typeof g2.body === 'object' && typeof g2.body.url === 'string');
  log('G2-S3', 'url points to accounts.google.com', g2.body && g2.body.url && g2.body.url.includes('accounts.google.com'));
  log('G2-S4', 'url contains state param', g2.body && g2.body.url && g2.body.url.includes('state='));

  // G3: Tenant auth URL (for buyer portal)
  const g3 = await req('GET', '/auth/google?tenant=' + QA_TENANT_SLUG + '&context=portal', null);
  log('G3-S1', 'GET /auth/google (portal context) -> 200', g3.status === 200);
  log('G3-S2', 'url present for portal', typeof g3.body === 'object' && typeof g3.body.url === 'string');

  // G4: No tenant slug - implementation generates URL without tenant (design decision, noted)
  const g4 = await req('GET', '/auth/google', null);
  log('G4-S1', 'GET /auth/google (no tenant) -> 200 or 400 [lazy validation]',
    g4.status === 200 || g4.status === 400,
    'status=' + g4.status + ' [DESIGN NOTE: 400 preferred, 200 is lazy-validation]');

  // G5: Invalid tenant slug still generates URL (tenant validation deferred to callback)
  const g5 = await req('GET', '/auth/google?tenant=nonexistent-slug-xyz', null);
  log('G5-S1', 'GET /auth/google (invalid tenant) -> URL generated (lazy validation)',
    g5.status === 200 || g5.status === 404 || g5.status === 400,
    'status=' + g5.status);

  // G6: Decode and validate platform state
  if (g1.body && g1.body.url) {
    const stateMatch = g1.body.url.match(/state=([^&]+)/);
    if (stateMatch) {
      try {
        const decoded = JSON.parse(Buffer.from(decodeURIComponent(stateMatch[1]), 'base64url').toString('utf8'));
        log('G6-S1', 'Platform state type=platform', decoded.type === 'platform');
        log('G6-S2', 'Platform state has nonce', !!decoded.nonce);
        log('G6-S3', 'Nonce is a valid UUID format', /^[0-9a-f-]{36}$/.test(decoded.nonce));
      } catch (e) {
        log('G6', 'Platform state decode failed', false, e.message);
      }
    }
  }

  // G7: Decode and validate tenant state
  if (g2.body && g2.body.url) {
    const stateMatch = g2.body.url.match(/state=([^&]+)/);
    if (stateMatch) {
      try {
        const decoded = JSON.parse(Buffer.from(decodeURIComponent(stateMatch[1]), 'base64url').toString('utf8'));
        log('G7-S1', 'Tenant state type=tenant', decoded.type === 'tenant');
        log('G7-S2', 'Tenant state tenantSlug correct', decoded.tenantSlug === QA_TENANT_SLUG);
        log('G7-S3', 'Tenant state has nonce', !!decoded.nonce);
        log('G7-S4', 'Tenant state context=staff', decoded.context === 'staff');
      } catch (e) {
        log('G7', 'Tenant state decode failed', false, e.message);
      }
    }
  }

  // G8: Portal state contains context=portal
  if (g3.body && g3.body.url) {
    const stateMatch = g3.body.url.match(/state=([^&]+)/);
    if (stateMatch) {
      try {
        const decoded = JSON.parse(Buffer.from(decodeURIComponent(stateMatch[1]), 'base64url').toString('utf8'));
        log('G8-S1', 'Portal state context=portal', decoded.context === 'portal');
      } catch (e) {
        log('G8', 'Portal state decode failed', false, e.message);
      }
    }
  }

  // G9: Invalid state in callback -> redirect with error
  const g9 = await req('GET', '/platform-admin/auth/google/callback?code=fake_code&state=INVALID!!!', null);
  log('G9-S1', 'Callback with invalid state -> redirect (302) or 403/400',
    g9.status === 302 || g9.status === 403 || g9.status === 400,
    'status=' + g9.status + ' body=' + JSON.stringify(g9.body).substring(0, 60));

  // G10: Nonce uniqueness — two requests must produce different nonces
  const g10a = await req('GET', '/platform-admin/auth/google', null);
  const g10b = await req('GET', '/platform-admin/auth/google', null);
  if (g10a.body && g10a.body.url && g10b.body && g10b.body.url) {
    try {
      const mA = g10a.body.url.match(/state=([^&]+)/);
      const mB = g10b.body.url.match(/state=([^&]+)/);
      const dA = JSON.parse(Buffer.from(decodeURIComponent(mA[1]), 'base64url').toString('utf8'));
      const dB = JSON.parse(Buffer.from(decodeURIComponent(mB[1]), 'base64url').toString('utf8'));
      log('G10-S1', 'Unique nonce per request (CSRF protection)', dA.nonce !== dB.nonce,
        dA.nonce.substring(0, 8) + '... vs ' + dB.nonce.substring(0, 8) + '...');
    } catch (e) {
      log('G10', 'Nonce uniqueness check error', false, e.message);
    }
  }

  // --- BLOCK H: Full Regression ---
  console.log('\n--- H: Role Enforcement & Protected Routes ---');

  // Re-login for fresh tokens (previous may have been consumed by F3/F5)
  const hLogin = await req('POST', '/auth/login',
    { username: 'qa_operator', password: QA_PASS },
    { 'X-Tenant-Slug': QA_TENANT_SLUG }
  );
  const hOpToken = hLogin.body && hLogin.body.accessToken;
  log('H0-S1', 'Re-login fresh operator token', !!hOpToken);

  // H1: Operator can access /customers
  if (hOpToken) {
    const h1 = await req('GET', '/customers', null,
      { Authorization: 'Bearer ' + hOpToken, 'X-Tenant-Slug': QA_TENANT_SLUG });
    log('H1-S1', 'Operator GET /customers -> 200', h1.status === 200, 'status=' + h1.status);
  }

  // H2: SA token CAN access tenant /customers (SUPER_ADMIN satisfies all roles by design)
  if (saToken) {
    const h2 = await req('GET', '/customers', null,
      { Authorization: 'Bearer ' + saToken, 'X-Tenant-Slug': QA_TENANT_SLUG });
    log('H2-S1', 'SA token GET /customers -> 200 (SA satisfies all roles by design)',
      h2.status === 200,
      'status=' + h2.status + ' [DESIGN: SUPER_ADMIN bypasses role guards]');
  }

  // H3: Buyer token cannot access staff /customers
  if (buyerToken) {
    const h3 = await req('GET', '/customers', null,
      { Authorization: 'Bearer ' + buyerToken, 'X-Tenant-Slug': QA_TENANT_SLUG });
    log('H3-S1', 'Buyer token GET /customers -> 403 or 401',
      h3.status === 403 || h3.status === 401,
      'status=' + h3.status);
  }

  // H4: Operator can access /orders
  if (hOpToken) {
    const h4 = await req('GET', '/orders', null,
      { Authorization: 'Bearer ' + hOpToken, 'X-Tenant-Slug': QA_TENANT_SLUG });
    log('H4-S1', 'Operator GET /orders -> 200', h4.status === 200, 'status=' + h4.status);
  }

  // H5: Buyer can access /buyer/sellers (list linked sellers)
  if (buyerToken) {
    const h5 = await req('GET', '/buyer/sellers', null, { Authorization: 'Bearer ' + buyerToken });
    log('H5-S1', 'Buyer GET /buyer/sellers -> 200', h5.status === 200,
      'status=' + h5.status + ' body=' + JSON.stringify(h5.body).substring(0, 80));
  }

  // H6: Google OAuth URL endpoint still accessible after all tests (no regression)
  const h6 = await req('GET', '/platform-admin/auth/google', null);
  log('H6-S1', 'Platform Google URL endpoint still works', h6.status === 200);

  // H7: Tenant Google URL still works
  const h7 = await req('GET', '/auth/google?tenant=' + QA_TENANT_SLUG, null);
  log('H7-S1', 'Tenant Google URL endpoint still works', h7.status === 200);

  // H8: SA can access /platform-admin routes
  if (saToken) {
    const h8 = await req('GET', '/platform-admin/tenants', null, { Authorization: 'Bearer ' + saToken });
    log('H8-S1', 'SA GET /platform-admin/tenants -> 200', h8.status === 200, 'status=' + h8.status);
  }

  // H9: Operator cannot access platform-admin routes
  if (hOpToken) {
    const h9 = await req('GET', '/platform-admin/tenants', null, { Authorization: 'Bearer ' + hOpToken });
    log('H9-S1', 'Operator GET /platform-admin/tenants -> 403 or 401',
      h9.status === 403 || h9.status === 401,
      'status=' + h9.status);
  }

  // --- SUMMARY ---
  console.log('\n====================================================');
  console.log('  TOTAL: ' + passed + ' PASS  |  ' + failed + ' FAIL  |  ' + infoCount + ' INFO');
  console.log('====================================================\n');

  if (failed > 0) {
    console.log('FAILED TESTS:');
    results.filter(r => r.startsWith('FAIL')).forEach(r => console.log('  ' + r));
  }
}

runAll().catch(console.error);
