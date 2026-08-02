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
  // Управляющие символы XML 1.0 не допускает вообще — даже числовой ссылкой,
  // поэтому OOXML кодирует их как _xHHHH_ (так же делает SheetJS). Сюда они
  // попадают из .K20: имена колонок и метаданные прибора читаются как есть.
  // CR отдельно: конформный парсер молча превратил бы литеральный \r в \n.
  var BAD_XML = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g;
  function escChar(c){
    return "_x" + ("000" + c.charCodeAt(0).toString(16)).slice(-4) + "_";
  }
  function esc(s){
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
      .replace(/\r/g, "_x000D_").replace(BAD_XML, escChar);
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
    '<Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
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
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>' +
    '</Relationships>';
  // Стандартная тема Office — та же, что кладут Excel, SheetJS и openpyxl. Сам
  // формат её не требует, но мобильные просмотрщики (Gmail/Google Таблицы на
  // телефоне) на пакете без темы отказываются открывать файл, тогда как Excel на
  // компьютере молча подставляет свою. Из-за этого отчёты и перестали
  // открываться с телефона после перехода с SheetJS.
  var THEME = XMLH +
    '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme">' +
    '<a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/>' +
    '</a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F497D"/>' +
    '</a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2><a:accent1><a:srgbClr val="4F81BD"/></a:accent1>' +
    '<a:accent2><a:srgbClr val="C0504D"/></a:accent2><a:accent3><a:srgbClr val="9BBB59"/></a:accent3>' +
    '<a:accent4><a:srgbClr val="8064A2"/></a:accent4><a:accent5><a:srgbClr val="4BACC6"/></a:accent5>' +
    '<a:accent6><a:srgbClr val="F79646"/></a:accent6><a:hlink><a:srgbClr val="0000FF"/></a:hlink>' +
    '<a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme><a:fontScheme name="Office">' +
    '<a:majorFont><a:latin typeface="Cambria"/><a:ea typeface=""/><a:cs typeface=""/>' +
    '<a:font script="Jpan" typeface="ＭＳ Ｐゴシック"/><a:font script="Hang" typeface="맑은 고딕"/>' +
    '<a:font script="Hans" typeface="宋体"/><a:font script="Hant" typeface="新細明體"/>' +
    '<a:font script="Arab" typeface="Times New Roman"/><a:font script="Hebr" typeface="Times New Roman"/>' +
    '<a:font script="Thai" typeface="Tahoma"/><a:font script="Ethi" typeface="Nyala"/>' +
    '<a:font script="Beng" typeface="Vrinda"/><a:font script="Gujr" typeface="Shruti"/>' +
    '<a:font script="Khmr" typeface="MoolBoran"/><a:font script="Knda" typeface="Tunga"/>' +
    '<a:font script="Guru" typeface="Raavi"/><a:font script="Cans" typeface="Euphemia"/>' +
    '<a:font script="Cher" typeface="Plantagenet Cherokee"/>' +
    '<a:font script="Yiii" typeface="Microsoft Yi Baiti"/>' +
    '<a:font script="Tibt" typeface="Microsoft Himalaya"/><a:font script="Thaa" typeface="MV Boli"/>' +
    '<a:font script="Deva" typeface="Mangal"/><a:font script="Telu" typeface="Gautami"/>' +
    '<a:font script="Taml" typeface="Latha"/><a:font script="Syrc" typeface="Estrangelo Edessa"/>' +
    '<a:font script="Orya" typeface="Kalinga"/><a:font script="Mlym" typeface="Kartika"/>' +
    '<a:font script="Laoo" typeface="DokChampa"/><a:font script="Sinh" typeface="Iskoola Pota"/>' +
    '<a:font script="Mong" typeface="Mongolian Baiti"/><a:font script="Viet" typeface="Times New Roman"/>' +
    '<a:font script="Uigh" typeface="Microsoft Uighur"/><a:font script="Geor" typeface="Sylfaen"/>' +
    '</a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/>' +
    '<a:font script="Jpan" typeface="ＭＳ Ｐゴシック"/><a:font script="Hang" typeface="맑은 고딕"/>' +
    '<a:font script="Hans" typeface="宋体"/><a:font script="Hant" typeface="新細明體"/>' +
    '<a:font script="Arab" typeface="Arial"/><a:font script="Hebr" typeface="Arial"/>' +
    '<a:font script="Thai" typeface="Tahoma"/><a:font script="Ethi" typeface="Nyala"/>' +
    '<a:font script="Beng" typeface="Vrinda"/><a:font script="Gujr" typeface="Shruti"/>' +
    '<a:font script="Khmr" typeface="DaunPenh"/><a:font script="Knda" typeface="Tunga"/>' +
    '<a:font script="Guru" typeface="Raavi"/><a:font script="Cans" typeface="Euphemia"/>' +
    '<a:font script="Cher" typeface="Plantagenet Cherokee"/>' +
    '<a:font script="Yiii" typeface="Microsoft Yi Baiti"/>' +
    '<a:font script="Tibt" typeface="Microsoft Himalaya"/><a:font script="Thaa" typeface="MV Boli"/>' +
    '<a:font script="Deva" typeface="Mangal"/><a:font script="Telu" typeface="Gautami"/>' +
    '<a:font script="Taml" typeface="Latha"/><a:font script="Syrc" typeface="Estrangelo Edessa"/>' +
    '<a:font script="Orya" typeface="Kalinga"/><a:font script="Mlym" typeface="Kartika"/>' +
    '<a:font script="Laoo" typeface="DokChampa"/><a:font script="Sinh" typeface="Iskoola Pota"/>' +
    '<a:font script="Mong" typeface="Mongolian Baiti"/><a:font script="Viet" typeface="Arial"/>' +
    '<a:font script="Uigh" typeface="Microsoft Uighur"/><a:font script="Geor" typeface="Sylfaen"/>' +
    '</a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill>' +
    '<a:schemeClr val="phClr"/></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0">' +
    '<a:schemeClr val="phClr"><a:tint val="50000"/><a:satMod val="300000"/></a:schemeClr></a:gs>' +
    '<a:gs pos="35000"><a:schemeClr val="phClr"><a:tint val="37000"/><a:satMod val="300000"/>' +
    '</a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:tint val="15000"/>' +
    '<a:satMod val="350000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="16200000" scaled="1"/>' +
    '</a:gradFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr">' +
    '<a:tint val="100000"/><a:shade val="100000"/><a:satMod val="130000"/></a:schemeClr></a:gs>' +
    '<a:gs pos="100000"><a:schemeClr val="phClr"><a:tint val="50000"/><a:shade val="100000"/>' +
    '<a:satMod val="350000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="16200000" scaled="0"/>' +
    '</a:gradFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525" cap="flat" cmpd="sng" algn="ctr">' +
    '<a:solidFill><a:schemeClr val="phClr"><a:shade val="95000"/><a:satMod val="105000"/></a:schemeClr>' +
    '</a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="25400" cap="flat" cmpd="sng" algn="ctr">' +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
    '<a:ln w="38100" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/>' +
    '</a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle>' +
    '<a:effectLst><a:outerShdw blurRad="40000" dist="20000" dir="5400000" rotWithShape="0">' +
    '<a:srgbClr val="000000"><a:alpha val="38000"/></a:srgbClr></a:outerShdw></a:effectLst>' +
    '</a:effectStyle><a:effectStyle><a:effectLst>' +
    '<a:outerShdw blurRad="40000" dist="23000" dir="5400000" rotWithShape="0"><a:srgbClr val="000000">' +
    '<a:alpha val="35000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle><a:effectStyle>' +
    '<a:effectLst><a:outerShdw blurRad="40000" dist="23000" dir="5400000" rotWithShape="0">' +
    '<a:srgbClr val="000000"><a:alpha val="35000"/></a:srgbClr></a:outerShdw></a:effectLst><a:scene3d>' +
    '<a:camera prst="orthographicFront"><a:rot lat="0" lon="0" rev="0"/></a:camera>' +
    '<a:lightRig rig="threePt" dir="t"><a:rot lat="0" lon="0" rev="1200000"/></a:lightRig></a:scene3d>' +
    '<a:sp3d><a:bevelT w="63500" h="25400"/></a:sp3d></a:effectStyle></a:effectStyleLst>' +
    '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:gradFill rotWithShape="1">' +
    '<a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="40000"/><a:satMod val="350000"/>' +
    '</a:schemeClr></a:gs><a:gs pos="40000"><a:schemeClr val="phClr"><a:tint val="45000"/>' +
    '<a:shade val="99000"/><a:satMod val="350000"/></a:schemeClr></a:gs><a:gs pos="100000">' +
    '<a:schemeClr val="phClr"><a:shade val="20000"/><a:satMod val="255000"/></a:schemeClr></a:gs>' +
    '</a:gsLst><a:path path="circle"><a:fillToRect l="50000" t="-80000" r="50000" b="180000"/></a:path>' +
    '</a:gradFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr">' +
    '<a:tint val="80000"/><a:satMod val="300000"/></a:schemeClr></a:gs><a:gs pos="100000">' +
    '<a:schemeClr val="phClr"><a:shade val="30000"/><a:satMod val="200000"/></a:schemeClr></a:gs>' +
    '</a:gsLst><a:path path="circle"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path>' +
    '</a:gradFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults><a:spDef><a:spPr/>' +
    '<a:bodyPr/><a:lstStyle/><a:style><a:lnRef idx="1"><a:schemeClr val="accent1"/></a:lnRef>' +
    '<a:fillRef idx="3"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="2">' +
    '<a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/>' +
    '</a:fontRef></a:style></a:spDef><a:lnDef><a:spPr/><a:bodyPr/><a:lstStyle/><a:style><a:lnRef idx="2">' +
    '<a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="0"><a:schemeClr val="accent1"/></a:fillRef>' +
    '<a:effectRef idx="1"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor">' +
    '<a:schemeClr val="tx1"/></a:fontRef></a:style></a:lnDef></a:objectDefaults><a:extraClrSchemeLst/>' +
    '</a:theme>';
  // минимальный styles.xml; fills обязаны содержать none и gray125 — Excel строг
  var STYLES = XMLH +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/>' +
    '<family val="2"/><scheme val="minor"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium9"/>' +
    '</styleSheet>';
  function appXml(name){
    return XMLH +
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"' +
      ' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
      '<Application>K20Viewer</Application>' +
      '<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr>' +
      '</vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant></vt:vector></HeadingPairs>' +
      '<TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>' + esc(name) + '</vt:lpstr>' +
      '</vt:vector></TitlesOfParts></Properties>';
  }
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
      '<workbookPr/>' +
      '<sheets><sheet name="' + esc(name) + '" sheetId="1" r:id="rId1"/></sheets></workbook>';
  }
  function sheetXml(ws){
    var aoa = ws["!aoa"] || [];
    var rows = aoa.length, cols = 0, r, c;
    for (r = 0; r < rows; r++) if (aoa[r] && aoa[r].length > cols) cols = aoa[r].length;
    var out = [XMLH,
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
      '<dimension ref="A1:' + (rows ? colName(Math.max(cols - 1, 0)) + rows : "A1") + '"/>',
      '<sheetViews><sheetView workbookViewId="0"/></sheetViews>'];
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
      {name: "xl/theme/theme1.xml", data: utf8(THEME)},
      {name: "xl/styles.xml", data: utf8(STYLES)},
      {name: "docProps/core.xml", data: utf8(coreXml())},
      {name: "docProps/app.xml", data: utf8(appXml(name))}
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
