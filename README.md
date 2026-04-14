# BreedWorld Pedigree Parser & Import Pipeline

Полный пайплайн: скриншоты ZooPortal → OCR → XLSX → импорт в PostgreSQL → очистка.

---

## Структура проекта

```
parser/
├── vision-ocr.js           # 1. OCR парсер: PNG скрины → XLSX
├── import-vision.ts         # 2. Импорт: XLSX/CSV → PostgreSQL (создание собак + связи)
├── cleanup-false-links.ts   # 3. Очистка ложных связей
├── fix-dirty-names.ts       # 4. Очистка грязных имён (РКФ номера, цвета)
├── package.json
└── README.md                # Эта инструкция
```

---

## Полный пайплайн (пошагово)

### Шаг 1: OCR скриншотов

```bash
node vision-ocr.js --dir /path/to/screenshots/all --output /path/to/pedigrees_vision.xlsx
```

**Что делает:**
- Читает PNG файлы из папки (имя файла = кличка собаки)
- Отправляет в Google Cloud Vision API (DOCUMENT_TEXT_DETECTION)
- Извлекает: пол, дату рождения, окрас, клеймо, РКФ, питомник, заводчик, владелец
- Извлекает родословную (3 поколения): sire, dam, 4 деда, 8 прадедов
- Сохраняет в XLSX

**Параметры:**
- `--dir` — папка с PNG (по умолчанию `../screenshots/all`)
- `--output` — выходной файл (по умолчанию `../screenshots/pedigrees_vision.xlsx`)
- `--concurrency` — параллельность (по умолчанию 5)
- `GOOGLE_VISION_API_KEY` — env переменная с ключом API

**Resume:** если скрипт упал — перезапустите, он продолжит с места остановки.

### Шаг 1.5: Валидация XLSX перед импортом

Перед импортом нужно очистить XLSX от мусора OCR (титулы вместо имён, РКФ номера вместо имён):

```bash
node -e "
const XLSX = require('xlsx');
const fs = require('fs');
const wb = XLSX.readFile('pedigrees_vision.xlsx');
const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);

function isBadName(s) {
  if (!s) return false;
  const t = s.trim();
  if (/^(CH\.|JCH\.|GrCH\.|VGrCH\.|VCH\.|RUS\s*,|NBIS|BIS|MOSCOW)/i.test(t)) return true;
  if (/^(РКФ|RKF|UKU|BCU|PKF)[\.\s\/]/i.test(t)) return true;
  if ((t.match(/\b(CH|JCH|GrCH|VCH|NBIS|BIS)\b/gi) || []).length >= 2) return true;
  return false;
}

const nameFields = ['sire','dam','grandSireS','grandDamS','grandSireD','grandDamD',
  'ggSireSS','ggDamSS','ggSireSD','ggDamSD','ggSireDS','ggDamDS','ggSireDD','ggDamDD'];
let cleaned = 0;
for (const row of data) {
  for (const f of nameFields) {
    if (row[f] && isBadName(row[f])) { row[f] = ''; cleaned++; }
  }
}
console.log('Cleaned:', cleaned);

// Write CSV
const HEADER = ['filename','dogName','sex','dateOfBirth','color','tattoo','regNumber',
  'kennel','breeder','owner','sire','dam','grandSireS','grandDamS','grandSireD','grandDamD',
  'ggSireSS','ggDamSS','ggSireSD','ggDamSD','ggSireDS','ggDamDS','ggSireDD','ggDamDD'];
let csv = '\ufeff' + HEADER.join(';') + '\n';
for (const row of data) {
  csv += HEADER.map(h => '\"' + ((row[h]||'')+'').replace(/\"/g,'\"\"') + '\"').join(';') + '\n';
}
fs.writeFileSync('pedigrees_vision_clean.csv', csv, 'utf8');
"
```

### Шаг 2: Импорт в базу данных

```bash
DATABASE_URL="postgresql://breedworld:PASSWORD@localhost:5432/breedworld" \
npx tsx import-vision.ts pedigrees_vision_clean.csv
```

**Что делает (3 фазы):**

1. **Фаза 1 — Создание/обновление собак:**
   - Для каждой строки CSV находит собаку по имени в БД
   - Если есть — заполняет **пустые** поля (цвет, дата рождения, клеймо, окрас, питомник)
   - Если нет — создаёт новую собаку
   - НЕ перезаписывает существующие данные (только заполняет пустые)

2. **Фаза 2 — Создание собак-предков:**
   - Проходит все поля предков (sire, dam, деды, прадеды)
   - Если предка нет в базе — создаёт с полом из названия поля (sire=MALE, dam=FEMALE)

3. **Фаза 3 — Связывание на 3 уровня:**
   - Level 1: dogId → sireId, damId
   - Level 2: sireId → grandSireS, grandDamS; damId → grandSireD, grandDamD
   - Level 3: grandSireS → ggSireSS, ggDamSS; и т.д. для всех 8 прадедов

### Шаг 3: Очистка грязных имён

```bash
DATABASE_URL="postgresql://..." npx tsx fix-dirty-names.ts
```

**Что делает:**
- Находит собак с мусором в имени (РКФ номера, описания окраса, "метрика")
- Если есть чистый дубль — объединяет (переносит связи)
- Если дубля нет — переименовывает
- Если есть потомки — НЕ удаляет (выводит предупреждение)

### Шаг 4: Очистка ложных связей (ОСТОРОЖНО!)

```bash
DATABASE_URL="postgresql://..." npx tsx cleanup-false-links.ts pedigrees_vision_clean.csv
```

**ВАЖНО:** Этот скрипт УДАЛЯЕТ связи sireId/damId у собак, где в CSV поле предка пустое. Логика: если на скрине ZooPortal написано "Отец не указан" — значит связь в базе ложная.

**КРИТИЧЕСКОЕ ПРЕДУПРЕЖДЕНИЕ:**
- Скрипт ОБЯЗАТЕЛЬНО должен получать АКТУАЛЬНЫЙ CSV (тот же что использовался для импорта!)
- Если передать старый CSV (например v06 вместо v10) — он УДАЛИТ правильные связи!
- **Именно эта ошибка произошла 14.04.2026:** cleanup работал по `pedigrees_vision_06.csv` (534 строки), а import загрузил данные из `pedigrees_vision_10_clean.csv` (2066 строк). Cleanup удалил связи которые import только что добавил.
- **Решение:** после ошибочного cleanup перезапустить import — он восстановит удалённые связи.

---

## Алгоритм OCR парсера (подробно)

### Извлечение полей карточки

Парсит полный текст построчно, ищет ключевые слова:
- `Пол` → Кобель/Сука
- `Дата рождения` → ДД.ММ.ГГГГ
- `Окрас` → текст после "Окрас:"
- `Клеймо` → текст после "Клеймо:"
- `Заводчик`, `Владелец`, `Питомник` — аналогично
- `№ родословной` → регулярка (РКФ|RKF|FBR|LOF...) + цифры

### Извлечение родословной

**Макет ZooPortal (1400×1300 px):**

```
┌────────────────┬───────────────────┬──────────────────────┐
│  Col 1         │  Col 2            │  Col 3               │
│  РОДИТЕЛИ      │  ДЕДЫ             │  ПРАДЕДЫ             │
│  x mid < 45%  │  x mid 45-72%    │  x mid > 72%         │
│  (~470 px)     │  (~790 px)        │  (~1110 px)          │
│                │                   │                      │
│  [Отец]        │  [Дед по отцу]    │  [ОО отца]           │
│                │  [Бабка по отцу]  │  [МО отца]           │
│                │                   │  [ОМ отца]           │
│  [Мать]        │  [Дед по матери]  │  [ММ отца]           │
│                │  [Бабка по матери]│  [ОО матери]         │
│                │                   │  [МО матери]         │
│                │                   │  [ОМ матери]         │
│                │                   │  [ММ матери]         │
└────────────────┴───────────────────┴──────────────────────┘
```

**Алгоритм:**
1. Получаем параграфы с bounding box от Vision API
2. Область родословной: после "ПРОИСХОЖДЕНИЕ", x > 22% ширины
3. Разбиваем на 3 колонки по X-середине bounding box
4. В каждой колонке сортируем по Y (сверху вниз)
5. "Не указан" → пустой слот (сохраняет позицию!)
6. Назначаем слоты последовательно сверху вниз

**Фильтрация титулов (`isTitleString`):**
- Строки типа `CH.RKF, JCH.RUS, VCH.RKF` — это титулы, НЕ кличка
- Отклоняются если начинаются с `CH.`/`JCH.`/`GrCH.` или содержат 2+ титула

### Очистка имён (`cleanName`)

| Мусор | Действие |
|-------|----------|
| РКФ номера (`РКФ 4339014`) | Удаляется |
| Даты (`22.12.2019`) | Удаляется |
| Окрас (`черно-бело-золотой`) | Удаляется |
| Пол (`сука`, `кобель`) | Удаляется |
| Смесь алфавитов | Оставляется латиница |

---

## Точность

| Поле | Точность | Комментарий |
|------|----------|-------------|
| sire (отец) | ~99% | Редко ошибается |
| dam (мать) | ~98% | |
| Деды (4 поля) | ~50-56% | Много "не указан" на ZooPortal |
| Прадеды (8 полей) | ~6-14% | Большинство "не указан" |

Низкий % дедов/прадедов — не ошибка парсера, а отсутствие данных на ZooPortal.

---

## Конфигурация сервера

```
Сервер: 82.202.131.27
БД: postgresql://breedworld:BW_strong_pass_2026@localhost:5432/breedworld
Проект: /var/www/breedworld
Деплой: bash /var/www/breedworld/deploy.sh
```

---

## История инцидентов

### 14.04.2026 — cleanup удалил правильные связи

**Что случилось:**
1. `import-vision.ts` загрузил данные из `pedigrees_vision_10_clean.csv` (2066 строк)
2. `cleanup-false-links.ts` запустился с дефолтным путём `pedigrees_vision_06.csv` (534 строки)
3. Cleanup увидел что в v06 у многих собак деды пустые → удалил связи которые import только что добавил из v10

**Как исправили:**
- Перезапустили `import-vision.ts` с v10 → 1264 связей восстановлено

**Урок:**
- ВСЕГДА передавать cleanup тот же CSV что и import: `npx tsx cleanup-false-links.ts pedigrees_vision_10_clean.csv`
- Или не запускать cleanup после import из нового файла

---

## Полный пример запуска

```bash
# На сервере 82.202.131.27:
cd /var/www/breedworld

# 1. Импорт
DATABASE_URL='postgresql://breedworld:BW_strong_pass_2026@localhost:5432/breedworld' \
npx tsx tools/import-vision.ts screenshots/pedigrees_vision_10_clean.csv

# 2. Очистка имён
DATABASE_URL='postgresql://breedworld:BW_strong_pass_2026@localhost:5432/breedworld' \
npx tsx tools/fix-dirty-names.ts

# 3. Очистка связей (ТОЛЬКО с тем же CSV!)
DATABASE_URL='postgresql://breedworld:BW_strong_pass_2026@localhost:5432/breedworld' \
npx tsx tools/cleanup-false-links.ts screenshots/pedigrees_vision_10_clean.csv
```

---

## Колонки XLSX

| # | Колонка | Описание |
|---|---------|----------|
| 1 | filename | Имя PNG файла |
| 2 | dogName | Кличка (из имени файла) |
| 3 | sex | Пол |
| 4 | dateOfBirth | Дата рождения |
| 5 | color | Окрас |
| 6 | tattoo | Клеймо |
| 7 | regNumber | Номер родословной |
| 8 | kennel | Питомник |
| 9 | breeder | Заводчик |
| 10 | owner | Владелец |
| 11 | sire | Отец |
| 12 | dam | Мать |
| 13 | grandSireS | Дед по отцу |
| 14 | grandDamS | Бабка по отцу |
| 15 | grandSireD | Дед по матери |
| 16 | grandDamD | Бабка по матери |
| 17-24 | gg* | 8 прадедов |
