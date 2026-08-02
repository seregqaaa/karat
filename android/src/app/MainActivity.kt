package ru.karat.k20viewer

import android.app.Activity
import android.app.AlertDialog
import android.app.DatePickerDialog
import android.content.Intent
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.DocumentsContract
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.math.BigDecimal
import java.net.HttpURLConnection
import java.net.URL
import java.time.LocalDate
import java.time.format.DateTimeFormatter

/**
 * «ЛУЧ-МК: показания в 1 клик» — нативная Kotlin-версия (порт WebView-приложения).
 * Выбор файла + автопоиск пульта (SAF), диапазон дат, таблица с «Итого»,
 * отправка отчёта .xlsx на почту через Yandex Cloud Function.
 */
class MainActivity : Activity() {
    companion object {
        private const val REQ_FILE = 101
        private const val REQ_TREE = 102
        private const val USB_ATTACHED = "android.hardware.usb.action.USB_DEVICE_ATTACHED"
        private const val SCAN_TIMEOUT_MS = 20000L
        private val DMY: DateTimeFormatter = DateTimeFormatter.ofPattern("dd.MM.yyyy")
    }

    private val ui = Handler(Looper.getMainLooper())

    // Текущий открытый архив и выбранный период
    private var arc: K20Archive? = null
    private var arcFname: String = ""
    private var from: LocalDate? = null
    private var to: LocalDate? = null

    // Домашний экран: только элементы управления, без подписей и статусов
    private lateinit var home: LinearLayout
    private lateinit var permBtn: Button
    private lateinit var pickBtn: Button
    private lateinit var retryBtn: Button
    private lateinit var progress: ProgressBar
    private lateinit var listBox: LinearLayout

    private var scanning = false
    private var scanStartedAt = 0L
    // идёт чтение файла (ручной выбор или «Поделиться») — поиск пульта не мешаем
    private var opening = false

    // ---------------------------------------------------------------- UI utils
    private fun dp(v: Int): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    private fun text(s: String, sizeSp: Float = 14f, bold: Boolean = false): TextView =
        TextView(this).apply {
            text = s
            setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
            if (bold) setTypeface(typeface, Typeface.BOLD)
        }

    private fun alert(msg: String) {
        if (isFinishing) return
        AlertDialog.Builder(this).setMessage(msg).setPositiveButton("ОК", null).show()
    }

    /** Число для таблицы — как toLocaleString("ru-RU"): пробелы тысяч, запятая. */
    private fun fmtN(bd: BigDecimal?): String {
        if (bd == null) return "—"
        val plain = Round.jsNum(bd)
        val neg = plain.startsWith("-")
        val p = if (neg) plain.substring(1) else plain
        val dot = p.indexOf('.')
        val ip = if (dot < 0) p else p.substring(0, dot)
        val fp = if (dot < 0) "" else p.substring(dot + 1)
        val grouped = StringBuilder()
        for ((i, ch) in ip.withIndex()) {
            if (i > 0 && (ip.length - i) % 3 == 0) grouped.append(' ')
            grouped.append(ch)
        }
        return (if (neg) "-" else "") + grouped + (if (fp.isEmpty()) "" else ",$fp")
    }

    private fun encodeURIComponent(s: String): String {
        val keep = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
        val sb = StringBuilder()
        val hex = "0123456789ABCDEF"
        for (b in s.toByteArray(Charsets.UTF_8)) {
            val c = b.toInt() and 0xFF
            if (c < 128 && keep.indexOf(c.toChar()) >= 0) sb.append(c.toChar())
            else sb.append('%').append(hex[c shr 4]).append(hex[c and 15])
        }
        return sb.toString()
    }

    private fun pref(k: String): String = getSharedPreferences("k20", 0).getString(k, "") ?: ""
    private fun prefSet(k: String, v: String) =
        getSharedPreferences("k20", 0).edit().putString(k, v).apply()

    // ---------------------------------------------------------------- lifecycle
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        buildHome()
        showHome()
        // файл, присланный системным «Поделиться», важнее поиска пульта
        if (!handleShare(intent)) autoScan()
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        if (intent == null) return
        setIntent(intent)
        if (handleShare(intent)) return
        if (USB_ATTACHED == intent.action) {
            arc = null
            showHome()
            scanning = false
            autoScan()
        }
    }

    override fun onResume() {
        super.onResume()
        if (arc == null && !scanning && !opening) autoScan()
    }

    /**
     * Файл(ы) из системного «Поделиться» (ACTION_SEND / SEND_MULTIPLE).
     * Дальше — ровно тот же путь, что и при выборе файла вручную.
     * Действие у обработанного intent-а гасим, чтобы поворот экрана или
     * возврат в приложение не открывали тот же файл повторно.
     */
    private fun handleShare(intent: Intent?): Boolean {
        if (intent == null) return false
        val uris = ArrayList<Uri>()
        when (intent.action) {
            Intent.ACTION_SEND ->
                (intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri)?.let { uris.add(it) }
            Intent.ACTION_SEND_MULTIPLE ->
                intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
                    ?.filterNotNull()?.let { uris.addAll(it) }
            Intent.ACTION_VIEW -> intent.data?.let { uris.add(it) }
            else -> return false
        }
        intent.action = null
        if (uris.isEmpty()) return false
        openUris(uris)
        return true
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        when (requestCode) {
            REQ_FILE -> {
                val uri = if (resultCode == RESULT_OK) data?.data else null
                if (uri != null) openUris(listOf(uri))
            }
            REQ_TREE -> {
                val uri = if (resultCode == RESULT_OK) data?.data else null
                if (uri != null) {
                    try {
                        contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    } catch (_: Exception) {}
                }
            }
            else -> super.onActivityResult(requestCode, resultCode, data)
        }
    }

    // ---------------------------------------------------------------- домашний экран
    private fun buildHome() {
        home = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(24), dp(32), dp(24), dp(24))
        }
        progress = ProgressBar(this).apply { isIndeterminate = true; visibility = View.GONE }
        home.addView(progress, LinearLayout.LayoutParams(dp(32), dp(32)))
        permBtn = Button(this).apply {
            text = "Разрешить доступ"
            visibility = View.GONE
            setOnClickListener { requestStorageAccess() }
        }
        home.addView(permBtn, lpm(top = 16))
        retryBtn = Button(this).apply {
            text = "Повторить поиск"
            visibility = View.GONE
            setOnClickListener { autoScan() }
        }
        home.addView(retryBtn, lpm(top = 16))
        listBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        home.addView(listBox, lpm(top = 12))
        pickBtn = Button(this).apply {
            text = "Выбрать файл"
            setOnClickListener { pickFile() }
        }
        home.addView(pickBtn, lpm(top = 16))
    }

    private fun lpm(top: Int = 0): LinearLayout.LayoutParams =
        LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(top); gravity = Gravity.CENTER_HORIZONTAL }

    private fun showHome() {
        setContentView(ScrollView(this).apply { addView(home) })
    }

    private fun pickFile() {
        try {
            val i = Intent(Intent.ACTION_GET_CONTENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "*/*"
            }
            startActivityForResult(Intent.createChooser(i, "Выберите файл .K20"), REQ_FILE)
        } catch (_: Exception) {}
    }

    private fun requestStorageAccess() {
        try {
            val i = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
            startActivityForResult(i, REQ_TREE)
        } catch (_: Exception) {}
    }

    private fun hasStorageAccess(): Boolean =
        contentResolver.persistedUriPermissions.any { it.isReadPermission }

    // ---------------------------------------------------------------- сканирование пульта
    private class FileEntry(val uri: Uri, val name: String, val mtime: Long)
    private class Found(val entry: FileEntry, val arc: K20Archive) {
        val last: LocalDate? = arc.rows.lastOrNull()?.date
    }

    private fun autoScan() {
        if (scanning) return
        listBox.removeAllViews()
        retryBtn.visibility = View.GONE
        if (!hasStorageAccess()) {
            permBtn.visibility = View.VISIBLE
            progress.visibility = View.GONE
            return
        }
        permBtn.visibility = View.GONE
        scanning = true
        scanStartedAt = System.currentTimeMillis()
        progress.visibility = View.VISIBLE
        scanTick()
    }

    private fun scanTick() {
        Thread {
            val list = try { scanArchives() } catch (_: Exception) { emptyList<FileEntry>() }
            ui.post {
                if (!scanning) return@post
                if (list.isNotEmpty()) {
                    scanning = false
                    progress.visibility = View.GONE
                    processList(list)
                } else if (System.currentTimeMillis() - scanStartedAt < SCAN_TIMEOUT_MS) {
                    ui.postDelayed({ if (scanning) scanTick() }, 1000)
                } else {
                    // пульт не найден: остаётся только кнопка повтора, без текста
                    scanning = false
                    progress.visibility = View.GONE
                    retryBtn.visibility = View.VISIBLE
                }
            }
        }.start()
    }

    /** Обход выданных SAF-грантов: корень, archives/, archives/{номер}/. */
    private fun scanArchives(): List<FileEntry> {
        val out = ArrayList<FileEntry>()
        for (p in contentResolver.persistedUriPermissions) {
            if (!p.isReadPermission) continue
            try { scanTree(out, p.uri) } catch (_: Exception) {}
        }
        return out
    }

    private class Entry(val docId: String, val name: String, val dir: Boolean, val mtime: Long)

    private fun listChildren(tree: Uri, docId: String): List<Entry> {
        val res = ArrayList<Entry>()
        try {
            contentResolver.query(
                DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId),
                arrayOf(
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_MIME_TYPE,
                    DocumentsContract.Document.COLUMN_LAST_MODIFIED,
                ), null, null, null
            )?.use { c ->
                while (c.moveToNext()) {
                    res.add(Entry(
                        c.getString(0),
                        c.getString(1) ?: "",
                        DocumentsContract.Document.MIME_TYPE_DIR == c.getString(2),
                        if (c.isNull(3)) 0 else c.getLong(3),
                    ))
                }
            }
        } catch (_: Exception) {}
        return res
    }

    private fun scanTree(out: MutableList<FileEntry>, tree: Uri) {
        val addIf = { e: Entry ->
            if (!e.dir && e.name.lowercase().endsWith(".k20"))
                out.add(FileEntry(DocumentsContract.buildDocumentUriUsingTree(tree, e.docId), e.name, e.mtime))
        }
        for (e in listChildren(tree, DocumentsContract.getTreeDocumentId(tree))) {
            if (e.dir) {
                if (e.name.equals("archives", ignoreCase = true)) {
                    for (e2 in listChildren(tree, e.docId)) {
                        if (e2.dir) listChildren(tree, e2.docId).forEach(addIf) else addIf(e2)
                    }
                } else {
                    listChildren(tree, e.docId).forEach(addIf)
                }
            } else addIf(e)
        }
    }

    private fun processList(list: List<FileEntry>) {
        Thread {
            val daily = ArrayList<Found>()
            val others = ArrayList<Found>()
            for (f in list) {
                val bytes = try { readUri(f.uri) } catch (_: Exception) { null } ?: continue
                val a = try { K20.parse(bytes) } catch (_: Exception) { continue }
                val item = Found(f, a)
                if (Regex("Посуточ", RegexOption.IGNORE_CASE).containsMatchIn(a.meta.archive))
                    daily.add(item) else others.add(item)
            }
            ui.post {
                if (daily.isEmpty() && others.isEmpty()) {
                    retryBtn.visibility = View.VISIBLE
                    alert("Файлы .k20 найдены, но прочитать их не удалось — проверьте пульт.")
                    return@post
                }
                val bySerial = LinkedHashMap<String, Found>()
                for (it in daily) {
                    val cur = bySerial[it.arc.meta.serial]
                    if (cur == null || (it.last != null && cur.last != null && cur.last < it.last))
                        bySerial[it.arc.meta.serial] = it
                }
                val picks = bySerial.values.toList()
                if (picks.size == 1) {
                    show(picks[0].arc, picks[0].entry.name)
                    return@post
                }
                // несколько приборов (или только непосуточные архивы) — выбор кнопками
                showChoices(picks.ifEmpty { others })
            }
        }.start()
    }

    /** Кнопки выбора архива: прибор, номер и дата последней записи. */
    private fun showChoices(items: List<Found>) {
        listBox.removeAllViews()
        for (it in items) {
            val b = Button(this)
            b.text = it.arc.meta.device.ifEmpty { "Прибор" } +
                (if (it.arc.meta.serial.isNotEmpty()) " № " + it.arc.meta.serial else "") +
                (it.last?.let { d -> " — по " + K20.fmtD(d) } ?: "")
            b.isAllCaps = false
            b.setOnClickListener { _ -> show(it.arc, it.entry.name) }
            listBox.addView(b, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(8) })
        }
    }

    private fun readUri(uri: Uri, cap: Long = 16777216): ByteArray? {
        contentResolver.openInputStream(uri)?.use { st ->
            val bos = ByteArrayOutputStream()
            val buf = ByteArray(65536)
            var total = 0L
            while (true) {
                val n = st.read(buf)
                if (n <= 0) break
                total += n
                if (total > cap) return null
                bos.write(buf, 0, n)
            }
            return bos.toByteArray()
        }
        return null
    }

    private fun queryName(uri: Uri): String {
        try {
            contentResolver.query(uri, null, null, null, null)?.use { c ->
                val i = c.getColumnIndex("_display_name")
                if (i >= 0 && c.moveToFirst()) return c.getString(i) ?: ""
            }
        } catch (_: Exception) {}
        return uri.lastPathSegment ?: "файл"
    }

    /**
     * Единый путь открытия файлов: и ручной выбор, и «Поделиться» приходят сюда,
     * поэтому поведение совпадает. Один разобранный архив открывается сразу,
     * несколько — предлагаются кнопками (как при нескольких приборах на пульте).
     */
    private fun openUris(uris: List<Uri>) {
        if (uris.isEmpty()) return
        opening = true
        scanning = false
        listBox.removeAllViews()
        retryBtn.visibility = View.GONE
        showHome()
        progress.visibility = View.VISIBLE
        Thread {
            val found = ArrayList<Found>()
            var firstError: String? = null
            for (u in uris) {
                val name = queryName(u)
                val bytes = try { readUri(u) } catch (_: Exception) { null }
                if (bytes == null) {
                    if (firstError == null) firstError = "Не удалось прочитать «$name»"
                    continue
                }
                try {
                    found.add(Found(FileEntry(u, name, 0), K20.parse(bytes)))
                } catch (e: K20Exception) {
                    if (firstError == null) firstError = "Не удалось разобрать «$name»:\n${e.message}"
                } catch (e: Exception) {
                    if (firstError == null)
                        firstError = "Не удалось разобрать «$name»:\nнеожиданная ошибка (${e.message})"
                }
            }
            ui.post {
                opening = false
                progress.visibility = View.GONE
                when {
                    found.size == 1 -> show(found[0].arc, found[0].entry.name)
                    found.size > 1 -> showChoices(found)
                    else -> alert(firstError ?: "Не удалось открыть файл")
                }
            }
        }.start()
    }

    // ---------------------------------------------------------------- экран таблицы
    private fun nextDay(iso: String): LocalDate? =
        try { LocalDate.parse(iso).plusDays(1) } catch (_: Exception) { null }

    private fun show(a: K20Archive, fname: String) {
        arc = a
        arcFname = fname
        val first = a.rows.first().date
        val last = a.rows.last().date
        // авто-диапазон: со дня, следующего за датой «по» последней выгрузки
        val saved = pref("lastExportTo:" + a.meta.serial)
        var f = (if (saved.isNotEmpty()) nextDay(saved) else null) ?: LocalDate.parse("2026-06-23")
        if (!f.isAfter(first)) f = first
        if (f.isAfter(last)) f = last
        from = f
        to = last
        renderTable()
    }

    private fun filtered(): List<K20Row> {
        val a = arc ?: return emptyList()
        val f = from
        val t = to
        return a.rows.filter { r ->
            (f == null || !r.date.isBefore(f)) && (t == null || !r.date.isAfter(t))
        }
    }

    private fun renderTable() {
        val a = arc ?: return
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(10), dp(12), dp(10))
        }

        // шапка: только прибор и заводской номер
        val meta = a.meta
        val metaLine = ReportBuilder.capFirst(meta.device).ifEmpty { "Прибор" } +
            (if (meta.serial.isNotEmpty()) " № ${meta.serial}" else "")
        root.addView(text(metaLine, 13f).apply { setPadding(0, 0, 0, dp(8)) })

        // выбор периода
        val controls = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val fromBtn = Button(this).apply { isAllCaps = false }
        val toBtn = Button(this).apply { isAllCaps = false }
        fun updDates() {
            fromBtn.text = "С: " + (from?.format(DMY) ?: "—")
            toBtn.text = "По: " + (to?.format(DMY) ?: "—")
        }
        updDates()
        fun pick(cur: LocalDate?, set: (LocalDate) -> Unit) {
            val c = cur ?: LocalDate.now()
            DatePickerDialog(this, { _, y, m, d ->
                set(LocalDate.of(y, m + 1, d))
                renderTable()
            }, c.year, c.monthValue - 1, c.dayOfMonth).show()
        }
        fromBtn.setOnClickListener { pick(from) { d -> from = d } }
        toBtn.setOnClickListener { pick(to) { d -> to = d } }
        controls.addView(fromBtn, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        controls.addView(toBtn, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
            leftMargin = dp(8)
        })
        root.addView(controls)

        // кнопки: Отправить / Другой файл
        val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val sendBtn = Button(this).apply {
            text = "Отправить"
            setOnClickListener { sendReport(this) }
        }
        val otherBtn = Button(this).apply {
            text = "Другой файл"
            isAllCaps = false
            setOnClickListener { pickFile() } // как в оригинале: сразу выбор файла
        }
        actions.addView(sendBtn, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        actions.addView(otherBtn, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
            leftMargin = dp(8)
        })
        root.addView(actions)

        // таблица: без Er-колонок, шапка и «Итого» закреплены
        val rows = filtered()
        val names = a.names.drop(1).filter { !K20.isFlagCol(it) }
        val headTexts = listOf("Дата") + names
        val cellTexts = rows.map { r ->
            listOf(K20.fmtD(r.date)) + names.map { n -> fmtN(Round.rep(n, r.vals[n] as? Double)) }
        }
        val totalTexts =
            if (rows.isEmpty()) emptyList()
            else listOf("Итого:") + names.map { n -> fmtN(Round.total(rows, n)) }

        val paint = text("0", 13f).paint
        val colW = IntArray(headTexts.size) { c ->
            var w = paint.measureText(headTexts[c])
            for (row in cellTexts) w = maxOf(w, paint.measureText(row[c]))
            if (totalTexts.isNotEmpty()) w = maxOf(w, paint.measureText(totalTexts[c]))
            w.toInt() + dp(20)
        }

        fun rowView(items: List<String>, bold: Boolean): LinearLayout {
            val l = LinearLayout(this)
            for ((c, s) in items.withIndex()) {
                l.addView(text(s, 13f, bold).apply {
                    gravity = if (c == 0) Gravity.START else Gravity.END
                    setPadding(dp(4), dp(6), dp(4), dp(6))
                }, LinearLayout.LayoutParams(colW[c], ViewGroup.LayoutParams.WRAP_CONTENT))
            }
            return l
        }

        // крупный итог по последней колонке (Q1под) — ровно то же значение,
        // что в «Итого» последней колонки таблицы: берём из той же строки
        if (totalTexts.isNotEmpty()) {
            root.addView(
                text(headTexts.last() + "  " + totalTexts.last(), 26f, bold = true).apply {
                    setPadding(0, dp(10), 0, dp(2))
                },
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
                ),
            )
        }

        val tableCol = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        tableCol.addView(rowView(headTexts, bold = true))
        val body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        for ((i, row) in cellTexts.withIndex()) {
            val v = rowView(row, bold = false)
            if (i % 2 == 1) v.setBackgroundColor(0x14808080)
            body.addView(v)
        }
        tableCol.addView(ScrollView(this).apply { addView(body) },
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, 0, 1f))
        if (totalTexts.isNotEmpty()) tableCol.addView(rowView(totalTexts, bold = true))

        root.addView(HorizontalScrollView(this).apply {
            isFillViewport = true
            addView(tableCol)
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f).apply {
            topMargin = dp(6)
        })

        setContentView(root)
    }

    // ---------------------------------------------------------------- отправка
    private fun sendReport(btn: Button) {
        val a = arc ?: return
        val f = from ?: return
        val t = to ?: return
        val rows = filtered()
        btn.isEnabled = false
        Thread {
            var okMsg: String? = null
            var errMsg: String? = null
            try {
                val rp = ReportBuilder.build(rows, a.names.drop(1), a.meta, f, t, Config.SEND_ADDRESS)
                val bytes = Xlsx.write(rp)
                val conn = URL(Config.SEND_URL).openConnection() as HttpURLConnection
                conn.requestMethod = "POST"
                conn.doOutput = true
                conn.connectTimeout = 20000
                conn.readTimeout = 60000
                conn.setRequestProperty("Content-Type", "application/octet-stream")
                conn.setRequestProperty("X-Filename", encodeURIComponent(rp.fname))
                conn.setRequestProperty("X-Address", encodeURIComponent(Config.SEND_ADDRESS))
                conn.outputStream.use { it.write(bytes) }
                val code = conn.responseCode
                val body = try {
                    (if (code in 200..299) conn.inputStream else conn.errorStream)
                        ?.bufferedReader()?.readText() ?: ""
                } catch (_: Exception) { "" }
                conn.disconnect()
                val ans = try { JSONObject(body) } catch (_: Exception) { JSONObject() }
                if (code in 200..299 && ans.optBoolean("ok"))
                    okMsg = "Письмо отправлено:\n" + rp.fname
                else
                    errMsg = ans.optString("error").ifEmpty { "HTTP $code" }
            } catch (e: Exception) {
                errMsg = e.message ?: e.toString()
            }
            ui.post {
                btn.isEnabled = true
                if (okMsg != null) {
                    prefSet("lastExportTo:" + a.meta.serial, t.toString())
                    alert(okMsg)
                } else {
                    alert("Не удалось отправить: $errMsg")
                }
            }
        }.start()
    }
}
