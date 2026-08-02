package ru.karat.k20viewer

import java.math.BigDecimal
import java.time.LocalDate
import java.util.Locale

/**
 * Отчёт в формате выгрузки оригинальной «КАРАТ-Экспресс» — порт buildAoa()
 * из index.html; поячеечно сверяется с эталонами tests/private/etalon_*.xlsx.
 */
sealed class Cell {
    class Str(val s: String) : Cell()
    class Num(val n: BigDecimal) : Cell()
}

class Report(val aoa: List<List<Cell?>>, val fname: String, val widths: List<Double>)

object ReportBuilder {
    val RU_MONTHS = listOf(
        "январь", "февраль", "март", "апрель", "май", "июнь",
        "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
    )

    fun capFirst(s: String): String =
        if (s.isEmpty()) s
        else s.substring(0, 1).uppercase(Locale.ROOT) + s.substring(1).lowercase(Locale.ROOT)

    private val headerMap = mapOf(
        "Er0" to "Причина ненаработки",
        "Наработка H0" to "Наработка",
        "dV1" to "Vo",
    )

    /**
     * rows — уже отфильтрованный период; names — колонки без «Дата»;
     * address — адрес объекта (например «Ленина_12»): попадает в заголовок D1 отчёта
     * перед названием, как в эталонных ведомостях.
     */
    fun build(
        rows: List<K20Row>, names: List<String>, meta: K20Meta,
        from: LocalDate, to: LocalDate, address: String = "",
    ): Report {
        val base = "отчет_данных_" + RU_MONTHS[from.monthValue - 1] + "_" +
            RU_MONTHS[to.monthValue - 1] + "_" + to.year
        val title = (address.replace('_', ' ').trim() + " " + base.replace('_', ' ')).trim()
        val archType = meta.archive.split(".")[0].ifEmpty { "Посуточный архив" }.trim()
        val aoa = ArrayList<List<Cell?>>()
        aoa.add(listOf(
            Cell.Str("Архив прибора:" + capFirst(meta.device) + " (" + meta.serial + ")." + archType),
            null, null, Cell.Str(title),
        ))
        aoa.add(if (meta.serial.isNotEmpty())
            listOf(Cell.Str(meta.device.ifEmpty { "прибор" }.uppercase(Locale.ROOT) + " № " + meta.serial))
        else emptyList())
        aoa.add(listOf(Cell.Str("Дата")) + names.map { Cell.Str(headerMap[it] ?: it) })
        for (r in rows) {
            val line = ArrayList<Cell?>(names.size + 1)
            line.add(Cell.Str(K20.fmtD(r.date) + " 0:00:00"))
            for (n in names) {
                val v = r.vals[n]
                line.add(when (v) {
                    is String -> Cell.Str(if (v.isNotEmpty()) " $v" else "Ok")
                    is Double -> Round.rep(n, v)?.let { Cell.Num(it) }
                    else -> null
                })
            }
            aoa.add(line)
        }
        if (rows.isNotEmpty()) {
            aoa.add(listOf<Cell?>(Cell.Str("Итого")) +
                names.map { n -> if (K20.isFlagCol(n)) null else Cell.Num(Round.total(rows, n)) })
        }
        // ширины сверены с выгрузкой КАРАТ-Экспресс; лишним колонкам — по 12
        val widths = ArrayList(listOf(16.63, 22.5, 17.0, 13.5, 13.63, 11.5, 13.5, 8.43, 11.63, 13.75))
        while (widths.size < names.size + 1) widths.add(12.0)
        return Report(aoa, "$base.xlsx", widths)
    }
}
