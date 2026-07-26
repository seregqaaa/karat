/*! xlsx.write.js — минимальная замена SheetJS для «ЛУЧ-МК: показания в 1 клик».
 * Из всей библиотеки проекту нужна только запись .xlsx (один лист из массива
 * строк), поэтому здесь реализован лишь используемый страницей сабсет API:
 *   XLSX.utils.aoa_to_sheet / book_new / book_append_sheet
 *   XLSX.write(wb, {bookType:"xlsx", type:"array"|"base64"|"buffer", compression})
 *   XLSX.writeFile(wb, fname, {compression})
 * Отличие от SheetJS: в браузере write()/writeFile() возвращают Promise
 * (сжатие через CompressionStream); в node — синхронны (zlib), поэтому тесты
 * зовут их как обычные функции. Если CompressionStream недоступен, файл
 * пишется без сжатия (STORED) — это тоже валидный xlsx, просто крупнее.
 */
(function(root, factory){
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.XLSX = factory();
})(typeof self !== "undefined" ? self : this, function(){
  "use strict";
  var IS_NODE = typeof process !== "undefined" && process.versions && process.versions.node;

  // ---------- утилиты ----------
  function esc(s){
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function colName(i){ // 0 → A, 26 → AA
    var s = ""; i++;
    while (i){ s = String.fromCharCode(65 + (i - 1) % 26) + s; i = Math.floor((i - 1) / 26); }
    return s;
  }
  var enc = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
  function utf8(s){ // самодостаточно: без TextEncoder кодируем вручную
    if (enc) return enc.encode(s);
    var out = [], i, c;
    for (i = 0; i < s.length; i++){
      c = s.codePointAt(i);
      if (c > 0xFFFF) i++;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | c >> 6, 0x80 | c & 63);
      else if (c < 0x10000) out.push(0xE0 | c >> 12, 0x80 | (c >> 6) & 63, 0x80 | c & 63);
      else out.push(0xF0 | c >> 18, 0x80 | (c >> 12) & 63, 0x80 | (c >> 6) & 63, 0x80 | c & 63);
    }
    return new Uint8Array(out);
  }

  // ---------- XML-члены пакета ----------
  var XMLH = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  var CONTENT_TYPES = XMLH +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '</Types>';
  var ROOT_RELS = XMLH +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    '</Relationships>';
  var WB_RELS = XMLH +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>';
  // минимальный styles.xml; fills обязаны содержать none и gray125 — Excel строг
  var STYLES = XMLH +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border/></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';
  var APP = XMLH +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
    '<Application>K20Viewer</Application></Properties>';
  function coreXml(){
    var d = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    return XMLH +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
      ' xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      '<dcterms:created xsi:type="dcterms:W3CDTF">' + d + '</dcterms:created>' +
      '<dcterms:modified xsi:type="dcterms:W3CDTF">' + d + '</dcterms:modified>' +
      '</cp:coreProperties>';
  }
  function workbookXml(name){
    return XMLH +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
      ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="' + esc(name) + '" sheetId="1" r:id="rId1"/></sheets></workbook>';
  }
  function sheetXml(ws){
    var aoa = ws["!aoa"] || [];
    var rows = aoa.length, cols = 0, r, c;
    for (r = 0; r < rows; r++) if (aoa[r] && aoa[r].length > cols) cols = aoa[r].length;
    var out = [XMLH,
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
      '<dimension ref="A1:' + (rows ? colName(Math.max(cols - 1, 0)) + rows : "A1") + '"/>'];
    var wcols = ws["!cols"];
    if (wcols && wcols.length){
      out.push("<cols>");
      for (c = 0; c < wcols.length; c++){
        var wch = wcols[c] && wcols[c].wch;
        if (wch == null) continue;
        out.push('<col min="' + (c + 1) + '" max="' + (c + 1) + '" width="' +
          (Math.round((wch + 0.83203125) * 256) / 256) + '" customWidth="1"/>');
      }
      out.push("</cols>");
    }
    out.push("<sheetData>");
    for (r = 0; r < rows; r++){
      var row = aoa[r];
      if (!row || !row.length){ continue; }
      out.push('<row r="' + (r + 1) + '">');
      for (c = 0; c < row.length; c++){
        var v = row[c];
        if (v == null) continue;
        var ref = colName(c) + (r + 1);
        if (typeof v === "number"){
          if (isFinite(v)) out.push('<c r="' + ref + '"><v>' + String(v) + "</v></c>");
        } else if (typeof v === "boolean"){
          out.push('<c r="' + ref + '" t="b"><v>' + (v ? 1 : 0) + "</v></c>");
        } else {
          var s = String(v);
          out.push('<c r="' + ref + '" t="str"><v' +
            (/^\s|\s$/.test(s) ? ' xml:space="preserve"' : "") + ">" + esc(s) + "</v></c>");
        }
      }
      out.push("</row>");
    }
    out.push("</sheetData></worksheet>");
    return out.join("");
  }

  // ---------- zip (STORED / DEFLATE) ----------
  var CRC_T = (function(){
    var t = new Int32Array(256), n, k, cv;
    for (n = 0; n < 256; n++){
      cv = n;
      for (k = 0; k < 8; k++) cv = cv & 1 ? 0xEDB88320 ^ (cv >>> 1) : cv >>> 1;
      t[n] = cv;
    }
    return t;
  })();
  function crc32(b){
    var cv = -1, i;
    for (i = 0; i < b.length; i++) cv = CRC_T[(cv ^ b[i]) & 0xFF] ^ (cv >>> 8);
    return (cv ^ -1) >>> 0;
  }
  function dosTime(d){
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
  }
  function u16(a, p, v){ a[p] = v & 255; a[p + 1] = (v >>> 8) & 255; }
  function u32(a, p, v){ u16(a, p, v & 0xFFFF); u16(a, p + 2, (v >>> 16) & 0xFFFF); }
  // members: [{name, data(Uint8Array), comp(Uint8Array|null)}] — comp=null → STORED
  function buildZip(members){
    var now = dosTime(new Date());
    var i, m, total = 0, cdSize = 0;
    for (i = 0; i < members.length; i++){
      m = members[i];
      m.nameB = utf8(m.name);
      m.crc = crc32(m.data);
      m.store = m.comp == null || m.comp.length >= m.data.length; // сжатие не помогло
      m.out = m.store ? m.data : m.comp;
      total += 30 + m.nameB.length + m.out.length;
      cdSize += 46 + m.nameB.length;
    }
    var buf = new Uint8Array(total + cdSize + 22), p = 0;
    for (i = 0; i < members.length; i++){
      m = members[i]; m.off = p;
      u32(buf, p, 0x04034b50); u16(buf, p + 4, 20); u16(buf, p + 6, 0x0800);
      u16(buf, p + 8, m.store ? 0 : 8); u16(buf, p + 10, now.time); u16(buf, p + 12, now.date);
      u32(buf, p + 14, m.crc); u32(buf, p + 18, m.out.length); u32(buf, p + 22, m.data.length);
      u16(buf, p + 26, m.nameB.length); u16(buf, p + 28, 0);
      buf.set(m.nameB, p + 30); buf.set(m.out, p + 30 + m.nameB.length);
      p += 30 + m.nameB.length + m.out.length;
    }
    var cdOff = p;
    for (i = 0; i < members.length; i++){
      m = members[i];
      u32(buf, p, 0x02014b50); u16(buf, p + 4, 20); u16(buf, p + 6, 20); u16(buf, p + 8, 0x0800);
      u16(buf, p + 10, m.store ? 0 : 8); u16(buf, p + 12, now.time); u16(buf, p + 14, now.date);
      u32(buf, p + 16, m.crc); u32(buf, p + 20, m.out.length); u32(buf, p + 24, m.data.length);
      u16(buf, p + 28, m.nameB.length);
      // extra/comment/disk/attrs — нули
      u32(buf, p + 42, m.off);
      buf.set(m.nameB, p + 46);
      p += 46 + m.nameB.length;
    }
    u32(buf, p, 0x06054b50);
    u16(buf, p + 8, members.length); u16(buf, p + 10, members.length);
    u32(buf, p + 12, cdSize); u32(buf, p + 16, cdOff);
    return buf;
  }
  function deflateNode(data){
    return new Uint8Array(require("zlib").deflateRawSync(data, {level: 6}));
  }
  function deflateBrowser(data){ // Promise<Uint8Array|null>
    try {
      var cs = new CompressionStream("deflate-raw");
    } catch (e) { return Promise.resolve(null); }
    return new Response(new Blob([data]).stream().pipeThrough(cs)).arrayBuffer()
      .then(function(ab){ return new Uint8Array(ab); })
      .catch(function(){ return null; });
  }

  // ---------- сборка книги ----------
  function packMembers(wb){
    if (!wb.SheetNames.length) throw new Error("в книге нет листов");
    var name = wb.SheetNames[0];
    return [
      {name: "[Content_Types].xml", data: utf8(CONTENT_TYPES)},
      {name: "_rels/.rels", data: utf8(ROOT_RELS)},
      {name: "xl/workbook.xml", data: utf8(workbookXml(name))},
      {name: "xl/_rels/workbook.xml.rels", data: utf8(WB_RELS)},
      {name: "xl/worksheets/sheet1.xml", data: utf8(sheetXml(wb.Sheets[name]))},
      {name: "xl/styles.xml", data: utf8(STYLES)},
      {name: "docProps/core.xml", data: utf8(coreXml())},
      {name: "docProps/app.xml", data: utf8(APP)}
    ];
  }
  function toType(bytes, type){
    if (type === "base64"){
      if (IS_NODE) return Buffer.from(bytes).toString("base64");
      var s = "", i, CH = 0x8000;
      for (i = 0; i < bytes.length; i += CH)
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
      return btoa(s);
    }
    if (type === "buffer") return IS_NODE ? Buffer.from(bytes) : bytes;
    // "array" — как у SheetJS: ArrayBuffer
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  function write(wb, opts){
    opts = opts || {};
    if (opts.bookType && opts.bookType !== "xlsx")
      throw new Error("поддерживается только bookType:'xlsx'");
    var members = packMembers(wb);
    var wantComp = opts.compression !== false;
    if (IS_NODE){
      members.forEach(function(m){ m.comp = wantComp ? deflateNode(m.data) : null; });
      return toType(buildZip(members), opts.type);
    }
    var jobs = members.map(function(m){
      return (wantComp ? deflateBrowser(m.data) : Promise.resolve(null))
        .then(function(cmp){ m.comp = cmp; });
    });
    return Promise.all(jobs).then(function(){
      return toType(buildZip(members), opts.type);
    });
  }
  function writeFile(wb, fname, opts){
    opts = opts || {};
    if (IS_NODE){
      var bytes = write(wb, {bookType: "xlsx", type: "buffer", compression: opts.compression});
      require("fs").writeFileSync(fname, bytes);
      return fname;
    }
    return Promise.resolve(write(wb, {bookType: "xlsx", type: "array", compression: opts.compression}))
      .then(function(ab){
        var a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([ab],
          {type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}));
        a.download = fname;
        a.click();
        setTimeout(function(){ URL.revokeObjectURL(a.href); }, 10000);
        return fname;
      });
  }

  return {
    version: "write-only-1.0",
    utils: {
      aoa_to_sheet: function(aoa){ return {"!aoa": aoa}; },
      book_new: function(){ return {SheetNames: [], Sheets: {}}; },
      book_append_sheet: function(wb, ws, name){
        name = name || "Sheet" + (wb.SheetNames.length + 1);
        wb.SheetNames.push(name);
        wb.Sheets[name] = ws;
      }
    },
    write: write,
    writeFile: writeFile
  };
});
