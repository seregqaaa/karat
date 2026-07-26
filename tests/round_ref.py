# -*- coding: utf-8 -*-
"""Референс каскадного округления half-up на decimal — арбитр для JS chainRound.

stdin:  JSON-массив троек [значение, viewDec, repDec]
stdout: JSON-массив результатов (float)

Каскад повторяет отчёт «КАРАТ-Экспресс»: сначала округление до viewDec знаков
(как значение показывается в программе), затем до repDec (как оно попадает в
отчёт). Основа — десятичная запись double (repr даёт кратчайшую строку,
однозначно задающую число), что совпадает с Number.prototype.toString в JS.
"""
import sys, json
from decimal import Decimal, ROUND_HALF_UP


def chain(v, view_dec, rep_dec):
    d = Decimal(repr(v))
    q1 = d.quantize(Decimal(1).scaleb(-view_dec), rounding=ROUND_HALF_UP)
    q2 = q1.quantize(Decimal(1).scaleb(-rep_dec), rounding=ROUND_HALF_UP)
    return float(q2)


def main():
    cases = json.load(sys.stdin)
    json.dump([chain(*c) for c in cases], sys.stdout)


if __name__ == "__main__":
    main()
