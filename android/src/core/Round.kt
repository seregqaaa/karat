package ru.karat.k20viewer

import java.math.BigDecimal
import java.math.MathContext
import java.math.RoundingMode

/**
 * Каскадное округление half-up «как в отчёте КАРАТ-Экспресс».
 * Основа — кратчайшая десятичная запись double (то, что печатают
 * Number.prototype.toString в JS и repr() в Python). Реализована сама,
 * без Double.toString: у разных рантаймов Android/JVM он исторически
 * различался, а здесь результат обязан совпадать бит-в-бит с
 * python-референсом (decimal, ROUND_HALF_UP) и golden-снапшотами JS.
 */
object Round {

    /** Кратчайшая десятичная запись положительного конечного v (round-trip). */
    fun shortest(v: Double): BigDecimal {
        val exact = BigDecimal(v)
        for (p in 1..17) {
            val r = exact.round(MathContext(p, RoundingMode.HALF_EVEN))
            if (r.toDouble() == v) return r
        }
        return exact
    }

    /**
     * Каскад: сначала до viewDec знаков (как на экране прибора/программы),
     * затем до repDec (как в отчёте); оба шага half-up от нуля.
     * null — «передать как есть» (не конечное или |v| >= 1e15, как в JS).
     */
    fun chain(v: Double, viewDec: Int, repDec: Int): BigDecimal? {
        if (!v.isFinite() || Math.abs(v) >= 1e15) return null
        if (v == 0.0) return BigDecimal.ZERO.setScale(repDec)
        val neg = v < 0
        val r1 = shortest(Math.abs(v)).setScale(viewDec, RoundingMode.HALF_UP)
        val r2 = r1.setScale(repDec, RoundingMode.HALF_UP)
        return if (neg) r2.negate() else r2
    }

    /** Значение колонки в точности отчёта; null вход → null. */
    fun rep(name: String, v: Double?): BigDecimal? {
        if (v == null) return null
        val r = when {
            K20.isT(name) -> chain(v, 3, 2)
            K20.isV(name) -> chain(v, 5, 1)
            else -> chain(v, 5, 2)
        }
        return r ?: shortest(v) // редчайший passthrough: |v| >= 1e15
    }

    /** «Итого» = сумма построчно округлённых значений (целочисленно). */
    fun total(rows: List<K20Row>, name: String): BigDecimal {
        val dec = K20.decFor(name)
        var sum = 0L
        for (r in rows) {
            val v = r.vals[name]
            if (v !is Double) continue
            val rp = rep(name, v) ?: continue
            if (rp.scale() != dec) continue // passthrough-значения в сумму не попадают корректно — как в JS Math.round
            sum += rp.unscaledValue().toLong()
        }
        return BigDecimal.valueOf(sum, dec)
    }

    /** Число как его печатает JS String(v): без хвостовых нулей и «-0». */
    fun jsNum(bd: BigDecimal): String {
        var s = bd.stripTrailingZeros()
        if (s.scale() < 0) s = s.setScale(0)
        val str = s.toPlainString()
        return if (str == "-0" || str == "-0.0") "0" else str
    }
}
