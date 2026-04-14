// BreedWorld — Убрать ложные связи предков
// Если в CSV поле предка пустое — обнулить sireId/damId у этого предка
// Запуск: DATABASE_URL="postgresql://..." npx tsx tools/cleanup-false-links.ts screenshots/pedigrees_vision_06.csv

import { readFileSync } from "fs";
import { join } from "path";

const DB_URL = process.env.DATABASE_URL || "file:./dev.db";
const isPostgres = DB_URL.startsWith("postgresql://") || DB_URL.startsWith("postgres://");
const CSV_PATH = process.argv[2] || join(__dirname, "..", "screenshots", "pedigrees_vision_06.csv");

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

async function main() {
  console.log(`\n📂 CSV: ${CSV_PATH}`);
  const content = readFileSync(CSV_PATH, "utf-8");
  const rows = parseCSV(content);
  console.log(`📊 Загружено ${rows.length} записей\n`);

  const { prisma, pool } = await createPrisma();

  // Build name → id cache
  const nameCache = new Map<string, string>();
  const allDogs = await prisma.dog.findMany({ select: { id: true, name: true } });
  for (const d of allDogs) {
    nameCache.set(d.name.toUpperCase(), d.id);
  }

  let cleared = 0;

  // For each row, check: if grandparent field is empty but the parent exists in DB with sire/dam set,
  // we need to clear that link (it came from another dog's import, not from this dog's pedigree)

  // Strategy: For each ancestor in the CSV, if its children fields are EMPTY,
  // clear the sireId/damId on that ancestor

  // Build a map: ancestorName → { shouldHaveSire: bool, shouldHaveDam: bool }
  // based on ALL rows in CSV (an ancestor might have parents from a different dog's pedigree)

  const ancestorParents = new Map<string, { hasSire: boolean; hasDam: boolean }>();

  for (const row of rows) {
    // Level 1: sire's parents
    const sireName = row.sire?.trim().toUpperCase();
    if (sireName) {
      const entry = ancestorParents.get(sireName) || { hasSire: false, hasDam: false };
      if (row.grandSireS?.trim()) entry.hasSire = true;
      if (row.grandDamS?.trim()) entry.hasDam = true;
      ancestorParents.set(sireName, entry);
    }

    // Level 1: dam's parents
    const damName = row.dam?.trim().toUpperCase();
    if (damName) {
      const entry = ancestorParents.get(damName) || { hasSire: false, hasDam: false };
      if (row.grandSireD?.trim()) entry.hasSire = true;
      if (row.grandDamD?.trim()) entry.hasDam = true;
      ancestorParents.set(damName, entry);
    }

    // Level 2: grandSireS's parents
    const gsS = row.grandSireS?.trim().toUpperCase();
    if (gsS) {
      const entry = ancestorParents.get(gsS) || { hasSire: false, hasDam: false };
      if (row.ggSireSS?.trim()) entry.hasSire = true;
      if (row.ggDamSS?.trim()) entry.hasDam = true;
      ancestorParents.set(gsS, entry);
    }

    // Level 2: grandDamS's parents
    const gdS = row.grandDamS?.trim().toUpperCase();
    if (gdS) {
      const entry = ancestorParents.get(gdS) || { hasSire: false, hasDam: false };
      if (row.ggSireSD?.trim()) entry.hasSire = true;
      if (row.ggDamSD?.trim()) entry.hasDam = true;
      ancestorParents.set(gdS, entry);
    }

    // Level 2: grandSireD's parents
    const gsD = row.grandSireD?.trim().toUpperCase();
    if (gsD) {
      const entry = ancestorParents.get(gsD) || { hasSire: false, hasDam: false };
      if (row.ggSireDS?.trim()) entry.hasSire = true;
      if (row.ggDamDS?.trim()) entry.hasDam = true;
      ancestorParents.set(gsD, entry);
    }

    // Level 2: grandDamD's parents
    const gdD = row.grandDamD?.trim().toUpperCase();
    if (gdD) {
      const entry = ancestorParents.get(gdD) || { hasSire: false, hasDam: false };
      if (row.ggSireDD?.trim()) entry.hasSire = true;
      if (row.ggDamDD?.trim()) entry.hasDam = true;
      ancestorParents.set(gdD, entry);
    }
  }

  // If ANY row says ancestor has empty sub-parents — clear them.
  // OCR can misassign progenitors to wrong columns, so empty = trust it.
  console.log("═══ Очистка ложных связей ═══\n");

  const noSire = new Set<string>();
  const noDam = new Set<string>();

  for (const row of rows) {
    const check = (name: string | undefined, hasSireField: string, hasDamField: string) => {
      const key = name?.trim().toUpperCase();
      if (!key || key.length < 3) return;
      if (!row[hasSireField]?.trim()) noSire.add(key);
      if (!row[hasDamField]?.trim()) noDam.add(key);
    };

    check(row.sire, "grandSireS", "grandDamS");
    check(row.dam, "grandSireD", "grandDamD");
    check(row.grandSireS, "ggSireSS", "ggDamSS");
    check(row.grandDamS, "ggSireSD", "ggDamSD");
    check(row.grandSireD, "ggSireDS", "ggDamDS");
    check(row.grandDamD, "ggSireDD", "ggDamDD");
  }

  const allToCheck = new Set([...noSire, ...noDam]);

  for (const ancestorKey of allToCheck) {
    const dogId = nameCache.get(ancestorKey);
    if (!dogId) continue;

    const dog = await prisma.dog.findUnique({
      where: { id: dogId },
      select: { sireId: true, damId: true, name: true }
    });
    if (!dog) continue;

    const updates: Record<string, null> = {};
    if (noSire.has(ancestorKey) && dog.sireId) updates.sireId = null;
    if (noDam.has(ancestorKey) && dog.damId) updates.damId = null;

    if (Object.keys(updates).length > 0) {
      await prisma.dog.update({ where: { id: dogId }, data: updates });
      cleared++;
      console.log(`  Очищено: ${dog.name} — ${updates.sireId === null ? 'sire' : ''} ${updates.damId === null ? 'dam' : ''}`);
    }
  }

  console.log(`\n  ✅ Очищено связей: ${cleared}\n`);

  await prisma.$disconnect();
  if (pool) await pool.end();
}

main().catch(console.error);
