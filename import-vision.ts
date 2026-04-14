// BreedWorld — Импорт OCR-данных из pedigrees_vision.csv
// Создаёт собак, питомники, связывает предков на 3 уровня
// Запуск: DATABASE_URL="postgresql://postgres:postgres@82.202.131.27:5432/biewer_db" npx tsx tools/import-vision.ts

import { readFileSync } from "fs";
import { join } from "path";

const DB_URL = process.env.DATABASE_URL || "file:./dev.db";
const isPostgres = DB_URL.startsWith("postgresql://") || DB_URL.startsWith("postgres://");
const CSV_PATH = process.argv[2] || join(__dirname, "..", "screenshots", "pedigrees_vision.csv");

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

function parseSex(s: string): "MALE" | "FEMALE" {
  const lower = s.toLowerCase();
  if (lower.includes("кобель") || lower === "male" || lower === "м") return "MALE";
  return "FEMALE";
}

function parseDate(s: string): Date | null {
  if (!s) return null;
  const parts = s.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (parts) return new Date(parseInt(parts[3]), parseInt(parts[2]) - 1, parseInt(parts[1]));
  return null;
}

function parseCSV(content: string): Record<string, string>[] {
  const lines = content.split("\n").filter(l => l.trim());
  if (lines.length < 2) return [];
  const headerLine = lines[0].replace(/^\ufeff/, "");
  const headers = headerLine.split(";").map(h => h.replace(/^"|"$/g, "").trim());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values: string[] = [];
    let current = "";
    let inQuote = false;
    for (const char of lines[i]) {
      if (char === '"') { inQuote = !inQuote; }
      else if (char === ";" && !inQuote) { values.push(current.trim()); current = ""; }
      else { current += char; }
    }
    values.push(current.trim());
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = values[idx] || ""; });
    rows.push(row);
  }
  return rows;
}

// Clean registration number (remove stray colons, etc.)
function cleanReg(s: string): string | null {
  if (!s) return null;
  return s.replace(/^[\s:]+/, "").trim() || null;
}

async function main() {
  console.log(`\n📂 CSV: ${CSV_PATH}`);
  console.log(`🗄️  DB:  ${isPostgres ? "PostgreSQL" : "SQLite"}`);

  const content = readFileSync(CSV_PATH, "utf-8");
  const rows = parseCSV(content);
  console.log(`📊 Загружено ${rows.length} записей\n`);

  const { prisma, pool } = await createPrisma();

  // ======== Cache: name → id ========
  const nameCache = new Map<string, string>();
  const existingDogs = await prisma.dog.findMany({ select: { id: true, name: true } });
  for (const d of existingDogs) {
    nameCache.set(d.name.toUpperCase(), d.id);
  }
  console.log(`В базе: ${existingDogs.length} собак\n`);

  // ======== Cache: kennel prefix → id ========
  const kennelCache = new Map<string, string>();
  const existingKennels = await prisma.kennel.findMany();
  for (const k of existingKennels) {
    kennelCache.set(k.prefix.toUpperCase(), k.id);
    kennelCache.set(k.name.toUpperCase(), k.id);
  }

  // ======== Helper: find or create dog by name ========
  async function findOrCreateDog(name: string, sex?: string): Promise<string | null> {
    if (!name || name.length < 2) return null;

    const key = name.toUpperCase();
    const cached = nameCache.get(key);
    if (cached) return cached;

    try {
      const dog = await prisma.dog.create({
        data: {
          name,
          sex: sex ? parseSex(sex) : "FEMALE", // default female if unknown
          breed: "biewer",
          moderationStatus: "APPROVED",
          isAlive: true,
        },
      });
      nameCache.set(key, dog.id);
      return dog.id;
    } catch {
      // Might exist now (race condition or case mismatch)
      const existing = await prisma.dog.findFirst({ where: { name } });
      if (existing) {
        nameCache.set(key, existing.id);
        return existing.id;
      }
      return null;
    }
  }

  // ======== Helper: find or create kennel ========
  async function findOrCreateKennel(name: string): Promise<string | null> {
    if (!name || name.length < 2) return null;

    const key = name.toUpperCase();
    const cached = kennelCache.get(key);
    if (cached) return cached;

    try {
      const kennel = await prisma.kennel.create({
        data: { name, prefix: name, country: "—" },
      });
      kennelCache.set(key, kennel.id);
      return kennel.id;
    } catch {
      const existing = await prisma.kennel.findFirst({
        where: { OR: [{ prefix: name }, { name }] },
      });
      if (existing) {
        kennelCache.set(key, existing.id);
        return existing.id;
      }
      return null;
    }
  }

  // ======== Helper: link parent (overwrite existing) ========
  async function linkParent(dogId: string, parentId: string, field: "sireId" | "damId"): Promise<boolean> {
    if (dogId === parentId) return false; // avoid self-reference
    try {
      const dog = await prisma.dog.findUnique({ where: { id: dogId }, select: { sireId: true, damId: true } });
      if (!dog) return false;
      if (dog[field] === parentId) return false; // already correct

      await prisma.dog.update({ where: { id: dogId }, data: { [field]: parentId } });
      return true;
    } catch {
      return false;
    }
  }

  // ======== Phase 1: Create/update main dogs ========
  console.log("═══ Фаза 1: Создание/обновление собак ═══\n");
  let created = 0, updated = 0, skipped = 0, errors = 0, kennelsCreated = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const name = row.dogName?.trim();
    if (!name) continue;

    const key = name.toUpperCase();
    const existing = nameCache.get(key)
      ? await prisma.dog.findUnique({ where: { id: nameCache.get(key)! }, select: { id: true, name: true, color: true, dateOfBirth: true, tattooNumber: true, registrationNumber: true, breederId: true, ownerName: true, breederName: true, sex: true } })
      : await prisma.dog.findFirst({ where: { name }, select: { id: true, name: true, color: true, dateOfBirth: true, tattooNumber: true, registrationNumber: true, breederId: true, ownerName: true, breederName: true, sex: true } });

    // Find or create kennel
    let kennelId: string | null = null;
    const kennelName = row.kennel?.trim();
    if (kennelName) {
      kennelId = await findOrCreateKennel(kennelName);
      if (kennelId && !kennelCache.has(kennelName.toUpperCase())) {
        kennelsCreated++;
      }
    }

    if (existing) {
      nameCache.set(key, existing.id);

      // Fill missing fields from OCR (don't overwrite existing good data)
      const updates: Record<string, unknown> = {};
      if (row.color && !existing.color) updates.color = row.color;
      if (row.dateOfBirth && !existing.dateOfBirth) updates.dateOfBirth = parseDate(row.dateOfBirth);
      if (row.tattoo && !existing.tattooNumber) updates.tattooNumber = row.tattoo;
      if (row.regNumber && !existing.registrationNumber) updates.registrationNumber = cleanReg(row.regNumber);
      if (kennelId && !existing.breederId) updates.breederId = kennelId;
      if (row.owner && !existing.ownerName) updates.ownerName = row.owner;
      if (row.breeder && !existing.breederName) updates.breederName = row.breeder;
      if (row.sex && existing.sex === "FEMALE" && parseSex(row.sex) === "MALE") updates.sex = "MALE"; // fix wrong default sex

      if (Object.keys(updates).length > 0) {
        try {
          await prisma.dog.update({ where: { id: existing.id }, data: updates });
          updated++;
        } catch (e: unknown) {
          // If registrationNumber conflicts, retry without it
          const err = e as Error;
          if (err.message?.includes("registrationNumber") || err.message?.includes("Unique constraint")) {
            delete updates.registrationNumber;
            if (Object.keys(updates).length > 0) {
              try {
                await prisma.dog.update({ where: { id: existing.id }, data: updates });
                updated++;
              } catch { skipped++; }
            } else { skipped++; }
          } else { errors++; }
        }
      } else {
        skipped++;
      }
    } else {
      try {
        const dog = await prisma.dog.create({
          data: {
            name,
            sex: parseSex(row.sex || ""),
            color: row.color || null,
            dateOfBirth: parseDate(row.dateOfBirth || ""),
            tattooNumber: row.tattoo || null,
            registrationNumber: cleanReg(row.regNumber || ""),
            breederName: row.breeder || null,
            ownerName: row.owner || null,
            breederId: kennelId,
            breed: "biewer",
            moderationStatus: "APPROVED",
            isAlive: true,
          },
        });
        nameCache.set(key, dog.id);
        created++;
      } catch (e: unknown) {
        const err = e as Error;
        if (err.message?.includes("Unique constraint")) {
          try {
            const dog = await prisma.dog.create({
              data: {
                name,
                sex: parseSex(row.sex || ""),
                breed: "biewer",
                moderationStatus: "APPROVED",
                isAlive: true,
              },
            });
            nameCache.set(key, dog.id);
            created++;
          } catch { errors++; }
        } else {
          errors++;
        }
      }
    }

    if ((i + 1) % 100 === 0) {
      console.log(`  [${i + 1}/${rows.length}] создано: ${created}, обновлено: ${updated}`);
    }
  }

  console.log(`\n  ✅ Создано: ${created}, обновлено: ${updated}, пропущено: ${skipped}, ошибок: ${errors}`);
  console.log(`  🏠 Питомников создано: ${kennelsCreated}\n`);

  // ======== Phase 2: Create ancestor dogs (that don't exist yet) ========
  console.log("═══ Фаза 2: Создание собак-предков ═══\n");
  let ancestorsCreated = 0;

  const ancestorFields = [
    "sire", "dam",
    "grandSireS", "grandDamS", "grandSireD", "grandDamD",
    "ggSireSS", "ggDamSS", "ggSireSD", "ggDamSD",
    "ggSireDS", "ggDamDS", "ggSireDD", "ggDamDD",
  ];

  for (const row of rows) {
    for (const field of ancestorFields) {
      const ancestorName = row[field]?.trim();
      if (!ancestorName || ancestorName.length < 2) continue;

      const key = ancestorName.toUpperCase();
      if (nameCache.has(key)) continue;

      // Determine sex from field name
      const isMale = field.toLowerCase().includes("sire") || field === "sire";
      const id = await findOrCreateDog(ancestorName, isMale ? "male" : "female");
      if (id) ancestorsCreated++;
    }
  }

  console.log(`  ✅ Создано предков: ${ancestorsCreated}\n`);

  // ======== Phase 3: Link parents at all levels ========
  console.log("═══ Фаза 3: Связывание предков (3 уровня) ═══\n");
  let linked = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const dogName = row.dogName?.trim();
    if (!dogName) continue;

    const dogId = nameCache.get(dogName.toUpperCase());
    if (!dogId) continue;

    // Level 1: Parents
    const sireId = row.sire ? nameCache.get(row.sire.trim().toUpperCase()) : null;
    const damId = row.dam ? nameCache.get(row.dam.trim().toUpperCase()) : null;

    if (sireId && await linkParent(dogId, sireId, "sireId")) linked++;
    if (damId && await linkParent(dogId, damId, "damId")) linked++;

    // Level 2: Grandparents (link to sire/dam)
    if (sireId) {
      const gsS = row.grandSireS ? nameCache.get(row.grandSireS.trim().toUpperCase()) : null;
      const gdS = row.grandDamS ? nameCache.get(row.grandDamS.trim().toUpperCase()) : null;
      if (gsS && await linkParent(sireId, gsS, "sireId")) linked++;
      if (gdS && await linkParent(sireId, gdS, "damId")) linked++;
    }
    if (damId) {
      const gsD = row.grandSireD ? nameCache.get(row.grandSireD.trim().toUpperCase()) : null;
      const gdD = row.grandDamD ? nameCache.get(row.grandDamD.trim().toUpperCase()) : null;
      if (gsD && await linkParent(damId, gsD, "sireId")) linked++;
      if (gdD && await linkParent(damId, gdD, "damId")) linked++;
    }

    // Level 3: Great-grandparents (link to grandparents)
    if (sireId) {
      const sire = await prisma.dog.findUnique({ where: { id: sireId }, select: { sireId: true, damId: true } });
      if (sire?.sireId) {
        const gg1 = row.ggSireSS ? nameCache.get(row.ggSireSS.trim().toUpperCase()) : null;
        const gg2 = row.ggDamSS ? nameCache.get(row.ggDamSS.trim().toUpperCase()) : null;
        if (gg1 && await linkParent(sire.sireId, gg1, "sireId")) linked++;
        if (gg2 && await linkParent(sire.sireId, gg2, "damId")) linked++;
      }
      if (sire?.damId) {
        const gg3 = row.ggSireSD ? nameCache.get(row.ggSireSD.trim().toUpperCase()) : null;
        const gg4 = row.ggDamSD ? nameCache.get(row.ggDamSD.trim().toUpperCase()) : null;
        if (gg3 && await linkParent(sire.damId, gg3, "sireId")) linked++;
        if (gg4 && await linkParent(sire.damId, gg4, "damId")) linked++;
      }
    }
    if (damId) {
      const dam = await prisma.dog.findUnique({ where: { id: damId }, select: { sireId: true, damId: true } });
      if (dam?.sireId) {
        const gg5 = row.ggSireDS ? nameCache.get(row.ggSireDS.trim().toUpperCase()) : null;
        const gg6 = row.ggDamDS ? nameCache.get(row.ggDamDS.trim().toUpperCase()) : null;
        if (gg5 && await linkParent(dam.sireId, gg5, "sireId")) linked++;
        if (gg6 && await linkParent(dam.sireId, gg6, "damId")) linked++;
      }
      if (dam?.damId) {
        const gg7 = row.ggSireDD ? nameCache.get(row.ggSireDD.trim().toUpperCase()) : null;
        const gg8 = row.ggDamDD ? nameCache.get(row.ggDamDD.trim().toUpperCase()) : null;
        if (gg7 && await linkParent(dam.damId, gg7, "sireId")) linked++;
        if (gg8 && await linkParent(dam.damId, gg8, "damId")) linked++;
      }
    }

    if ((i + 1) % 100 === 0) {
      console.log(`  [${i + 1}/${rows.length}] связей: ${linked}`);
    }
  }

  console.log(`\n  ✅ Связано: ${linked} родительских связей\n`);

  // ======== Summary ========
  const totalDogs = await prisma.dog.count();
  const totalKennels = await prisma.kennel.count();
  const withSire = await prisma.dog.count({ where: { sireId: { not: null } } });
  const withDam = await prisma.dog.count({ where: { damId: { not: null } } });

  console.log("═══════════════════════════════════");
  console.log(`🎉 Импорт завершён!`);
  console.log(`   Собак в базе:     ${totalDogs}`);
  console.log(`   Питомников:       ${totalKennels}`);
  console.log(`   С отцом (sire):   ${withSire}`);
  console.log(`   С матерью (dam):  ${withDam}`);
  console.log("═══════════════════════════════════\n");

  await prisma.$disconnect();
  if (pool) await pool.end();
}

main().catch(console.error);
