package ru.karat.k20viewer

import java.io.ByteArrayOutputStream
import java.math.BigDecimal
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * Минимальный писатель .xlsx — порт xlsx.write.js (один лист из массива строк,
 * инлайновые строки t="str", ширины колонок). Zip — java.util.zip.
 */
object Xlsx {
    private const val XMLH = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"

    private const val CONTENT_TYPES = XMLH +
        "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">" +
        "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>" +
        "<Default Extension=\"xml\" ContentType=\"application/xml\"/>" +
        "<Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>" +
        "<Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>" +
        "<Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/>" +
        "<Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/>" +
        "<Override PartName=\"/docProps/app.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.extended-properties+xml\"/>" +
        "</Types>"

    private const val ROOT_RELS = XMLH +
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">" +
        "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/>" +
        "<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/>" +
        "<Relationship Id=\"rId3\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties\" Target=\"docProps/app.xml\"/>" +
        "</Relationships>"

    private const val WB_RELS = XMLH +
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">" +
        "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/>" +
        "<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/>" +
        "</Relationships>"

    private const val STYLES = XMLH +
        "<styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">" +
        "<fonts count=\"1\"><font><sz val=\"11\"/><name val=\"Calibri\"/></font></fonts>" +
        "<fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill>" +
        "<fill><patternFill patternType=\"gray125\"/></fill></fills>" +
        "<borders count=\"1\"><border/></borders>" +
        "<cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs>" +
        "<cellXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/></cellXfs>" +
        "<cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles>" +
        "</styleSheet>"

    private const val APP = XMLH +
        "<Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\">" +
        "<Application>K20Viewer</Application></Properties>"

    private fun esc(s: String) = s
        .replace("&", "&amp;").replace("<", "&lt;")
        .replace(">", "&gt;").replace("\"", "&quot;")

    fun colName(i0: Int): String {
        var i = i0 + 1
        var s = ""
        while (i > 0) {
            s = ('A' + (i - 1) % 26) + s
            i = (i - 1) / 26
        }
        return s
    }

    private fun coreXml(): String {
        val d = Instant.now().truncatedTo(ChronoUnit.SECONDS).toString()
        return XMLH +
            "<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\"" +
            " xmlns:dcterms=\"http://purl.org/dc/terms/\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">" +
            "<dcterms:created xsi:type=\"dcterms:W3CDTF\">$d</dcterms:created>" +
            "<dcterms:modified xsi:type=\"dcterms:W3CDTF\">$d</dcterms:modified>" +
            "</cp:coreProperties>"
    }

    private fun workbookXml(name: String) = XMLH +
        "<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"" +
        " xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\">" +
        "<sheets><sheet name=\"${esc(name)}\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>"

    /** Ширина колонки как в xlsx.write.js: Math.round((wch+0.83203125)*256)/256. */
    private fun widthStr(wch: Double): String {
        val rounded = Math.round((wch + 0.83203125) * 256)
        return Round.jsNum(BigDecimal.valueOf(rounded).divide(BigDecimal.valueOf(256)))
    }

    private fun sheetXml(aoa: List<List<Cell?>>, widths: List<Double>): String {
        var cols = 0
        for (row in aoa) if (row.size > cols) cols = row.size
        val sb = StringBuilder(XMLH)
        sb.append("<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">")
        sb.append("<dimension ref=\"A1:")
            .append(if (aoa.isNotEmpty()) colName(maxOf(cols - 1, 0)) + aoa.size else "A1").append("\"/>")
        if (widths.isNotEmpty()) {
            sb.append("<cols>")
            for ((c, w) in widths.withIndex())
                sb.append("<col min=\"${c + 1}\" max=\"${c + 1}\" width=\"${widthStr(w)}\" customWidth=\"1\"/>")
            sb.append("</cols>")
        }
        sb.append("<sheetData>")
        for ((r, row) in aoa.withIndex()) {
            if (row.isEmpty()) continue
            sb.append("<row r=\"${r + 1}\">")
            for ((c, v) in row.withIndex()) {
                if (v == null) continue
                val ref = colName(c) + (r + 1)
                when (v) {
                    is Cell.Num -> sb.append("<c r=\"$ref\"><v>${Round.jsNum(v.n)}</v></c>")
                    is Cell.Str -> {
                        val s = v.s
                        val preserve = s.isNotEmpty() && (s.first().isWhitespace() || s.last().isWhitespace())
                        sb.append("<c r=\"$ref\" t=\"str\"><v")
                        if (preserve) sb.append(" xml:space=\"preserve\"")
                        sb.append(">").append(esc(s)).append("</v></c>")
                    }
                }
            }
            sb.append("</row>")
        }
        sb.append("</sheetData></worksheet>")
        return sb.toString()
    }

    /** Книга целиком, как байты .xlsx. */
    fun write(report: Report): ByteArray {
        val members = listOf(
            "[Content_Types].xml" to CONTENT_TYPES,
            "_rels/.rels" to ROOT_RELS,
            "xl/workbook.xml" to workbookXml("Sheet1"),
            "xl/_rels/workbook.xml.rels" to WB_RELS,
            "xl/worksheets/sheet1.xml" to sheetXml(report.aoa, report.widths),
            "xl/styles.xml" to STYLES,
            "docProps/core.xml" to coreXml(),
            "docProps/app.xml" to APP,
        )
        val bos = ByteArrayOutputStream()
        ZipOutputStream(bos).use { zip ->
            zip.setLevel(6)
            for ((name, content) in members) {
                zip.putNextEntry(ZipEntry(name))
                zip.write(content.toByteArray(Charsets.UTF_8))
                zip.closeEntry()
            }
        }
        return bos.toByteArray()
    }
}
