const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // Find the superadmin user
  const find = await client.query(
    `SELECT id, username, email, role, "tenantId" FROM "User" WHERE username = 'najathakram' LIMIT 1`
  );

  if (find.rows.length === 0) {
    console.log('User najathakram not found');
    await client.end();
    return;
  }

  const user = find.rows[0];
  console.log('Found user:', JSON.stringify(user));

  // Set the email to najathakram1@gmail.com so Google OAuth auto-links on first sign-in
  if (user.email !== 'najathakram1@gmail.com') {
    const update = await client.query(
      `UPDATE "User" SET email = 'najathakram1@gmail.com' WHERE id = $1 RETURNING id, username, email, role`,
      [user.id]
    );
    console.log('Updated user:', JSON.stringify(update.rows[0]));
  } else {
    console.log('Email already set correctly');
  }

  await client.end();
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
