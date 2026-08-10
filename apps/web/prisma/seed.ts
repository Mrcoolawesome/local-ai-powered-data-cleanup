// Internal tool, no public signup — this is how the first (and any
// subsequent) user account gets created. Run via `pnpm prisma:seed` or
// `prisma db seed`, with SEED_USER_EMAIL/SEED_USER_PASSWORD set in the
// environment (see .env.example).
import "dotenv/config";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma";

async function main() {
  await prisma.settings.upsert({
    where: { id: "singleton" },
    create: {},
    update: {},
  });
  console.log("Settings singleton row ensured.");

  const email = process.env.SEED_USER_EMAIL;
  const password = process.env.SEED_USER_PASSWORD;
  if (!email || !password) {
    console.log(
      "SEED_USER_EMAIL/SEED_USER_PASSWORD not set — skipping user creation. " +
        "Set them and rerun the seed to create/update a login."
    );
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.upsert({
    where: { email },
    create: { email, passwordHash },
    update: { passwordHash },
  });
  console.log(`User ready: ${user.email}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
