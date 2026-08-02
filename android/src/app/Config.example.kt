package ru.karat.k20viewer

/**
 * Шаблон. Скопировать в Config.kt и подставить значения из .env / config.js:
 *   SEND_URL     ← YC_SEND_URL   (ссылка вызова Yandex Cloud Function)
 *   SEND_ADDRESS ← MAIL_ADDRESS  (адрес объекта, например «Ленина_12»)
 * Config.kt в git не попадает (см. .gitignore) — как и config.js веб-версии.
 */
object Config {
    const val SEND_URL = "https://functions.yandexcloud.net/XXXXXXXXXXXXXXXXXXXX"
    const val SEND_ADDRESS = "Адрес_объекта"
}
