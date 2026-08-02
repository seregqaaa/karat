// Строит отчёт .xlsx текущим JS-ядром (index.html + xlsx.write.js) — арбитр
// для поячеечного сравнения с Kotlin-портом.
// Использование: node js_build.mjs <in.k20> <fromIso> <toIso> <outDir>
import {readFileSync, writeFileSync} from "fs";
import {createRequire} from "module";
import {dirname, join} from "path";
import {fileURLToPath} from "url";

const require = createRequire(import.meta.url);
// веб-версия лежит в корне репозитория: index.html + xlsx.write.js
const UP = process.env.K20_WEB || join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = readFileSync(join(UP, "index.html"), "utf8");
const m = src.match(/\/\/ ====== K20CORE-BEGIN ======([\s\S]*?)\/\/ ====== K20CORE-END ======/);
const C = new Function(m[1] + `
  return {parseK20, buildAoa, fmtD, iso, rep, total, isFlagCol, chainRound};`)();
const XLSX = require(join(UP, "xlsx.write.js"));

const [, , k20, fromIso, toIso, outDir] = process.argv;
const buf = readFileSync(k20);
const arc = C.parseK20(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const rows = arc.rows.filter(r => {
  const d = C.iso(r.date);
  return d >= fromIso && d <= toIso;
});
const {aoa, fname, widths} = C.buildAoa(rows, arc.names.slice(1), arc.meta, fromIso, toIso);
const ws = XLSX.utils.aoa_to_sheet(aoa);
ws["!cols"] = widths.map(w => ({wch: w}));
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
writeFileSync(join(outDir, "js_" + fname), XLSX.write(wb, {bookType: "xlsx", type: "buffer", compression: true}));
console.log(fname);
