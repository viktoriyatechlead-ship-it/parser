// Fix dirty dog names: remove RKF numbers, colors, "метрика" from names
// Also clean up false parent links that shouldn't exist
// Запуск: DATABASE_URL="postgresql://..." npx tsx tools/fix-dirty-names.ts

import { readFileSync } from "fs";
import { join } from "path";

const DB_URL = process.env.DATABASE_URL || "file:./dev.db";
const isPostgres = DB_URL.startsWith("postgresql://") || DB_URL.startsWith("postgres://");

async function createPrisma() {
  const { PrismaClient } = require("../src/generated/prisma");
  if (isPostgres) {
    const pg = require("pg");
    const { PrismaPg } = require("@prisma/adapter-pg");
    const pool = new pg.Pool({ connectionString: DB_URL });
    return { prisma: new PrismaClient({ adapter: new PrismaPg(pool) }), pool };
  } else {
    const { PrismaBetterSqlite3 } = require("@prisma/adapter-better-sqlite3");
    return { prisma: new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: DB_URL }) }), pool: null };
  }
}

function cleanDogName(name: string): string {
  let clean = name
    // Remove RKF/РКФ numbers and everything after
    .replace(/\s+(РКФ|RKF|ПКФ|PKF)\s*[RPРр\d].*$/gi, "")
    // Remove standalone RKF patterns at start
    .replace(/^(РКФ|RKF|ПКФ|PKF)\s*[RPРр\d].*$/gi, "")
    // Remove color descriptions (Russian)
    .replace(/\s+(черн|бело|бел-|бел\.|чер-|ч-б|чбз|черно|чёрно|белый|рыж|зол|4-6-3)[^\s]*.*$/gi, "")
    // Remove color descriptions (English)
    .replace(/\s+(black|white|red|blue|gold)\s*([-&\s]*\s*(black|white|red|blue|gold|with))*.*$/gi, "")
    // Remove "метрика" and everything after/before
    .replace(/\s+метрика.*$/gi, "")
    .replace(/^метрика\s*/gi, "")
    // Remove VGrCH/VCH/CH title noise
    .replace(/^(CH\.\w+\s*,?\s*)+/gi, "")
    .replace(/^(VGrCH|VCH)\.\w+.*$/gi, "")
    // Remove trailing junk
    .replace(/\s*[,;:\-\.]+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();

  return clean;
}

async function main() {
  console.log("🔧 Очистка грязных имён собак\n");
  const { prisma, pool } = await createPrisma();

  // Find dogs with dirty names
  const dirtyDogs = await prisma.dog.findMany({
    where: {
      OR: [
        { name: { contains: "РКФ" } },
        { name: { contains: "RKF" } },
        { name: { contains: "ПКФ" } },
        { name: { contains: "метрика" } },
        { name: { contains: "черн" } },
        { name: { contains: "бело" } },
        { name: { contains: "чёрно" } },
        { name: { contains: "VGrCH" } },
        { name: { contains: "VCH." } },
        { name: { contains: "black" } },
      ],
    },
    select: { id: true, name: true },
  });

  console.log(`Найдено ${dirtyDogs.length} собак с грязными именами\n`);

  let fixed = 0;
  let deleted = 0;

  for (const dog of dirtyDogs) {
    const newName = cleanDogName(dog.name);

    if (!newName || newName.length < 2) {
      // Name is entirely junk — delete the dog if it has no children
      const childCount = await prisma.dog.count({
        where: { OR: [{ sireId: dog.id }, { damId: dog.id }] },
      });
      if (childCount === 0) {
        await prisma.dog.delete({ where: { id: dog.id } });
        deleted++;
        console.log(`  🗑️  Удалено: "${dog.name}"`);
      } else {
        console.log(`  ⚠️  Не могу удалить "${dog.name}" (${childCount} потомков)`);
      }
      continue;
    }

    if (newName !== dog.name) {
      // Check if a dog with this clean name already exists
      const existing = await prisma.dog.findFirst({
        where: { name: newName, id: { not: dog.id } },
      });

      if (existing) {
        // Merge: transfer all children from dirty dog to existing clean dog
        await prisma.dog.updateMany({ where: { sireId: dog.id }, data: { sireId: existing.id } });
        await prisma.dog.updateMany({ where: { damId: dog.id }, data: { damId: existing.id } });
        await prisma.dog.delete({ where: { id: dog.id } });
        deleted++;
        console.log(`  🔀 Объединено: "${dog.name}" → "${existing.name}"`);
      } else {
        await prisma.dog.update({ where: { id: dog.id }, data: { name: newName } });
        fixed++;
        console.log(`  ✏️  "${dog.name}" → "${newName}"`);
      }
    }
  }

  console.log(`\n✅ Исправлено: ${fixed}, удалено/объединено: ${deleted}\n`);

  // Stats
  const total = await prisma.dog.count();
  console.log(`Собак в базе: ${total}`);

  await prisma.$disconnect();
  if (pool) await pool.end();
}

main().catch(console.error);
