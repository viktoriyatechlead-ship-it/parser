#!/usr/bin/env node
/**
 * BreedWorld OCR Parser v10
 *
 * Извлекает данные родословных из скриншотов ZooPortal через Google Cloud Vision API.
 * Обрабатывает PNG файлы → выдаёт XLSX с полями собаки + дерево предков (3 поколения).
 *
 * Использование:
 *   node vision-ocr.js [--dir <папка>] [--output <файл.xlsx>] [--concurrency <N>]
 *
 * По умолчанию:
 *   --dir       ../screenshots/all
 *   --output    ../screenshots/pedigrees_vision.xlsx
 *   --concurrency 5
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const XLSX = require("xlsx");

// ============================================================
// КОНФИГУРАЦИЯ
// ============================================================

const API_KEY = process.env.GOOGLE_VISION_API_KEY || "AIzaSyCVXzjWXr2tzkxBQ20IJQc1k9w4KyoCqAM";

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name, def) {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

const SCREENSHOTS_DIR = path.resolve(getArg("dir", path.join(__dirname, "..", "screenshots", "all")));
const OUTPUT_FILE = path.resolve(getArg("output", path.join(__dirname, "..", "screenshots", "pedigrees_vision.xlsx")));
const CONCURRENCY = parseInt(getArg("concurrency", "5"));
const DELAY_MS = 300;

const HEADER = [
  "filename", "dogName", "sex", "dateOfBirth", "color", "tattoo",
  "regNumber", "kennel", "breeder", "owner", "sire", "dam",
  "grandSireS", "grandDamS", "grandSireD", "grandDamD",
  "ggSireSS", "ggDamSS", "ggSireSD", "ggDamSD",
  "ggSireDS", "ggDamDS", "ggSireDD", "ggDamDD"
];

// ============================================================
// GOOGLE VISION API
// ============================================================

function callVisionAPI(imageBase64) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      requests: [{
        image: { content: imageBase64 },
        features: [
          { type: "DOCUMENT_TEXT_DETECTION" },
          { type: "TEXT_DETECTION", maxResults: 1 },
        ],
      }],
    });
    const options = {
      hostname: "vision.googleapis.com",
      path: `/v1/images:annotate?key=${API_KEY}`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error.message));
          resolve(json);
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ============================================================
// ФИЛЬТРЫ И ОЧИСТКА ТЕКСТА
// ============================================================

/** Регулярка для фильтрации навигационного мусора с ZooPortal */
const NOISE_RE = /ПРОИСХОЖДЕНИЕ|ПОТОМКИ|СИБЛИНГИ|КАРЬЕРА|ОТЗЫВЫ|СТАНДБ|СТБЮБЫ|ЗАВОДЧИК|ВЛАДЕЛЕЦ|РЕКЛАМА|ТАРИФЫ|ВОЗМОЖНОСТИ|АКАДЕМИЯ|РЕСУРСЫ|ПИТОМНИКИ|КОНТАКТЫ|ОБЪЯВЛЕНИЯ|ПОМЁТЫ|ПОМЕТЫ|ПРОДАЖА|ПРЕИМУЩЕСТВА|МЕРОПРИЯТИЯ|ЖИВОТНЫЕ|ПРОФИЛЬ|СУДЬЯМ|СПЕЦИАЛИСТ|КАРТОТЕКА|ВСЕ ЖИВОТНЫЕ|ПОДБОР ПАР|НА ПРОДАЖУ|ДЛЯ ВЯЗОК|ЧЕМПИОНАТ|МАРАФОН|КУБОК|ОСОБЫЙ СТАТУС|СПЕЦРИНГИ|ERID|БИВЕР ТЕРЬЕР|PORTALZOO|ZOO|ПОРТАЛ|ВЫБЕРИТЕ РЕГИОН|ЧТЕНИЯ ДЛЯ|ПОКОЛЕНИЯ|РОДОСЛОВНОЙ|КАРТОЧКА|ЖИВОТНОГО|БАЗЫ РОДОСЛОВНЫХ|ПЛЕМЕННАЯ|ПОРОДНЫЕ|ОПИСАНИЕ|СТАНДАРТ|ЗАПИСИ|УЧАСТНИК|ПЛЕМЕННИКА|КЛУБАМ|ЩЕНКИ|ПРАВИЛА|КОНТАКТЫ|ОРГАНИЗАТОР|ВИДЕОКУРС|ТЕХПОДДЕРЖК|КОНФИДЕНЦИАЛЬН|ДОКУМЕНТАЦ|КАРТА САЙТА|РЕКОМЕНДАТ|ТЕХНОЛОГИИ|НА САЙТЕ|ПАРТНЁРЫ|ПАРТНЕРЫ/i;

function isNoise(text) {
  if (!text || text.length < 3) return true;
  if (NOISE_RE.test(text)) return true;
  if (/^\d[\d\s\.\-\/]+$/.test(text.trim())) return true;
  if (/^(RKF|РКФ|PKF|ПКФ|LOF|LOE|CMKU|FBR)\s/i.test(text.trim())) return true;
  return false;
}

/** Проверяет, является ли текст строкой титулов (CH.RKF, JCH.RUS и т.д.) */
function isTitleString(text) {
  if (!text) return false;
  // Строка титулов: начинается с CH./JCH./GrCH./VCH. или содержит 3+ титула через запятую
  if (/^(CH\.|JCH\.|GrCH\.|VGrCH\.|VCH\.|RUS\s*,|NBIS|BIS)/i.test(text.trim())) return true;
  const titleCount = (text.match(/\b(CH|JCH|GrCH|VGrCH|VCH|NBIS|BIS|BOB|BIG|BEST)\b/gi) || []).length;
  return titleCount >= 2;
}

/** Проверяет, похож ли текст на кличку собаки */
function isDogName(text) {
  if (!text || text.length < 3) return false;
  if (isNoise(text)) return false;
  if (isTitleString(text)) return false;
  const clean = text.replace(/[^A-ZА-ЯЁa-zа-яё]/g, "");
  if (clean.length < 3) return false;
  const upper = (text.match(/[A-ZА-ЯЁ]/g) || []).length;
  return upper / clean.length > 0.4;
}

/**
 * Очищает распознанное имя от мусора OCR:
 * - Удаляет номера РКФ, даты, описания окраса
 * - При смеси латиницы и кириллицы — оставляет латиницу
 * - Удаляет "сука", "кобель", "не указан"
 */
function cleanName(text) {
  if (!text) return "";
  let name = text
    .replace(/[«»""]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-:,]+|[\s\-:,]+$/g, "")
    .replace(/\b(РКФ|RKF|ПКФ|PKF|LOF|LOE|CMKU|FBR|OTG|KRY|MRD|LUU|VIP|DOG|ШЖ|LJ|KZP|XHW|IWA|FND)\s*[\w\d\s\-\/]{2,20}[\d]/gi, "")
    .replace(/\b\d{2}\.\d{2}\.\d{4}\b/g, "")
    .replace(/\bчерн\S{0,10}/gi, "").replace(/\bбело\S{0,10}/gi, "").replace(/\bбел\.\S{0,10}/gi, "")
    .replace(/\bрыж\S{0,10}/gi, "").replace(/\bголуб\S{0,10}/gi, "").replace(/\bшокол\S{0,10}/gi, "")
    .replace(/\bчерно\S{0,10}/gi, "").replace(/\bтрехцв\S{0,10}/gi, "")
    .replace(/\bчер\s*-\s*(бел|рыж|зол)\S{0,10}/gi, "")
    .replace(/\bblack\s*-?\s*red\s*-?\s*white\b/gi, "").replace(/\bblue\s*gold\s*with\s*white\b/gi, "")
    .replace(/\b(сука|кобель)\b/gi, "")
    .replace(/\b(Мать|Отец)\s+(не\s+)?указан[аы]?\b/gi, "")
    .replace(/^(CH\.\w+\s*,?\s*)+/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  // Если смесь латиницы и кириллицы — оставляем латиницу (настоящее имя)
  const hasLatin = /[A-Za-z]{3,}/.test(name);
  const hasCyrillic = /[А-Яа-яЁё]{3,}/.test(name);
  if (hasLatin && hasCyrillic) {
    const parts = name.split(/\s+/);
    const latinParts = [];
    for (const p of parts) {
      if (/^[A-Za-z\-\'\.\`\d]+$/.test(p)) latinParts.push(p);
      else if (latinParts.length > 0 && /[А-Яа-яЁё]/.test(p)) break;
      else latinParts.push(p);
    }
    if (latinParts.length >= 2) name = latinParts.join(" ");
  }

  name = name.replace(/^[\s\-,]+|[\s\-,]+$/g, "").trim();
  return name;
}

// ============================================================
// ИЗВЛЕЧЕНИЕ ПОЛЕЙ КАРТОЧКИ (из полного текста)
// ============================================================

/**
 * Парсит полный текст страницы построчно.
 * Ищет: Пол, Дата рождения, Окрас, Клеймо, № родословной, Питомник, Заводчик, Владелец.
 */
function extractFromFullText(fullText) {
  const lines = fullText.split("\n").map(l => l.trim()).filter(Boolean);
  const result = { sex: "", dateOfBirth: "", color: "", tattoo: "", regNumber: "", kennel: "", breeder: "", owner: "" };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lower = line.toLowerCase();
    const next = lines[i + 1] || "";
    const next2 = lines[i + 2] || "";

    if (!result.sex && /^пол/i.test(lower)) {
      const ctx = (line + " " + next + " " + next2).toLowerCase();
      if (ctx.includes("кобель")) result.sex = "Кобель";
      else if (ctx.includes("сука")) result.sex = "Сука";
    }

    if (!result.dateOfBirth && /дата\s*рождения/i.test(line + " " + next)) {
      const m = (line + " " + next + " " + next2).match(/(\d{2}\.\d{2}\.\d{4})/);
      if (m) result.dateOfBirth = m[1];
    }

    if (!result.color && /^окрас/i.test(lower)) {
      for (let j = i; j < Math.min(i + 3, lines.length); j++) {
        const val = lines[j].replace(/^окрас[:\s]*/i, "").trim();
        if (val && val.length > 2 && !/^(пол|дата|бивер|порода|клеймо|идентиф|заводчик|владелец|питомник|собака)/i.test(val)) {
          result.color = val;
          break;
        }
      }
    }

    if (!result.tattoo && /клеймо/i.test(lower)) {
      const val = line.replace(/.*?клеймо[:\s]*/i, "").trim();
      const candidate = val.length > 2 ? val : next;
      if (candidate && candidate.length > 2 && candidate.length < 30 && !isNoise(candidate) &&
          !/^(идентиф|порода|пол|дата|окрас|спецринг)/i.test(candidate)) {
        result.tattoo = candidate;
      }
    }

    if (!result.regNumber) {
      const m = line.match(/((?:RKF|РКФ|PKF|ПКФ|LOF|LOE|CMKU|FBR|OTG|KRY|MRD|LUU|VIP|DOG|ШЖ|LJ|KZP|XHW|IWA|FND)\s*[\w\d\s\-\/]{2,20})/i);
      if (m) result.regNumber = m[1].trim();
    }

    if (!result.breeder && /^заводчик/i.test(lower)) {
      const val = line.replace(/^заводчик[:\s]*/i, "").trim();
      const candidate = val.length > 2 ? val : next;
      if (candidate && candidate.length > 2 && !isNoise(candidate)) result.breeder = candidate;
    }

    if (!result.owner && /^владелец/i.test(lower)) {
      const val = line.replace(/^владелец[:\s]*/i, "").trim();
      const candidate = val.length > 2 ? val : next;
      if (candidate && candidate.length > 2 && !isNoise(candidate)) result.owner = candidate;
    }

    if (!result.kennel && /питомник/i.test(lower)) {
      const val = line.replace(/.*?питомник[:\s]*/i, "").trim();
      const candidate = val.length > 2 ? val : next;
      if (candidate && candidate.length > 2 && !isNoise(candidate)) result.kennel = candidate;
    }
  }

  return result;
}

// ============================================================
// ИЗВЛЕЧЕНИЕ РОДОСЛОВНОЙ (из координат параграфов)
// ============================================================

/**
 * Алгоритм:
 *
 * 1. Получаем все параграфы с bounding box из Vision API
 * 2. Определяем область родословной (после "ПРОИСХОЖДЕНИЕ", до подвала)
 * 3. Разбиваем на 3 колонки по X-координате:
 *    - Col 1 (x mid < 45% ширины):  Родители — sire, dam
 *    - Col 2 (x mid 45-72% ширины): Деды — grandSireS, grandDamS, grandSireD, grandDamD
 *    - Col 3 (x mid > 72% ширины):  Прадеды — 8 полей
 * 4. В каждой колонке сортируем по Y (сверху вниз)
 * 5. Назначаем слоты последовательно:
 *    - Все записи включая "не указан" сохраняют позицию
 *    - Порядок сверху вниз = порядок слотов в родословной
 */
function extractPedigree(response) {
  const page = response.responses[0].fullTextAnnotation?.pages?.[0];
  if (!page) return {};

  const imgWidth = page.width || 1400;

  const paragraphs = [];
  for (const block of page.blocks) {
    for (const para of block.paragraphs) {
      const verts = para.boundingBox?.vertices;
      if (!verts) continue;
      const x = verts[0].x || 0;
      const y = verts[0].y || 0;
      const x2 = verts[2].x || 0;
      const y2 = verts[2].y || 0;

      let text = "";
      for (const word of para.words) {
        const w = word.symbols.map(s => s.text).join("");
        text += (text ? " " : "") + w;
      }

      paragraphs.push({ x, y, x2, y2, mid: Math.round((x + x2) / 2), text: text.trim() });
    }
  }

  // Находим верх области родословной (после таба "ПРОИСХОЖДЕНИЕ")
  const originPara = paragraphs.find(p => /ПРОИСХОЖДЕНИЕ/i.test(p.text));
  const pedigreeTop = originPara ? originPara.y + 40 : Math.round(imgWidth * 0.4);
  const pedigreeBottom = Math.round(imgWidth * 0.75);

  // Границы колонок (фиксированные пропорции от ширины изображения)
  //   Col 1: mid < 45% (родители, ~x 340-600)
  //   Col 2: mid 45-72% (деды, ~x 640-940)
  //   Col 3: mid > 72% (прадеды, ~x 1000-1250)
  const col1Max = Math.round(imgWidth * 0.45);
  const col2Max = Math.round(imgWidth * 0.72);

  // Фильтруем параграфы в области родословной
  const pedigreeParas = paragraphs.filter(p =>
    p.y > pedigreeTop && p.y < pedigreeBottom && p.x > Math.round(imgWidth * 0.22)
  );

  // Распределяем по колонкам
  const columns = [[], [], []];
  for (const p of pedigreeParas) {
    if (p.mid < col1Max) columns[0].push(p);
    else if (p.mid < col2Max) columns[1].push(p);
    else columns[2].push(p);
  }

  // Сортируем каждую колонку по Y (сверху вниз)
  for (const col of columns) col.sort((a, b) => a.y - b.y);

  // Фильтруем записи: оставляем имена собак и плейсхолдеры "не указан"
  function filterEntries(entries) {
    const filtered = [];
    for (const e of entries) {
      const t = e.text;
      if (/не указан/i.test(t)) {
        filtered.push({ ...e, name: "" }); // пустой слот — сохраняет позицию
      } else if (/поколени|ПРОИСХОЖДЕНИЕ|ПОТОМКИ|СИБЛИНГИ|КАРЬЕРА|отзывы|Метрика|родословн/i.test(t)) {
        continue; // навигационный шум
      } else if (/^\d[\d\s\.\-\/]+$/.test(t.trim())) {
        continue; // чистые числа
      } else if (isDogName(t)) {
        filtered.push({ ...e, name: cleanName(t) });
      }
    }
    return filtered;
  }

  const f1 = filterEntries(columns[0]);
  const f2 = filterEntries(columns[1]);
  const f3 = filterEntries(columns[2]);

  const result = {};

  // Родители: первое реальное имя сверху = отец, последнее снизу = мать
  const parentsSorted = f1.sort((a, b) => a.y - b.y);
  const sireEntry = parentsSorted.find(e => e.name);
  const damEntry = [...parentsSorted].reverse().find(e => e.name && e !== sireEntry);
  if (sireEntry) result.sire = sireEntry.name;
  if (damEntry) result.dam = damEntry.name;

  // Деды и прадеды: последовательное назначение слотов сверху вниз
  // На ZooPortal порядок записей в каждой колонке строго соответствует
  // позициям в родословном дереве (сверху вниз):
  //   Col 2: grandSireS → grandDamS → grandSireD → grandDamD
  //   Col 3: ggSireSS → ggDamSS → ggSireSD → ggDamSD → ggSireDS → ggDamDS → ggSireDD → ggDamDD

  const gpSorted = f2.sort((a, b) => a.y - b.y);
  if (gpSorted[0]?.name) result.grandSireS = gpSorted[0].name;
  if (gpSorted[1]?.name) result.grandDamS = gpSorted[1].name;
  if (gpSorted[2]?.name) result.grandSireD = gpSorted[2].name;
  if (gpSorted[3]?.name) result.grandDamD = gpSorted[3].name;

  const ggSorted = f3.sort((a, b) => a.y - b.y);
  const ggFields = ["ggSireSS","ggDamSS","ggSireSD","ggDamSD","ggSireDS","ggDamDS","ggSireDD","ggDamDD"];
  for (let i = 0; i < ggFields.length && i < ggSorted.length; i++) {
    if (ggSorted[i]?.name) result[ggFields[i]] = ggSorted[i].name;
  }

  return result;
}

// ============================================================
// ОБРАБОТКА ФАЙЛОВ
// ============================================================

async function processFile(filename) {
  const filePath = path.join(SCREENSHOTS_DIR, filename);
  const imageBuffer = fs.readFileSync(filePath);
  const base64 = imageBuffer.toString("base64");

  const response = await callVisionAPI(base64);
  const fullText = response.responses[0].textAnnotations?.[0]?.description || "";
  const headerFields = extractFromFullText(fullText);
  const pedigreeFields = extractPedigree(response);
  const dogName = filename.replace(/\.png$/i, "").trim();

  return {
    filename,
    dogName,
    ...headerFields,
    ...pedigreeFields,
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log(`📂 Папка скринов: ${SCREENSHOTS_DIR}`);
  console.log(`📄 Выходной файл: ${OUTPUT_FILE}`);
  console.log(`⚡ Параллельность: ${CONCURRENCY}\n`);

  // Resume: загружаем уже обработанные
  let processed = new Map();
  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      const wb = XLSX.readFile(OUTPUT_FILE);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const existing = XLSX.utils.sheet_to_json(ws);
      for (const row of existing) {
        if (row.filename) processed.set(row.filename, row);
      }
      console.log(`♻️  Resume: ${processed.size} уже обработано`);
    } catch(e) {}
  }

  const allFiles = fs.readdirSync(SCREENSHOTS_DIR)
    .filter(f => f.toLowerCase().endsWith(".png"))
    .sort();

  const toProcess = allFiles.filter(f => !processed.has(f));
  console.log(`📊 Всего файлов: ${allFiles.length}`);
  console.log(`🆕 К обработке: ${toProcess.length}\n`);

  if (toProcess.length === 0) {
    console.log("✅ Все файлы уже обработаны.");
    return;
  }

  let done = 0, errors = 0;

  for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
    const batch = toProcess.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(f => processFile(f)));

    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === "fulfilled" && r.value) {
        processed.set(r.value.filename, r.value);
        done++;
      } else {
        errors++;
        console.error(`❌ ${batch[j]}: ${r.reason?.message || r.reason}`);
      }
    }

    if (done % 100 === 0 || i + CONCURRENCY >= toProcess.length) {
      console.log(`Progress: ${done}/${toProcess.length} done, ${errors} errors`);

      // Промежуточное сохранение каждые 100
      if (done % 100 === 0) {
        saveXlsx(allFiles, processed);
      }
    }
    await sleep(DELAY_MS);
  }

  // Финальное сохранение
  saveXlsx(allFiles, processed);

  console.log(`\n✅ Готово! ${done} обработано, ${errors} ошибок`);
  console.log(`📊 Всего строк: ${processed.size}`);
  console.log(`📄 Файл: ${OUTPUT_FILE}`);
}

function saveXlsx(allFiles, processed) {
  const allRows = allFiles
    .map(f => processed.get(f))
    .filter(Boolean)
    .sort((a, b) => (a.dogName || "").localeCompare(b.dogName || ""));

  const wsData = [HEADER, ...allRows.map(row => HEADER.map(h => row[h] || ""))];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws["!cols"] = HEADER.map(h => ({ wch: h === "dogName" ? 35 : h.startsWith("gg") ? 30 : 25 }));
  XLSX.utils.book_append_sheet(wb, ws, "Pedigrees");
  XLSX.writeFile(wb, OUTPUT_FILE);
}

main().catch(console.error);
