package ru.karat.k20viewer

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

/**
 * Парсер посуточных архивов .K20 пульта ЛУЧ-МК.
 * Порт K20CORE из index.html (K20_VER 11) — поведение и сообщения 1:1,
 * сверяется golden-снапшотами из tests/private/golden (в Kotlin блочные
 * комментарии вложенные, поэтому без масок путей здесь).
 */
class K20Exception(message: String) : Exception(message)

class K20Row(val dateMs: Long, val vals: LinkedHashMap<String, Any?>) {
    val date: LocalDate get() = Instant.ofEpochMilli(dateMs).atZone(ZoneOffset.UTC).toLocalDate()
}

class K20Meta(val device: String, val archive: String, val serial: String)

class K20Diag(val records: Int, val columns: Int, val skipped: Int, val bytes: Int)

class K20Archive(
    val names: List<String>,
    val rows: List<K20Row>,
    val meta: K20Meta,
    val diag: K20Diag,
)

object K20 {
    const val VER = "11"
    const val DELPHI_EPOCH = -2209161600000L // Date.UTC(1899,11,30)
    const val DAY_MS = 86400000L
    private const val NAMES_OFF = 0x39
    private const val NAME_MAX = 0x20
    private const val MAX_COLS = 40
    private const val MAX_RECS = 20000
    private const val DATE_MIN = 788918400000.0   // Date.UTC(1995,0,1)
    private const val DATE_MAX = 4102444800000.0  // Date.UTC(2100,0,1)

    private val cp1251 = charset("windows-1251")
    private val reFlag = Regex("^Er\\d*$")
    private val reDate = Regex("^(Дата|Время|Date|Time)", RegexOption.IGNORE_CASE)
    private val reT = Regex("^d?[Tt]")
    private val reV = Regex("^d?[VG]")

    fun isFlagCol(n: String) = reFlag.containsMatchIn(n)
    fun isDateCol(n: String) = reDate.containsMatchIn(n)
    fun isT(n: String) = reT.containsMatchIn(n)
    fun isV(n: String) = reV.containsMatchIn(n)
    fun decFor(n: String) = if (isV(n)) 1 else 2

    private fun bad(msg: String): Nothing = throw K20Exception(msg)

    private fun readShortStrings(b: ByteArray, start: Int, maxLen: Int, maxCount: Int): Pair<List<String>, Int> {
        val out = ArrayList<String>()
        var pos = start
        while (pos >= 0 && pos < b.size && out.size < maxCount) {
            val ln = b[pos].toInt() and 0xFF
            if (ln == 0 || ln > maxLen || pos + 1 + ln > b.size) break
            out.add(String(b, pos + 1, ln, cp1251))
            pos += 1 + ln
        }
        return Pair(out, pos)
    }

    /** Битовая маска причин ненаработки, упакованная во float32 внутри double. */
    fun decodeEr(v: Double): String {
        if (!v.isFinite()) return ""
        val bits = java.lang.Float.floatToRawIntBits(v.toFloat())
        if (bits == 0) return ""
        val parts = ArrayList<String>()
        for (i in 0 until 32) {
            if ((bits ushr i) and 1 == 1) parts.add(if (i == 0) "Bat" else "Er$i")
        }
        return parts.joinToString(";") + ";"
    }

    fun parse(b: ByteArray): K20Archive {
        if (b.size < NAMES_OFF + 16) bad("файл слишком короткий для архива .K20")
        val dv = ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN)
        val count = dv.getShort(2).toInt() and 0xFFFF
        if (count < 1 || count > MAX_RECS) bad("неправдоподобное число записей в заголовке: $count")
        val (rawNames, posAfter) = readShortStrings(b, NAMES_OFF, NAME_MAX, MAX_COLS + 1)
        val names = rawNames.map { n ->
            buildString {
                for (ch in n) when (ch) {
                    'ѕ' -> append("под") // cp1251 0xBE «ѕ»
                    'ј' -> append("обр") // cp1251 0xBC «ј»
                    else -> append(ch)
                }
            }
        }
        val c = names.size
        if (c < 2) bad("не найдены имена колонок — это не архив пульта ЛУЧ-МК")
        if (c > MAX_COLS) bad("неправдоподобное число колонок: $c")
        if (!isDateCol(names[0]))
            bad("первая колонка «${names[0]}» — не дата; структура файла не распознана")
        val pos = posAfter
        if (pos.toLong() + c.toLong() * count * 8 > b.size)
            bad("файл обрезан: данных ${b.size - pos} байт вместо ${c.toLong() * count * 8}")
        val cols = Array(c) { ci ->
            DoubleArray(count) { i -> dv.getDouble(pos + (ci * count + i) * 8) }
        }
        // Хвост: 128 служебных байт, затем ShortString-метаданные (прибор, архив, номер)
        val (metaStr, _) = readShortStrings(b, pos + c * count * 8 + 128, 255, 8)
        val rows = ArrayList<K20Row>(count)
        var skipped = 0
        for (i in 0 until count) {
            val t = DELPHI_EPOCH + cols[0][i] * DAY_MS
            if (!t.isFinite() || t < DATE_MIN || t > DATE_MAX) { skipped++; continue }
            val vals = LinkedHashMap<String, Any?>()
            for (ci in 1 until c) {
                val v = cols[ci][i]
                vals[names[ci]] = if (isFlagCol(names[ci])) decodeEr(v) else (if (v.isFinite()) v else null)
            }
            rows.add(K20Row(t.toLong(), vals))
        }
        if (rows.isEmpty()) bad("в архиве нет ни одной записи с корректной датой")
        rows.sortBy { it.dateMs } // кольцевой буфер может быть выгружен «с середины»
        return K20Archive(
            names, rows,
            K20Meta(metaStr.getOrElse(0) { "" }, metaStr.getOrElse(1) { "" }, metaStr.getOrElse(2) { "" }),
            K20Diag(count, c, skipped, b.size),
        )
    }

    fun fmtD(d: LocalDate): String =
        d.dayOfMonth.toString().padStart(2, '0') + "." +
        d.monthValue.toString().padStart(2, '0') + "." + d.year
}
