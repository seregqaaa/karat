package ru.karat.k20viewer

import java.io.File
import java.time.LocalDate

/** CLI для JVM-проверок ядра: golden-снапшоты, сборка xlsx, округление. */
object TestMain {
    private fun jstr(s: String): String {
        val sb = StringBuilder("\"")
        for (ch in s) when {
            ch == '"' -> sb.append("\\\"")
            ch == '\\' -> sb.append("\\\\")
            ch == '\n' -> sb.append("\\n")
            ch == '\r' -> sb.append("\\r")
            ch == '\t' -> sb.append("\\t")
            ch.code < 0x20 -> sb.append("\\u%04x".format(ch.code))
            else -> sb.append(ch)
        }
        return sb.append('"').toString()
    }

    private fun goldenJson(arc: K20Archive): String {
        val sb = StringBuilder("{\"names\":[")
        sb.append(arc.names.joinToString(",") { jstr(it) })
        sb.append("],\"meta\":{\"device\":").append(jstr(arc.meta.device))
        sb.append(",\"archive\":").append(jstr(arc.meta.archive))
        sb.append(",\"serial\":").append(jstr(arc.meta.serial)).append("},\"snap\":[")
        val tail = arc.names.drop(1)
        val rows = arc.rows.map { r ->
            val cells = ArrayList<String>()
            cells.add(jstr(K20.fmtD(r.date)))
            for (n in tail) {
                val v = r.vals[n]
                cells.add(when (v) {
                    is String -> jstr(v)
                    is Double -> Round.rep(n, v)?.let { Round.jsNum(it) } ?: "null"
                    else -> "null"
                })
            }
            cells.joinToString(",", "[", "]")
        }.toMutableList()
        val totals = ArrayList<String>()
        totals.add(jstr("Итого"))
        for (n in tail) totals.add(if (K20.isFlagCol(n)) jstr("") else Round.jsNum(Round.total(arc.rows, n)))
        rows.add(totals.joinToString(",", "[", "]"))
        sb.append(rows.joinToString(","))
        sb.append("]}")
        return sb.toString()
    }

    @JvmStatic
    fun main(args: Array<String>) {
        when (args[0]) {
            "golden" -> { // golden <in.k20> <out.json>
                val arc = K20.parse(File(args[1]).readBytes())
                File(args[2]).writeText(goldenJson(arc))
            }
            "xlsx" -> { // xlsx <in.k20> <fromIso> <toIso> <outDir> [адрес] — печатает fname
                val arc = K20.parse(File(args[1]).readBytes())
                val from = LocalDate.parse(args[2])
                val to = LocalDate.parse(args[3])
                val rows = arc.rows.filter { !it.date.isBefore(from) && !it.date.isAfter(to) }
                val rp = ReportBuilder.build(rows, arc.names.drop(1), arc.meta, from, to,
                    args.getOrElse(5) { "" })
                File(args[4], rp.fname).writeBytes(Xlsx.write(rp))
                println(rp.fname)
            }
            "round" -> { // round <cases.txt: "v view rep" в строке> — печатает результат в строке
                File(args[1]).readLines().forEach { line ->
                    if (line.isBlank()) return@forEach
                    val (v, a, b) = line.trim().split(Regex("\\s+"))
                    val r = Round.chain(v.toDouble(), a.toInt(), b.toInt())
                    println(if (r == null) "passthrough" else Round.jsNum(r))
                }
            }
            "parse-err" -> { // parse-err <in> — печатает сообщение ошибки или OK
                try { K20.parse(File(args[1]).readBytes()); println("OK") }
                catch (e: K20Exception) { println("ERR: ${e.message}") }
                catch (e: Exception) { println("CRASH: ${e::class.java.simpleName}: ${e.message}") }
            }
        }
    }
}
