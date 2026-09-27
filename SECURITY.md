# Security policy / Политика безопасности

## Как сообщить об уязвимости

**Не открывайте публичный issue.** Сообщайте приватно через GitHub:

1. Откройте вкладку **Security** этого репозитория.
2. Нажмите **Report a vulnerability** (private vulnerability reporting).
3. Опишите проблему: что можно сделать, как воспроизвести, какая версия (коммит), что под угрозой.

Сообщение увидит только мейнтейнер ([@artemiimillier](https://github.com/artemiimillier)). Мы постараемся
ответить в течение 7 дней и договоримся о сроке исправления и публикации. Пожалуйста, не раскрывайте детали
публично, пока исправление не выпущено.

## Что входит

- **Код этого репозитория**: веб-приложение (`apps/web`), сервер (`apps/server`), пакеты, инструменты,
  `Dockerfile` и примеры выкладки (`deploy/`).
- **Публичный экземпляр**, который работает на этом коде. Проверяйте только на **своём** аккаунте; не
  трогайте чужие аккаунты и данные, не устраивайте нагрузочных атак и не пытайтесь угадывать пароли.

**Особенно важно всё, что касается детей и их данных:** доступ к чужому аккаунту или партиям, утечка ников,
журналов партий или других данных учеников, обход входа, сессий или ограничения попыток, способ заставить
приложение собирать или отправлять данные наружу, способ показать ребёнку чужой или вредный контент.

Не считаются уязвимостями: отчёты автоматических сканеров без доказанного влияния, отсутствие необязательных
заголовков без сценария атаки, уязвимости в зависимостях, которые не затрагивают этот проект (о них
заботится Dependabot).

## Поддерживаемые версии

Поддерживается только ветка **`main`** (последний коммит). Исправления выходят в `main`; отдельных
релизных веток нет.

---

## English

**Please do not report security issues in public issues.** Use GitHub private vulnerability reporting: the
repository's **Security** tab → **Report a vulnerability**. Only the maintainer
([@artemiimillier](https://github.com/artemiimillier)) can see the report; we aim to respond within 7 days and
will agree on a fix and disclosure timeline with you.

**Scope:** the code in this repository (web app, server, packages, tools, `Dockerfile`, `deploy/`) and the
public instance running it — test only with your own account, never access other users' data, no load or
brute-force testing. Anything that exposes **children's data** (other students' accounts, games, nicknames,
journals), bypasses sign-in, sessions or rate limits, or makes the app collect or send data elsewhere is the
highest priority.

**Supported version:** only the `main` branch (latest commit).
