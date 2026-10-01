/**
 * e2e-seed DRIVER fixture user upsert. Password unset -> skip (user: null). Existing user ->
 * re-hash the password so a rotated E2E_DRIVER_PASSWORD takes effect on an already-seeded DB.
 */
"use strict";

async function ensureDriverUser({ prisma, hash, tenantId, username, email, password }) {
  if (!password) return { user: null, created: false };
  const existing = await prisma.user.findFirst({ where: { tenantId, username } });
  const hashed = await hash(password);
  if (existing) {
    await prisma.user.update({ where: { id: existing.id }, data: { password: hashed } });
    return { user: existing, created: false };
  }
  const user = await prisma.user.create({
    data: {
      email,
      username,
      password: hashed,
      role: "DRIVER",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
    },
  });
  return { user, created: true };
}

module.exports = { ensureDriverUser };
