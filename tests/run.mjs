#!/usr/bin/env node
// Тесты парсера .K20 и округления. Запуск из корня репозитория: node tests/run.mjs
//
// Ядро берётся прямо из index.html (блок между маркерами K20CORE) — тесты
// гоняют тот же код, что исполняется на странице, без отдельной сборки.
//
// Реальные архивы и эталонные выгрузки КАРАТ-Экспресс кладутся в tests/private/
// (каталог в .gitignore — данные объекта не публикуются). Без них молча
// выполняются только синтетические сьюты, поэтому в CI набор меньше, чем локально.
import {readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync} from "fs";
import {execFileSync} from "child_process";
import {createRequire} from "module";
import {dirname, join, basename} from "path";
import {fileURLToPath} from "url";
import {tmpdir} from "os";

const DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(DIR, "..");
const PRIV = join(DIR, "private");
const require = createRequire(import.meta.url);

// ---------------- ядро из index.html ----------------
function loadCore(){
  const src = readFileSync(join(ROOT, "index.html"), "utf8");
  const m = src.match(/\/\/ ====== K20CORE-BEGIN ======([\s\S]*?)\/\/ ====== K20CORE-END ======/);
  if (!m) throw new Error("маркеры K20CORE не найдены в index.html");
  return new Function(m[1] + `
    return {parseK20, chainRound, halfUpScaled, rep, decFor, isT, isV, isFlagCol,
            isDateCol, decodeEr0, readShortStrings, total, fmtD, fmtN, buildAoa, K20Error};`)();
}
const C = loadCore();

// ---------------- мини-каркас ----------------
let passed = 0, failed = 0, suite = "";
function head(s){ suite = s; console.log("\n== " + s + " =="); }
function ok(cond, label){
  if (cond){ passed++; return true; }
  failed++;
  console.error("  ✗ " + label);
  return false;
}
function eq(a, b, label){
  return ok(Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b),
    label + ": получено " + JSON.stringify(a) + ", ожидалось " + JSON.stringify(b));
}
// детерминированный ГПСЧ, чтобы фазз воспроизводился
function lcg(seed){
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}
const toAB = b => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

// ---------------- сборка синтетических .K20 ----------------
// Заголовок реального посуточного архива ЭЛЬФ (0x39 байт, побайтно одинаков
// во всех выгрузках; серийного номера и данных объекта не содержит).
const HDR_HEX =
  "6e007f0001c0121b0185000000000e0b0d041484031383" + "00".repeat(0x39 - 23);
const CP = (() => {
  const dec = new TextDecoder("windows-1251"), map = new Map();
  for (let b = 0; b < 256; b++) map.set(dec.decode(new Uint8Array([b])), b);
  return s => Buffer.from([...s].map(ch => {
    const b = map.get(ch);
    if (b == null) throw new Error("символа нет в cp1251: " + ch);
    return b;
  }));
})();
const shortStr = s => { const b = CP(s); return Buffer.concat([Buffer.from([b.length]), b]); };
// rows — по строкам (первая колонка TDateTime); в файле данные лежат поколоночно
function buildK20({names, count, rows, meta, gapBytes = 128}){
  const hdr = Buffer.from(HDR_HEX, "hex");
  hdr.writeUInt16LE(count, 2);
  const nameBufs = names.map(shortStr);
  const Cn = names.length;
  const data = Buffer.alloc(Cn * count * 8);
  for (let c = 0; c < Cn; c++)
    for (let i = 0; i < count; i++)
      data.writeDoubleLE(rows[i][c], (c * count + i) * 8);
  const metaBufs = (meta || []).map(shortStr);
  return Buffer.concat([hdr, ...nameBufs, data, Buffer.alloc(gapBytes), ...metaBufs]);
}
const tdt = (y, m, d, frac = 23 / 24) =>
  (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000 + frac;
// биты Er в файле лежат как float32-битовая маска, расширенная до double
function erBits(bits){
  const b = new DataView(new ArrayBuffer(4));
  b.setUint32(0, bits, true);
  return b.getFloat32(0, true);
}

// ---------------- 1. синтетика: одноканальный (как ЭЛЬФ) ----------------
head("синтетика: одноканальный посуточный");
{
  const names = ["Дата", "Er0", "Наработка H0", "V1ѕ", "V1ј", "dV1", "T1ѕ", "T1ј", "dT1", "Q1ѕ"];
  const rows = [
    [tdt(2026, 6, 24), 0,          24, 1.30012, 1.30144, 0.00132, 65.664, 41.031, 24.633, 0.03761],
    [tdt(2026, 6, 25), erBits(1),  24, 1.20401, 1.20388, -0.00013, 66.121, 40.879, 25.242, 0.03949],
  ];
  const arc = C.parseK20(toAB(buildK20({names, count: 2, rows,
    meta: ["ТЕСТ", "Посуточный архив. ТЕСТ, № 1234567", "1234567"]})));
  eq(arc.names.join(","), "Дата,Er0,Наработка H0,V1под,V1обр,dV1,T1под,T1обр,dT1,Q1под", "имена с ѕ/ј → под/обр");
  eq(arc.rows.length, 2, "число записей");
  eq(arc.diag.skipped, 0, "нет пропусков");
  eq(arc.meta.device, "ТЕСТ", "meta.device");
  eq(arc.meta.serial, "1234567", "meta.serial");
  eq(C.fmtD(arc.rows[0].date), "24.06.2026", "дата первой записи");
  eq(arc.rows[1].vals["Er0"], "Bat;", "Er0 бит 0 → Bat;");
  eq(arc.rows[0].vals["Er0"], "", "Er0 без битов → пусто");
  eq(C.rep("T1под", arc.rows[0].vals["T1под"]), 65.66, "T: каскад 3→2");
  eq(C.rep("V1под", arc.rows[0].vals["V1под"]), 1.3, "V: каскад 5→1");
  eq(C.rep("Q1под", arc.rows[0].vals["Q1под"]), 0.04, "Q: каскад 5→2");
  eq(C.total(arc.rows, "dT1"), 49.87, "Итого: сумма построчно округлённых");
}

// ---------------- 2. синтетика: двухканальный (как КАРАТ-М) ----------------
head("синтетика: двухканальный прибор, перемешанный буфер, NaN, битые даты");
{
  const names = ["Дата", "Er0", "Er1", "Наработка H0", "Наработка H1",
    "V1ѕ", "V1ј", "dV1", "V2ѕ", "V2ј", "dV2", "G1ѕ", "G2ѕ",
    "T1ѕ", "T1ј", "dT1", "T2ѕ", "T2ј", "dT2", "P1", "P2", "Q1ѕ", "Q2ѕ"];
  const mkRow = (day, er1) => [tdt(2026, 7, day), 0, er1, 24, 24,
    1.1 + day / 1000, 1.0, 0.1, 2.2, 2.1, 0.1, 3.3, 3.2,
    65.5, 41.1, 24.4, 70.017, 45.5, 24.515, 4.25, 4.11, 0.037, 0.041];
  const rows = [mkRow(15, 0), mkRow(13, 0), mkRow(14, erBits(1))]; // нарочно не по порядку
  rows.push([tdt(1980, 1, 1), 0, 0, ...Array(20).fill(0)]);        // дата вне диапазона
  const nanRow = mkRow(16, 0); nanRow[5] = NaN;                    // V1под битый
  rows.push(nanRow);
  const arc = C.parseK20(toAB(buildK20({names, count: 5, rows,
    meta: ["КАРАТ-М", "Посуточный архив. КАРАТ-М, № 7654321", "7654321"]})));
  eq(arc.diag.skipped, 1, "запись с датой 1980 г. отброшена");
  eq(arc.rows.length, 4, "остальные записи на месте");
  eq(arc.rows.map(r => C.fmtD(r.date)).join(" "),
     "13.07.2026 14.07.2026 15.07.2026 16.07.2026", "кольцевой буфер отсортирован по дате");
  eq(arc.rows[1].vals["Er1"], "Bat;", "второй канал: Er1 декодирован");
  eq(arc.rows[3].vals["V1под"], null, "NaN → null (не мусор в таблице)");
  eq(C.fmtN(null, "V1под"), "—", "null показывается прочерком");
  eq(C.rep("T2под", 70.017), 70.02, "T2 округляется как температура");
  eq(C.rep("dT2", 24.515), 24.52, "dT2 — температура");
  eq(C.rep("V2под", 2.2), 2.2, "V2 — объём (1 знак)");
  eq(C.rep("G1под", 3.34567), 3.3, "G (масса) — как объём");
  eq(C.rep("P1", 4.256789), 4.26, "P (давление) — по умолчанию 2 знака");
  const tableCols = arc.names.slice(1).filter(n => !C.isFlagCol(n));
  ok(!tableCols.includes("Er0") && !tableCols.includes("Er1"), "Er0 и Er1 скрыты из таблицы");
  eq(tableCols.length, 20, "остальные 20 колонок в таблице");
}

// ---------------- 3. фазз: обрезки, бит-флипы, мусор ----------------
head("фазз: повреждённые и мусорные файлы");
{
  const names = ["Дата", "Er0", "Наработка H0", "V1ѕ", "V1ј", "dV1", "T1ѕ", "T1ј", "dT1", "Q1ѕ"];
  const rows = [];
  for (let d = 1; d <= 30; d++)
    rows.push([tdt(2026, 6, d), 0, 24, 1.3, 1.29, 0.01, 65.6, 41.0, 24.6, 0.037]);
  const base = buildK20({names, count: 30, rows,
    meta: ["ТЕСТ", "Посуточный архив. ТЕСТ, № 1234567", "1234567"]});

  // парсер обязан либо вернуть корректную структуру, либо бросить K20Error —
  // никаких TypeError/RangeError и никаких строк с Invalid Date
  let wrongErr = 0, badRow = 0, checked = 0;
  function probe(buf){
    checked++;
    let arc;
    try { arc = C.parseK20(toAB(buf)); }
    catch(e){
      if (!(e instanceof C.K20Error)) { wrongErr++; if (wrongErr === 1) console.error("  не-K20Error:", e.constructor.name, e.message); }
      return;
    }
    for (const r of arc.rows){
      if (isNaN(r.date.getTime())) { badRow++; return; }
      for (const n of arc.names.slice(1)){
        const v = r.vals[n];
        if (!(v === null || typeof v === "string" || (typeof v === "number" && isFinite(v)))) { badRow++; return; }
      }
    }
  }
  // обрезки на всех границах
  const namesEnd = 0x39 + names.reduce((a, n) => a + 1 + CP(n).length, 0);
  const dataEnd = namesEnd + names.length * 30 * 8;
  for (const len of [0, 1, 2, 3, 4, 16, 0x38, 0x39, 0x3a, namesEnd - 1, namesEnd,
                     namesEnd + 1, namesEnd + 37, dataEnd - 1, dataEnd, dataEnd + 5,
                     dataEnd + 128, base.length - 1])
    probe(base.subarray(0, len));
  // усечение вообще каждых 256 байт
  for (let len = 0; len < base.length; len += 256) probe(base.subarray(0, len));
  // бит-флипы: детерминированные
  const rnd = lcg(20260726);
  for (let k = 0; k < 500; k++){
    const b = Buffer.from(base);
    const flips = 1 + Math.floor(rnd() * 3);
    for (let f = 0; f < flips; f++){
      const p = Math.floor(rnd() * b.length);
      b[p] ^= 1 << Math.floor(rnd() * 8);
    }
    probe(b);
  }
  // случайный мусор
  for (let k = 0; k < 120; k++){
    const n = Math.floor(rnd() * 4000);
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i++) b[i] = Math.floor(rnd() * 256);
    probe(b);
  }
  // прицельные повреждения заголовка
  for (const [off, val] of [[2, 0], [3, 0], [2, 255], [3, 255], [0x39, 0], [0x39, 255]]){
    const b = Buffer.from(base); b[off] = val; probe(b);
  }
  // не-дата в первой колонке
  probe(buildK20({names: ["Мусор", "V1ѕ"], count: 2,
    rows: [[1, 2], [3, 4]], meta: []}));
  eq(wrongErr, 0, "все отказы — контролируемый K20Error (" + checked + " проб)");
  eq(badRow, 0, "ни одной строки с Invalid Date или мусорным значением");
  console.log("  проверено файлов: " + checked);
}

// ---------------- 4. округление: сверка с python-референсом ----------------
head("округление: JS chainRound == python decimal ROUND_HALF_UP");
{
  const cases = [];
  const pairs = [[3, 2], [5, 1], [5, 2]];
  for (const v of [0.755, 1.005, 0.955, 2.675, 0.045, 0.9995, 1.0005, 0.0005,
                   0.015, 0.025, 0.125, 99999.985, 0.755001, 0.754999,
                   24.633000000000003, 18.12510871887207, 0.1286487579345703,
                   11.866666666666667, 1.30012, -0.00013, -1.005, -0.755, 0, 1e-7, 123456.789])
    for (const [a, b] of pairs) cases.push([v, a, b]);
  const rnd = lcg(42);
  for (let k = 0; k < 3000; k++){
    const mag = 10 ** Math.floor(rnd() * 6 - 1);
    const v = (rnd() * 2 - 1) * mag;
    cases.push([v, ...pairs[k % 3]]);
  }
  // все значения из реальных архивов, если они есть
  if (existsSync(PRIV))
    for (const f of readdirSync(PRIV).filter(f => /\.k20$/i.test(f))){
      const arc = C.parseK20(toAB(readFileSync(join(PRIV, f))));
      for (const r of arc.rows)
        for (const n of arc.names.slice(1)){
          const v = r.vals[n];
          if (typeof v === "number")
            cases.push([v, ...(C.isT(n) ? [3, 2] : C.isV(n) ? [5, 1] : [5, 2])]);
        }
    }
  let py = null;
  try {
    py = JSON.parse(execFileSync("python3", [join(DIR, "round_ref.py")],
      {input: JSON.stringify(cases), maxBuffer: 1 << 26}).toString());
  } catch (e) {
    console.log("  python3 недоступен — сьют пропущен (" + e.message.split("\n")[0] + ")");
  }
  if (py){
    let diff = 0;
    for (let i = 0; i < cases.length; i++){
      const [v, a, b] = cases[i];
      const js = C.chainRound(v, a, b);
      if (!Object.is(js === 0 ? 0 : js, py[i] === 0 ? 0 : py[i]) && js !== py[i]){
        diff++;
        if (diff <= 5) console.error(`  ✗ chainRound(${v},${a},${b}) = ${js}, python: ${py[i]}`);
      }
    }
    eq(diff, 0, "расхождений с python-референсом (" + cases.length + " случаев)");
  }
}

// ---------------- 5. реальные архивы (tests/private/) ----------------
head("реальные архивы (golden)");
if (!existsSync(PRIV)) {
  console.log("  tests/private/ отсутствует — пропущено (локальный сьют)");
} else {
  const k20s = readdirSync(PRIV).filter(f => /\.k20$/i.test(f)).sort();
  if (!k20s.length) console.log("  файлов .K20 нет — пропущено");
  const goldDir = join(PRIV, "golden");
  if (k20s.length) mkdirSync(goldDir, {recursive: true});
  for (const f of k20s){
    const arc = C.parseK20(toAB(readFileSync(join(PRIV, f))));
    ok(arc.rows.length > 0 && arc.diag.skipped === 0, f + ": разобран без пропусков");
    ok(arc.names[0] === "Дата" && !arc.names.slice(1).some(n => !n), f + ": имена колонок целы");
    for (let i = 1; i < arc.rows.length; i++)
      if (arc.rows[i].date < arc.rows[i - 1].date) { ok(false, f + ": даты не по порядку"); break; }
    // снапшот: вся таблица в представлении отчёта
    const snap = arc.rows.map(r => [C.fmtD(r.date),
      ...arc.names.slice(1).map(n => {
        const v = r.vals[n];
        return typeof v === "string" ? v : C.rep(n, v);
      })]);
    snap.push(["Итого", ...arc.names.slice(1).map(n =>
      C.isFlagCol(n) ? "" : C.total(arc.rows, n))]);
    const gf = join(goldDir, basename(f) + ".json");
    if (!existsSync(gf)){
      writeFileSync(gf, JSON.stringify({names: arc.names, meta: arc.meta, snap}, null, 1));
      console.log("  " + f + ": эталонный снапшот записан (" + arc.rows.length + " строк)");
    } else {
      const g = JSON.parse(readFileSync(gf, "utf8"));
      eq(JSON.stringify({names: arc.names, meta: arc.meta, snap}),
         JSON.stringify(g), f + ": совпадает со снапшотом");
    }
  }
}

// ---------------- 6. эталонные выгрузки КАРАТ-Экспресс ----------------
head("эталон: отчёт КАРАТ-Экспресс (.xls) == наши rep()/total()");
if (!existsSync(PRIV)) {
  console.log("  tests/private/ отсутствует — пропущено (локальный сьют)");
} else {
  const XLSX = require(join(DIR, "xlsx.full.dev.js"));
  // etalon_MMDD.xls(x) соответствует архиву MMDDA0.K20:
  //  .xls  — машинная выгрузка КАРАТ-Экспресс (старый BIFF: кириллица заголовков
  //          не читается, порядок колонок канонический, строки «Итого» нет);
  //  .xlsx — ведомость, собранная вручную из той же программы (есть «Итого»).
  const xlss = readdirSync(PRIV).filter(f => /^etalon_\d{4}\.(xls|xlsx)$/.test(f)).sort();
  if (!xlss.length) console.log("  файлов etalon_*.xls(x) нет — пропущено");
  const revMap = {"Причина ненаработки": "Er0", "Наработка": "Наработка H0", "Vo": "dV1"};
  // канонический порядок колонок посуточной выгрузки ЭЛЬФ (наши имена)
  const CANON = ["Дата", "Er0", "Наработка H0", "V1под", "V1обр", "dV1",
                 "T1под", "T1обр", "dT1", "Q1под"];
  for (const xf of xlss){
    const mmdd = xf.match(/\d{4}/)[0];
    const kf = join(PRIV, mmdd + "A0.K20");
    if (!existsSync(kf)) { console.log("  " + xf + ": нет парного " + mmdd + "A0.K20 — пропущен"); continue; }
    const arc = C.parseK20(toAB(readFileSync(kf)));
    const byDate = new Map(arc.rows.map(r => [C.fmtD(r.date), r]));
    const wb = XLSX.read(readFileSync(join(PRIV, xf)), {type: "buffer", codepage: 1251});
    const sheet = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {header: 1, raw: true});
    let hi = sheet.findIndex(r => r && r.includes("Дата"));
    let hdr;
    if (hi >= 0) hdr = sheet[hi].map(h => revMap[h] || h);
    else {
      // старый BIFF: кириллица потеряна — опознаём по латинским якорям Vo и dT1
      hi = sheet.findIndex(r => r && r[5] === "Vo" && r[8] === "dT1");
      if (hi >= 0) hdr = CANON;
    }
    if (!ok(hi >= 0, xf + ": строка заголовков найдена")) continue;
    // строки эталона с датами и их пары в архиве — заранее, для сверки «Итого»
    const dateRows = sheet.slice(hi + 1)
      .filter(r2 => r2 && /^\d\d\.\d\d\.\d{4}/.test(String(r2[0])));
    const matched = dateRows.map(r2 => byDate.get(String(r2[0]).slice(0, 10))).filter(Boolean);
    let cells = 0, diffs = 0, rowsMatched = 0, totalDiffs = 0, sawTotal = false;
    for (const row of sheet.slice(hi + 1)){
      if (!row || row[0] == null) continue;
      const c0 = String(row[0]);
      if (/^Итого/.test(c0)){
        sawTotal = true;
        if (matched.length !== dateRows.length){
          console.log("  " + xf + ": период эталона шире архива — «Итого» не сверяется");
          continue;
        }
        for (let c = 1; c < hdr.length; c++){
          const n = hdr[c];
          if (!n || C.isFlagCol(n) || row[c] == null || typeof row[c] !== "number") continue;
          if (C.total(matched, n) !== row[c]){
            totalDiffs++;
            console.error(`  ✗ ${xf} Итого[${n}]: у нас ${C.total(matched, n)}, в эталоне ${row[c]}`);
          }
        }
        continue;
      }
      const dm = c0.match(/^(\d\d\.\d\d\.\d{4})/);
      if (!dm) continue;
      const kr = byDate.get(dm[1]);
      if (!kr) continue;
      rowsMatched++;
      for (let c = 1; c < hdr.length; c++){
        const n = hdr[c];
        if (!n || !(n in kr.vals)) continue;
        const ours = kr.vals[n], theirs = row[c];
        cells++;
        if (typeof ours === "string"){
          const a = String(theirs == null ? "Ok" : theirs).trim(), b = ours ? ours.trim() : "Ok";
          if (a !== b && !(a === "Ok" && b === "")) { diffs++; if (diffs <= 4) console.error(`  ✗ ${xf} ${dm[1]} ${n}: «${a}» ≠ «${b}»`); }
        } else {
          const r = C.rep(n, ours);
          if (r !== theirs) { diffs++; if (diffs <= 4) console.error(`  ✗ ${xf} ${dm[1]} ${n}: у нас ${r}, в эталоне ${theirs}`); }
        }
      }
    }
    ok(rowsMatched > 0, xf + ": строки сопоставлены с архивом (" + rowsMatched + ")");
    eq(diffs, 0, xf + ": расхождения в ячейках (" + cells + " сверено)");
    if (sawTotal) eq(totalDiffs, 0, xf + ": расхождения в «Итого»");
    console.log("  ✓ " + xf + ": строк " + rowsMatched + ", ячеек " + cells +
      (sawTotal ? ", «Итого» сверено" : ", «Итого» в эталоне нет"));
  }
}

// ---------------- 7. валидность .xlsx-отчёта ----------------
// Библиотека записи берётся та же, что подключает страница (script src из
// index.html) — сьют проверяет производственный путь и не меняется при
// замене библиотеки. Валидаторы независимы: свой распаковщик zip с проверкой
// CRC, python (zipfile + xml.etree), обратное чтение полным SheetJS.
head("xlsx: отчёт — валидный файл с теми же данными");
{
  const pageSrc = readFileSync(join(ROOT, "index.html"), "utf8");
  const libRel = (pageSrc.match(/<script src="(xlsx[^"]+)"><\/script>/) || [])[1];
  ok(!!libRel, "страница подключает библиотеку xlsx (" + libRel + ")");
  const LIB = require(join(ROOT, libRel));
  const DEV = require(join(DIR, "xlsx.full.dev.js"));

  // ---- вспомогательные: CRC32 и распаковка zip с полной сверкой структуры
  const CRC_T = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++){
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc32 = b => {
    let c = -1;
    for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  function unzip(buf){ // Map имя → содержимое; бросает при любом нарушении формата
    const zlib = require("zlib");
    let e = buf.length - 22;
    while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
    if (e < 0) throw new Error("нет EOCD — это не zip");
    const n = buf.readUInt16LE(e + 10);
    let off = buf.readUInt32LE(e + 16);
    const out = new Map();
    for (let i = 0; i < n; i++){
      if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("битая центральная директория");
      const meth = buf.readUInt16LE(off + 10), crc = buf.readUInt32LE(off + 16),
            cs = buf.readUInt32LE(off + 20), us = buf.readUInt32LE(off + 24),
            nl = buf.readUInt16LE(off + 28), el = buf.readUInt16LE(off + 30),
            cl = buf.readUInt16LE(off + 32), lho = buf.readUInt32LE(off + 42);
      const name = buf.toString("utf8", off + 46, off + 46 + nl);
      if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error(name + ": битый локальный заголовок");
      const lnl = buf.readUInt16LE(lho + 26), lel = buf.readUInt16LE(lho + 28);
      const raw = buf.subarray(lho + 30 + lnl + lel, lho + 30 + lnl + lel + cs);
      const data = meth === 8 ? zlib.inflateRawSync(raw)
                 : meth === 0 ? Buffer.from(raw)
                 : (() => { throw new Error(name + ": неизвестный метод " + meth); })();
      if (data.length !== us) throw new Error(name + ": размер не сходится");
      if (crc32(data) !== crc) throw new Error(name + ": CRC не сходится");
      out.set(name, data);
      off += 46 + nl + el + cl;
    }
    return out;
  }
  const colName = i => { let s = ""; i++; while (i){ s = String.fromCharCode(65 + (i - 1) % 26) + s; i = Math.floor((i - 1) / 26); } return s; };
  const deEnt = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&amp;/g, "&");
  function readCells(zip, sheetPath){ // Map "A1" → число|строка (t: s/str/inlineStr/число)
    const xml = zip.get(sheetPath).toString();
    const sstXml = zip.get("xl/sharedStrings.xml");
    const sst = [];
    if (sstXml)
      for (const m of sstXml.toString().matchAll(/<si>(?:<t[^>]*>([\s\S]*?)<\/t>|[\s\S]*?)<\/si>/g))
        sst.push(deEnt(m[1] || ""));
    const cells = new Map();
    for (const m of xml.matchAll(/<c r="([A-Z]+\d+)"((?:[^>"]|"[^"]*")*?)(?:\/>|>([\s\S]*?)<\/c>)/g)){
      const [, ref, attrs, body] = m;
      if (body == null) continue;
      const t = (attrs.match(/\bt="(\w+)"/) || [])[1];
      const v = (body.match(/<v[^>]*>([\s\S]*?)<\/v>/) || [])[1];
      const is = (body.match(/<is><t[^>]*>([\s\S]*?)<\/t><\/is>/) || [])[1];
      if (t === "inlineStr" && is != null) cells.set(ref, deEnt(is));
      else if (t === "s" && v != null) cells.set(ref, sst[+v]);
      else if (t === "str" && v != null) cells.set(ref, deEnt(v));
      else if (v != null) cells.set(ref, parseFloat(v));
    }
    return cells;
  }

  // ---- данные: реальный архив, если есть, иначе синтетика
  let arc;
  const privK20 = existsSync(PRIV) && readdirSync(PRIV).filter(f => /\.k20$/i.test(f)).sort();
  if (privK20 && privK20.length)
    arc = C.parseK20(toAB(readFileSync(join(PRIV, privK20[privK20.length - 1]))));
  else {
    const names = ["Дата", "Er0", "Наработка H0", "V1ѕ", "V1ј", "dV1", "T1ѕ", "T1ј", "dT1", "Q1ѕ"];
    const rows = [];
    for (let d = 1; d <= 30; d++)
      rows.push([tdt(2026, 6, d), d === 5 ? erBits(1) : 0, 24,
        1.3 + d/1000, 1.29, 0.01 + d/10000, 65.66, 41.03, 24.633, 0.0376]);
    arc = C.parseK20(toAB(buildK20({names, count: 30, rows,
      meta: ["ЭЛЬФ", "Посуточный архив. ЭЛЬФ, № 1234567", "1234567"]})));
  }
  const names = arc.names.slice(1);
  const fIso = arc.rows[0].date.toISOString().slice(0, 10);
  const tIso = arc.rows[arc.rows.length - 1].date.toISOString().slice(0, 10);
  // адрес объекта (config.js, только в APK) идёт в заголовок листа, но НЕ в имя
  // файла: при отправке префикс к имени добавляет облачная функция
  const ADDR = "Тестовая_1"; // настоящий адрес лежит в config.js и в git не попадает
  const plain = C.buildAoa(arc.rows, names, arc.meta, fIso, tIso);
  ok(/^отчет данных [а-я]+ [а-я]+ \d{4}$/.test(plain.aoa[0][3]),
     "без адреса заголовок листа прежний: " + plain.aoa[0][3]);
  const {aoa, fname, widths} = C.buildAoa(arc.rows, names, arc.meta, fIso, tIso, ADDR);
  eq(aoa[0][3], "Тестовая 1 " + plain.aoa[0][3], "адрес попал в заголовок листа");
  eq(fname, plain.fname, "имя файла от адреса не зависит");
  ok(/^отчет_данных_[а-я]+_[а-я]+_\d{4}\.xlsx$/.test(fname), "имя файла по шаблону: " + fname);
  eq(aoa.length, arc.rows.length + 4, "строк в отчёте: шапка(3) + данные + Итого");

  // ---- производственный путь: те же вызовы, что на странице
  const ws = LIB.utils.aoa_to_sheet(aoa);
  ws["!cols"] = widths.map(w => ({wch: w}));
  const wb = LIB.utils.book_new();
  LIB.utils.book_append_sheet(wb, ws, "Sheet1");
  const ab = LIB.write(wb, {bookType: "xlsx", type: "array", compression: true});
  ok(ab instanceof ArrayBuffer, "write(type:'array') → ArrayBuffer");
  const buf = Buffer.from(ab);
  ok(buf.length > 1000 && buf.length < 60000, "размер файла разумный: " + buf.length + " байт");
  ok(buf.readUInt32LE(0) === 0x04034b50, "начинается с сигнатуры zip");

  // ---- А: свой распаковщик — структура, CRC, все значения на месте
  let zip = null;
  try { zip = unzip(buf); } catch (e) { ok(false, "распаковка: " + e.message); }
  if (zip){
    for (const m of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels"])
      ok(zip.has(m), "в архиве есть " + m);
    const rels = zip.get("xl/_rels/workbook.xml.rels").toString();
    const target = (rels.match(/Target="([^"]*worksheets\/[^"]+)"/) || [])[1];
    const sheetPath = target && target.replace(/^\//, "").replace(/^(?!xl\/)/, "xl/");
    ok(!!sheetPath && zip.has(sheetPath), "лист по rels найден: " + sheetPath);
    ok(/<sheet [^>]*name="Sheet1"/.test(zip.get("xl/workbook.xml").toString()), "workbook.xml объявляет Sheet1");
    const cells = readCells(zip, sheetPath);
    let checked = 0, bad = 0;
    for (let r = 0; r < aoa.length; r++)
      for (let c = 0; c < (aoa[r] || []).length; c++){
        const want = aoa[r][c];
        if (want == null) continue;
        const got = cells.get(colName(c) + (r + 1));
        checked++;
        const same = typeof want === "number"
          ? got === want
          : got === String(want);
        if (!same){ bad++; if (bad <= 4) console.error(`  ✗ ячейка ${colName(c)}${r + 1}: в файле ${JSON.stringify(got)}, ждали ${JSON.stringify(want)}`); }
      }
    eq(bad, 0, "все значения aoa дошли до файла (" + checked + " ячеек)");
    ok(checked > arc.rows.length * names.length, "ячеек проверено не меньше, чем данных");
  }

  // ---- B: python-валидатор (zipfile + xml.etree; openpyxl — если установлен)
  {
    const tmp = join(tmpdir(), "k20_report_test.xlsx");
    writeFileSync(tmp, buf);
    let res = null;
    try {
      res = JSON.parse(execFileSync("python3", [join(DIR, "xlsx_check.py"), tmp],
        {maxBuffer: 1 << 24}).toString());
    } catch (e) {
      console.log("  python3 недоступен — валидатор B пропущен");
    }
    if (res){
      ok(res.ok, "python: zip цел, весь XML корректен (" + res.members + " членов)" +
        (res.error ? " — " + res.error : ""));
      if (res.openpyxl != null)
        eq(res.openpyxl, aoa.filter(r => r && r.length).length, "openpyxl: строк прочитано");
      else console.log("  openpyxl не установлен — глубокое чтение пропущено");
    }
  }

  // ---- C: полный SheetJS читает файл и видит те же данные
  {
    const wb2 = DEV.read(buf, {type: "buffer"});
    const back = DEV.utils.sheet_to_json(wb2.Sheets[wb2.SheetNames[0]], {header: 1, raw: true});
    let bad = 0, checked = 0;
    for (let r = 0; r < aoa.length; r++)
      for (let c = 0; c < (aoa[r] || []).length; c++){
        const want = aoa[r][c];
        if (want == null) continue;
        checked++;
        const got = back[r] && back[r][c];
        if (!(typeof want === "number" ? got === want : got === String(want))){
          bad++;
          if (bad <= 4) console.error(`  ✗ SheetJS-чтение [${r}][${c}]: ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);
        }
      }
    eq(bad, 0, "обратное чтение полным SheetJS без потерь (" + checked + " ячеек)");
  }

  // ---- ветка APK: write(type:'base64') даёт тот же валидный файл
  {
    const b64 = LIB.write(wb, {bookType: "xlsx", type: "base64", compression: true});
    ok(typeof b64 === "string" && /^[A-Za-z0-9+/=]+$/.test(b64), "base64-строка корректна");
    let z2 = null;
    try { z2 = unzip(Buffer.from(b64, "base64")); } catch (e) { ok(false, "base64-распаковка: " + e.message); }
    if (z2) ok(z2.has("xl/workbook.xml"), "base64-ветка (APK) — тот же валидный xlsx");
  }
}

// ---------------- итог ----------------
console.log("\n" + "-".repeat(50));
console.log("пройдено: " + passed + ", провалено: " + failed);
if (failed) process.exit(1);
