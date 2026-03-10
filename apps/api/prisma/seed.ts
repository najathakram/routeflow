import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const SALT_ROUNDS = 10;

  // ─── Admin (force password change on first login) ────────────────────────────
  await prisma.user.upsert({
    where: { username: 'admin' },
    update: {},
    create: {
      email: 'admin@routeflow.dev',
      username: 'admin',
      password: await bcrypt.hash('Admin@123', SALT_ROUNDS),
      role: 'OPERATOR',
      status: 'ACTIVE',
      forcePasswordChange: true,
    },
  });

  // ─── Dev users ───────────────────────────────────────────────────────────────
  const [operatorUser, driverUser, customerUser] = await Promise.all([
    prisma.user.upsert({
      where: { email: 'operator@routeflow.dev' },
      update: {},
      create: {
        email: 'operator@routeflow.dev',
        username: 'operator',
        password: await bcrypt.hash('password', SALT_ROUNDS),
        role: 'OPERATOR',
        status: 'ACTIVE',
      },
    }),
    prisma.user.upsert({
      where: { email: 'driver@routeflow.dev' },
      update: {},
      create: {
        email: 'driver@routeflow.dev',
        username: 'driver',
        password: await bcrypt.hash('password', SALT_ROUNDS),
        role: 'DRIVER',
        status: 'ACTIVE',
      },
    }),
    prisma.user.upsert({
      where: { email: 'customer@routeflow.dev' },
      update: {},
      create: {
        email: 'customer@routeflow.dev',
        username: 'customer',
        password: await bcrypt.hash('password', SALT_ROUNDS),
        role: 'CUSTOMER',
        status: 'ACTIVE',
      },
    }),
  ]);

  // ─── Driver profile ──────────────────────────────────────────────────────────
  await prisma.driver.upsert({
    where: { userId: driverUser.id },
    update: {},
    create: {
      userId: driverUser.id,
      status: 'ACTIVE',
    },
  });

  // ─── Customer profile ─────────────────────────────────────────────────────────
  const customer = await prisma.customer.upsert({
    where: { userId: customerUser.id },
    update: {},
    create: {
      userId: customerUser.id,
      businessName: 'Demo Business',
      contactName: 'Demo Customer',
      phone: '+1-555-0200',
    },
  });

  // ─── Customer address ─────────────────────────────────────────────────────────
  await prisma.customerAddress.upsert({
    where: { id: 'seed-address-1' },
    update: {},
    create: {
      id: 'seed-address-1',
      customerId: customer.id,
      label: 'Main',
      line1: '123 Demo Street',
      city: 'Sydney',
      state: 'NSW',
      zip: '2000',
      isDefault: true,
    },
  });

  console.log('Seed complete:', {
    admin: 'admin@routeflow.dev (forcePasswordChange: true)',
    operator: operatorUser.email,
    driver: driverUser.email,
    customer: customerUser.email,
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
