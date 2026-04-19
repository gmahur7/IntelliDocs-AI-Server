import { PrismaClient, Role } from "@prisma/client";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  await prisma.user.upsert({
    where: {
      email: "admin@example.com",
    },
    update: {
      firstName: "Admin",
      lastName: "User",
      role: Role.ADMIN,
    },
    create: {
      firstName: "Admin",
      lastName: "User",
      email: "admin@example.com",
      role: Role.ADMIN,
    },
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
