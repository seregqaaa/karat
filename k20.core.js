/*! k20.core.js — ядро «ЛУЧ-МК: показания в 1 клик».
 *
 * Чистая логика без DOM: разбор двоичного архива .K20, округление «как в
 * КАРАТ-Экспресс» и сборка строк Excel-отчёта. Один и тот же файл исполняют
 * страница (обычный <script src>) и тесты (require из node) — отдельной сборки
 * у проекта нет.
 *
 * ВНЕШНИЙ КОНТРАКТ. В браузере все имена из возвращаемого объекта кладутся
 * прямо в window: так страница зовёт их без префикса, а слой сборки APK
 * (apk_bridge.js — он живёт в конвейере сборки, а не в репозитории) может
 * подменить window.buildAoa своей обёрткой, и вызовы из index.html после
 * подмены пойдут уже в неё. Поэтому:
 *   • не заворачивать ядро в модуль ES и не переводить страницу на type="module";
 *   • не переименовывать экспортируемые имена и не убирать их из return.
 */
(function (root, factory){
  if (typeof module === "object" && module.exports) module.exports = factory();
  else Object.assign(root, factory());
})(typeof self !== "undefined" ? self : this, function (){
  "use strict";

  // Версия страницы: попадает в диагностический файл, который пользователь
  // присылает при проблемах с разбором. Поднимать ОДНОВРЕМЕННО с CACHE в sw.js —
  // иначе по диагностике не понять, какая сборка её сформировала.
  const K20_VER = "24";

  const DELPHI_EPOCH = Date.UTC(1899, 11, 30);
  const DAY_MS = 86400000;
  const GLYPHS = {"ѕ": "под", "ј": "обр"}; // cp1251 0xBE, 0xBC
  const ER_FLAGS = {1: "Bat"};
  // Пределы правдоподобия: защищают от мусора вместо архива. Самые большие
  // известные архивы — почасовой ЭЛЬФ (960 записей); запись ≤ 29 параметров.
  const NAMES_OFF = 0x39, NAME_MAX = 0x20, MAX_COLS = 40, MAX_RECS = 20000;
  const DATE_MIN = Date.UTC(1995, 0, 1), DATE_MAX = Date.UTC(2100, 0, 1);
  // Корректный архив не больше MAX_COLS*MAX_RECS*8 ≈ 6,4 МБ; всё, что сильно
  // крупнее, читать в память незачем — страница отказывается до чтения файла.
  const MAX_FILE_BYTES = 32 * 1024 * 1024;

  class K20Error extends Error {
    constructor(message){ super(message); this.name = "K20Error"; }
  }
  const bad = msg => { throw new K20Error(msg); };

  // ------------------------------------------------------------------ колонки --
  // Классы колонок — по схеме обозначений КАРАТ (первая буква: Q тепло,
  // G масса, V объём, T температура, P давление, C электроэнергия; приставка
  // d — разность), чтобы многоканальные приборы (T2под, dV2, G1под) попадали
  // в те же правила, что и канал 1 у ЭЛЬФ.
  const isFlagCol = n => /^Er\d*$/.test(n);
  const isDateCol = n => /^(Дата|Время|Date|Time)/i.test(n);
  const isT = n => /^d?[Tt]/.test(n);
  const isV = n => /^d?[VG]/.test(n);
  const decFor = n => isV(n) ? 1 : 2;

  // ------------------------------------------------------------------- разбор --
  function readShortStrings(bytes, pos, maxLen, maxCount){
    const dec = new TextDecoder("windows-1251"), out = [];
    while (pos < bytes.length && out.length < (maxCount || 1000)){
      const ln = bytes[pos];
      if (ln === 0 || ln > maxLen || pos + 1 + ln > bytes.length) break;
      out.push(dec.decode(bytes.subarray(pos + 1, pos + 1 + ln)));
      pos += 1 + ln;
    }
    return [out, pos];
  }

  function decodeEr0(v){
    if (!isFinite(v)) return "";
    const b = new DataView(new ArrayBuffer(4));
    b.setFloat32(0, v, true);
    const bits = b.getUint32(0, true);
    if (!bits) return "";
    const parts = [];
    for (let i = 0; i < 32; i++)
      if (bits & (1 << i)) parts.push(ER_FLAGS[2 ** i] || ("Er" + i));
    return parts.join(";") + ";";
  }

  function parseK20(buf){
    if (!buf || buf.byteLength < NAMES_OFF + 16) bad("файл слишком короткий для архива .K20");
    const dv = new DataView(buf), bytes = new Uint8Array(buf);
    const count = dv.getUint16(2, true);
    if (count < 1 || count > MAX_RECS) bad("неправдоподобное число записей в заголовке: " + count);
    const [rawNames, pos] = readShortStrings(bytes, NAMES_OFF, NAME_MAX, MAX_COLS + 1);
    const names = rawNames.map(n => n.replace(/[ѕј]/g, c => GLYPHS[c]));
    const C = names.length;
    if (C < 2) bad("не найдены имена колонок — это не архив пульта ЛУЧ-МК");
    if (C > MAX_COLS) bad("неправдоподобное число колонок: " + C);
    if (!isDateCol(names[0]))
      bad("первая колонка «" + names[0] + "» — не дата; структура файла не распознана");
    // Значения строки лежат в объекте по имени колонки, поэтому повтор имени
    // молча затирал бы данные соседней колонки — лучше честный отказ.
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup !== undefined) bad("в архиве повторяется имя колонки «" + dup + "»");
    if (pos + C * count * 8 > bytes.length)
      bad("файл обрезан: данных " + (bytes.length - pos) + " байт вместо " + C * count * 8);
    const cols = [];
    for (let c = 0; c < C; c++){
      const col = new Float64Array(count);
      for (let i = 0; i < count; i++) col[i] = dv.getFloat64(pos + (c * count + i) * 8, true);
      cols.push(col);
    }
    // Хвост: 128 служебных байт, затем ShortString-метаданные (прибор, архив,
    // номер). Нестандартный хвост — не повод падать: работаем без метаданных.
    const [metaStr] = readShortStrings(bytes, pos + C * count * 8 + 128, 255, 8);
    const rows = [];
    let skipped = 0;
    for (let i = 0; i < count; i++){
      const t = DELPHI_EPOCH + cols[0][i] * DAY_MS;
      if (!isFinite(t) || t < DATE_MIN || t > DATE_MAX){ skipped++; continue; }
      // Object.create(null): имя колонки приходит из файла и может оказаться
      // «__proto__» — в обычном литерале такое присваивание молча теряется.
      const r = {date: new Date(t), vals: Object.create(null)};
      for (let c = 1; c < C; c++){
        const v = cols[c][i];
        r.vals[names[c]] = isFlagCol(names[c]) ? decodeEr0(v) : (isFinite(v) ? v : null);
      }
      rows.push(r);
    }
    if (!rows.length) bad("в архиве нет ни одной записи с корректной датой");
    // кольцевой буфер прибора может быть выгружен «с середины» — упорядочиваем
    rows.sort((a, b) => a.date - b.date);
    return {names, rows,
      meta: {device: metaStr[0] || "", archive: metaStr[1] || "", serial: metaStr[2] || ""},
      diag: {records: count, columns: C, skipped, bytes: bytes.length}};
  }

  // --------------------------------------------------------------------- даты --
  const pad2 = n => String(n).padStart(2, "0");
  const fmtD = d => pad2(d.getUTCDate()) + "." + pad2(d.getUTCMonth() + 1) + "." + d.getUTCFullYear();
  const iso = d => d.toISOString().slice(0, 10);
  // "2026-06-24" → Date (UTC) либо null: поле input[type=date] бывает пустым,
  // а значение из localStorage — вообще любым.
  const isoToDate = s => {
    if (!s) return null;
    const t = Date.parse(s + "T00:00:00Z");
    return isNaN(t) ? null : new Date(t);
  };
  const shiftDays = (d, days) => new Date(d.getTime() + days * DAY_MS);
  // Тот же день месяцем раньше. Date.UTC переполняет короткий месяц (31 марта
  // → 3 марта), и «за последний месяц» молча терял первые сутки периода —
  // поэтому переполнение прижимаем к последнему дню короткого месяца.
  function monthEarlier(d){
    const y = d.getUTCFullYear(), m = d.getUTCMonth();
    const out = new Date(Date.UTC(y, m - 1, d.getUTCDate()));
    return out.getUTCMonth() === (m + 11) % 12 ? out : new Date(Date.UTC(y, m, 0));
  }

  // --------------------------------------------------------------- округление --
  // Точность как в отчёте «КАРАТ-Экспресс» (сверено по эталонным Excel-отчётам
  // программы; tests/run.mjs повторяет сверку автоматически).
  // Каскад half-up: сначала до viewDec знаков (как на экране программы), затем
  // до repDec (как в отчёте). Целочисленно, по десятичной записи числа — без
  // toFixed: тот делает round-half-to-even и ловит двоичную погрешность
  // ((1.005).toFixed(2) → "1.00", (0.755).toFixed(2) → "0.75").
  function halfUpScaled(av, dec){
    let s = av.toString();
    if (s.indexOf("e") >= 0) s = av.toFixed(dec + 2); // редкость: |v| < 1e-6
    const dot = s.indexOf(".");
    const ip = dot < 0 ? s : s.slice(0, dot);
    const fp = (dot < 0 ? "" : s.slice(dot + 1)).padEnd(dec + 1, "0");
    let n = BigInt(ip + fp.slice(0, dec));
    if (fp.charCodeAt(dec) >= 53) n += 1n; // следующий знак '5'…'9' — вверх
    return n;
  }
  function chainRound(v, viewDec, repDec){
    if (v == null || !isFinite(v) || Math.abs(v) >= 1e15) return v;
    const neg = v < 0 ? -1 : 1;
    let n = halfUpScaled(Math.abs(v), viewDec);
    const m = BigInt(Math.pow(10, viewDec - repDec));
    const r = n % m;
    n /= m;
    if (r * 2n >= m) n += 1n;
    return neg * Number(n) / Math.pow(10, repDec);
  }
  function rep(name, v){
    if (v == null) return v;
    if (isT(name)) return chainRound(v, 3, 2);
    if (isV(name)) return chainRound(v, 5, 1);
    return chainRound(v, 5, 2);
  }
  const fmtN = (v, name) => v == null ? "—" : (Object.is(v, -0) ? 0 : v).toLocaleString("ru-RU",
    {minimumFractionDigits: 0, maximumFractionDigits: decFor(name)});
  // Итог как в оригинальном отчёте: сумма построчно округлённых значений
  function total(rows, n){
    const f = Math.pow(10, decFor(n));
    return rows.reduce((a, r) => {
      const v = rep(n, r.vals[n]);
      return a + (v == null ? 0 : Math.round(v * f));
    }, 0) / f;
  }

  // -------------------------------------------------------------------- отчёт --
  const capFirst = s => s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;
  const RU_MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь",
                     "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
  // Тип архива из метаданных прибора («Посуточный архив. ЭЛЬФ, № 123» → «Посуточный
  // архив»). Одно правило и на плашку в интерфейсе, и на шапку листа отчёта.
  const archiveTitle = meta => String((meta && meta.archive) || "").split(".")[0].trim()
    || "Посуточный архив";
  // Наши имена колонок → имена в выгрузке «КАРАТ-Экспресс». Тесты строят из
  // этой же карты обратную — держим её в одном месте.
  const HEADER_MAP = {"Er0": "Причина ненаработки", "Наработка H0": "Наработка", "dV1": "Vo"};
  // Ширины сверены с выгрузкой КАРАТ-Экспресс; лишним колонкам — по 12.
  const REPORT_WIDTHS = [16.63, 22.5, 17, 13.5, 13.63, 11.5, 13.5, 8.43, 11.63, 13.75];

  // Содержимое отчёта в формате выгрузки оригинальной программы: строки листа
  // (aoa), имя файла и ширины колонок. Чистая функция — тесты сверяют её выход
  // с эталонными выгрузками «КАРАТ-Экспресс». names — колонки без «Дата».
  // fIso/tIso могут прийти пустыми (пользователь очистил поле даты) — тогда
  // период берётся по самим строкам, иначе в имя файла попадало бы «undefined».
  function buildAoa(rows, names, meta, fIso, tIso){
    const first = rows.length ? rows[0].date : null;
    const last = rows.length ? rows[rows.length - 1].date : null;
    const fd = isoToDate(fIso) || first || isoToDate(tIso) || new Date();
    const td = isoToDate(tIso) || last || fd;
    const base = "отчет_данных_" + RU_MONTHS[fd.getUTCMonth()] + "_" +
                 RU_MONTHS[td.getUTCMonth()] + "_" + td.getUTCFullYear();
    const title = base.replace(/_/g, " ");
    const aoa = [
      ["Архив прибора:" + capFirst(meta.device) + " (" + meta.serial + ")." + archiveTitle(meta),
       null, null, title],
      meta.serial ? [(meta.device || "прибор").toUpperCase() + " № " + meta.serial] : [],
      ["Дата", ...names.map(n => HEADER_MAP[n] || n)],
    ];
    for (const r of rows){
      aoa.push([fmtD(r.date) + " 0:00:00", ...names.map(n => {
        const v = r.vals[n];
        if (typeof v === "string") return v ? " " + v : "Ok";
        return rep(n, v);
      })]);
    }
    if (rows.length)
      aoa.push(["Итого", ...names.map(n => isFlagCol(n) ? null : total(rows, n))]);
    const widths = REPORT_WIDTHS.slice(0, names.length + 1);
    while (widths.length < names.length + 1) widths.push(12);
    return {aoa, fname: base + ".xlsx", widths};
  }

  return {
    K20_VER, K20Error, DAY_MS, MAX_FILE_BYTES, NAME_MAX, MAX_COLS, MAX_RECS,
    isFlagCol, isDateCol, isT, isV, decFor,
    readShortStrings, decodeEr0, parseK20,
    fmtD, iso, isoToDate, shiftDays, monthEarlier,
    halfUpScaled, chainRound, rep, fmtN, total,
    capFirst, archiveTitle, HEADER_MAP, RU_MONTHS, buildAoa,
  };
});
