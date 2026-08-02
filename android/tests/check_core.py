# -*- coding: utf-8 -*-
"""Сверка Kotlin-ядра с эталонами проекта:
1) golden-снапшоты JS-ядра (tests/private/golden/*.json)
2) каскадное округление против python decimal (референс round_ref.py)
3) поячеечная сверка собранных .xlsx с выгрузками КАРАТ-Экспресс (etalon_*.xlsx)
"""
import json, math, os, random, re, subprocess, sys, zipfile
import xml.etree.ElementTree as ET
from decimal import Decimal, ROUND_HALF_UP

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)                       # …/android
REPO = os.path.dirname(APP)                       # корень репозитория
# реальные архивы и эталоны (в git не публикуются)
UP = os.environ.get("K20_PRIVATE") or os.path.join(REPO, "tests", "private")
JAR = os.environ.get("K20_JAR") or os.path.join(APP, "build", "core-test.jar")

def config_address():
    """Адрес объекта — не публикуется, как и config.js веб-версии: берём его из
    Config.kt сборки (он в .gitignore) либо из K20_ADDRESS."""
    p = os.path.join(APP, "src", "app", "Config.kt")
    if not os.path.exists(p):
        return None
    with open(p, encoding="utf-8") as f:
        m = re.search(r'SEND_ADDRESS\s*=\s*"([^"]*)"', f.read())
    return m.group(1) if m else None

ADDRESS = os.environ.get("K20_ADDRESS") or config_address() or "Адрес_объекта"
# Эталоны, где заголовок D1 оформлен канонически («адрес + отчет данных м1 м2 год»);
# в 0424 год не дописан, в 0624 заголовок перенесён в C1 и месяцы через дефис.
CANON_TITLE = {"0524", "0724"}
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)
FAILS = []

def ok(cond, msg):
    print(("  ✓ " if cond else "  ✗ ") + msg)
    if not cond:
        FAILS.append(msg)

def run(*args):
    r = subprocess.run(["java", "-cp", JAR, "ru.karat.k20viewer.TestMain", *args],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr[-2000:])
    return r.stdout

def deep_eq(a, b, path=""):
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return f"{path}: длина {len(a)} != {len(b)}"
        for i, (x, y) in enumerate(zip(a, b)):
            d = deep_eq(x, y, f"{path}[{i}]")
            if d: return d
        return None
    if isinstance(a, dict) and isinstance(b, dict):
        if set(a) != set(b):
            return f"{path}: ключи {set(a)} != {set(b)}"
        for k in a:
            d = deep_eq(a[k], b[k], f"{path}.{k}")
            if d: return d
        return None
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if float(a) != float(b) and not (isinstance(a, float) and isinstance(b, float) and math.isnan(a) and math.isnan(b)):
            return f"{path}: {a!r} != {b!r}"
        return None
    if a != b:
        return f"{path}: {a!r} != {b!r}"
    return None

# ---------- 1. golden ----------
print("== golden-снапшоты ==")
for f in sorted(os.listdir(UP)):
    if not f.lower().endswith(".k20"):
        continue
    mine = os.path.join(OUT, f + ".mine.json")
    run("golden", os.path.join(UP, f), mine)
    with open(mine, encoding="utf-8") as fh: a = json.load(fh)
    with open(os.path.join(UP, "golden", f + ".json"), encoding="utf-8") as fh: b = json.load(fh)
    d = deep_eq(a, b)
    ok(d is None, f"{f}: снапшот совпадает" + (f" | {d}" if d else ""))

# ---------- 2. округление ----------
print("== округление против python decimal ==")
def py_chain(v, view_dec, rep_dec):
    d = Decimal(repr(v))
    q1 = d.quantize(Decimal(1).scaleb(-view_dec), rounding=ROUND_HALF_UP)
    q2 = q1.quantize(Decimal(1).scaleb(-rep_dec), rounding=ROUND_HALF_UP)
    return float(q2)

random.seed(20260726)
cases = []
evil = [0.755, 1.005, 0.955, 0.13471, 0.0345, 1.67103, 0.135, 2.675, 0.045, 0.5,
        1e-7, 123456.78901, 0.994999, 0.995, 0.9950000001, 24.0, 0.0, 16.6663]
for v in evil:
    for a, b in ((3, 2), (5, 1), (5, 2)):
        cases.append((v, a, b))
        cases.append((-v, a, b))
for _ in range(4000):
    v = random.choice([
        random.uniform(0, 100),
        random.uniform(0, 100000),
        random.randint(0, 200000) / random.choice([10, 100, 1000, 10000, 100000]),
        random.uniform(0, 1e-3),
    ])
    if random.random() < 0.5:
        v = -v
    cases.append((v, *random.choice([(3, 2), (5, 1), (5, 2)])))
with open(os.path.join(OUT, "round_cases.txt"), "w") as fh:
    for v, a, b in cases:
        fh.write(f"{v!r} {a} {b}\n")
res = run("round", os.path.join(OUT, "round_cases.txt")).splitlines()
diff = 0
for (v, a, b), mine in zip(cases, res):
    ref = py_chain(v, a, b)
    m = float(mine)
    if m != ref and not (m == 0 and ref == 0):
        diff += 1
        if diff <= 5:
            print(f"  ✗ chain({v!r},{a},{b}) = {mine}, python: {ref!r}")
ok(diff == 0, f"расхождений с python-референсом: {diff} из {len(cases)}")

# ---------- 3. xlsx против эталонов ----------
print("== xlsx против эталонов КАРАТ-Экспресс ==")

def read_sheet(path):
    z = zipfile.ZipFile(path)
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        root = ET.fromstring(z.read("xl/sharedStrings.xml"))
        for si in root.findall("m:si", ns):
            shared.append("".join(t.text or "" for t in si.iter(
                "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t")))
    sheet_name = next(n for n in ("xl/worksheets/sheet1.xml",)
                      if n in z.namelist())
    root = ET.fromstring(z.read(sheet_name))
    cells = {}
    for c in root.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}c"):
        ref = c.get("r"); t = c.get("t")
        vel = c.find("m:v", ns)
        if vel is None:
            isel = c.find("m:is", ns)
            if isel is not None:
                cells[ref] = "".join(x.text or "" for x in isel.iter(
                    "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t"))
            continue
        v = vel.text or ""
        if t == "s":
            cells[ref] = shared[int(v)]
        elif t in ("str", "inlineStr"):
            cells[ref] = v
        elif t == "b":
            cells[ref] = bool(int(v))
        else:
            cells[ref] = float(v)
    widths = {}
    for col in root.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}col"):
        for i in range(int(col.get("min")), int(col.get("max")) + 1):
            widths[i] = float(col.get("width"))
    return cells, widths

date_re = re.compile(r"^(\d\d)\.(\d\d)\.(\d{4})")
def cell_col_row(ref):
    m = re.match(r"([A-Z]+)(\d+)", ref)
    col = 0
    for ch in m.group(1):
        col = col * 26 + ord(ch) - 64
    return col, int(m.group(2))

for xf in sorted(f for f in os.listdir(UP) if re.fullmatch(r"etalon_\d{4}\.xlsx", f)):
    mmdd = re.search(r"\d{4}", xf).group(0)
    kf = os.path.join(UP, mmdd + "A0.K20")
    if not os.path.exists(kf):
        print(f"  {xf}: нет парного K20 — пропуск"); continue
    et_cells, et_widths = read_sheet(os.path.join(UP, xf))
    # период эталона по датам в колонке A
    dates = []
    for ref, v in et_cells.items():
        col, row = cell_col_row(ref)
        if col == 1 and isinstance(v, str):
            m = date_re.match(v)
            if m:
                dates.append((f"{m.group(3)}-{m.group(2)}-{m.group(1)}", row))
    dates.sort()
    frm, to = dates[0][0], dates[-1][0]
    fname = run("xlsx", kf, frm, to, OUT, ADDRESS).strip()
    my_cells, my_widths = read_sheet(os.path.join(OUT, fname))
    # Заголовок D1: адрес объекта + название отчёта, как в ведомостях
    my_title = my_cells.get("D1")
    ok(isinstance(my_title, str) and my_title.startswith(ADDRESS.replace("_", " ") + " "),
       f"{xf}: D1 начинается с адреса — {my_title!r}")
    et_title = next((v for r, v in sorted(et_cells.items(), key=lambda kv: cell_col_row(kv[0]))
                     if cell_col_row(r)[1] == 1 and isinstance(v, str) and "отчет данных" in v), None)
    if mmdd in CANON_TITLE:
        ok(et_title == my_title, f"{xf}: D1 == эталон ({et_title!r})")
    else:
        print(f"    · {xf}: заголовок эталона правлен вручную — эталон {et_title!r}, у нас {my_title!r}")
    # Данные (строки с шапки и ниже) обязаны совпадать поячеечно. Первые две
    # строки эталонов правлены руками (адрес в D1/C1, свои ширины) — их и
    # ярлык «Итого:»/«Итого» сверяем нестрого, как run.mjs.
    diffs, cells_cnt = [], 0
    for ref in sorted(set(et_cells) | set(my_cells), key=cell_col_row):
        col, row = cell_col_row(ref)
        a, b = et_cells.get(ref), my_cells.get(ref)
        if isinstance(a, str) and re.fullmatch(r"Итого:?", a.strip()):
            a = "Итого"
        if isinstance(b, str) and re.fullmatch(r"Итого:?", b.strip()):
            b = "Итого"
        if row <= 2:
            if a is None or b is None: continue
            if ref != "A1": continue  # D1/C1 сверяются отдельно (заголовок с адресом)
        if a is None and (b == "" or b is None): continue
        if b is None and (a == "" or a is None): continue
        cells_cnt += 1
        same = (float(a) == float(b)) if isinstance(a, float) and isinstance(b, (int, float)) else (a == b)
        if not same:
            diffs.append(f"{ref}: эталон {a!r}, у нас {b!r}")
    for d in diffs[:6]: print("    ✗ " + d)
    ok(not diffs, f"{xf} ↔ {fname}: данные ({cells_cnt} ячеек), период {frm}…{to}, расхождений {len(diffs)}")
    # Арбитр паритета с текущим приложением: тот же период тем же JS-ядром
    js_fname = subprocess.run(["node", os.path.join(APP, "tests", "js_build.mjs"),
                               kf, frm, to, OUT], capture_output=True, text=True).stdout.strip()
    ok(js_fname == fname, f"{xf}: имя файла совпадает с JS ({js_fname})")
    js_cells, js_widths = read_sheet(os.path.join(OUT, "js_" + js_fname))
    # D1 у JS-версии без адреса (адрес есть только в APK) — сверяем с префиксом
    ok(my_cells.get("D1") == ADDRESS.replace("_", " ") + " " + js_cells.get("D1"),
       f"{xf}: D1 == адрес + заголовок JS")
    jd = []
    for ref in sorted(set(js_cells) | set(my_cells), key=cell_col_row):
        if ref == "D1": continue
        a, b = js_cells.get(ref), my_cells.get(ref)
        same = (float(a) == float(b)) if isinstance(a, float) and isinstance(b, (int, float)) else (a == b)
        if not same:
            jd.append(f"{ref}: JS {a!r}, Kotlin {b!r}")
    for d in jd[:6]: print("    ✗ " + d)
    ok(not jd, f"{xf}: Kotlin == JS поячеечно ({len(js_cells)} ячеек)")
    ok(js_widths == my_widths, f"{xf}: ширины колонок == JS")

print()
print("ИТОГ: " + ("ВСЁ ЗЕЛЕНО" if not FAILS else f"ПРОВАЛОВ: {len(FAILS)}"))
sys.exit(1 if FAILS else 0)
