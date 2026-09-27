# Как помочь Гамбитику

Спасибо, что хотите помочь! Гамбитик учит шахматам детей 7–10 лет, поэтому у проекта несколько строгих правил
(ниже). Всё остальное — как в любом проекте на GitHub. English summary — [в конце](#english).

## Первый вклад: fork → ветка → pull request

Если вы раньше не делали pull request, вот весь путь:

1. **Fork.** Нажмите «Fork» вверху страницы репозитория — у вас появится своя копия.
2. **Склонируйте свою копию** и создайте ветку под одну задачу:
   ```bash
   git clone https://github.com/<ваш-ник>/gambitik.git
   cd gambitik
   git checkout -b fix-puzzle-hint
   ```
3. **Внесите изменения** и проверьте их (см. «Что должно проходить»).
4. **Закоммитьте и отправьте** ветку в свою копию:
   ```bash
   git add <изменённые файлы>
   git commit -m "Fix the hint arrow in puzzles after a wrong move"
   git push -u origin fix-puzzle-hint
   ```
5. **Откройте pull request.** GitHub сам предложит «Compare & pull request». Заполните шаблон: что и зачем
   изменено, как проверено.
6. **Ревью.** Автоматические проверки (CI) запустятся сами. Мейнтейнер
   ([@artemiimillier](https://github.com/artemiimillier)) прочитает PR, может попросить поправки. **Сливает PR
   только мейнтейнер.**

Для большой задачи (новый экран, новый режим, изменение модели урока) сначала откройте issue и обсудите идею —
так вы не потратите время на то, что не подойдёт проекту.

## Установка для разработки

Нужны **Node.js 26+** и **pnpm 11** (`npm install --global pnpm@11.5.2` или `corepack enable`, если corepack
есть в вашей сборке Node).

```bash
pnpm install
pnpm dev          # http://localhost:5173 (API на 127.0.0.1:8787)
```

Ключи API не нужны: по умолчанию `GAMBIT_RUNTIME_AI=0`, `LLM_PROVIDER=template`, `GAMBIT_CLIP_GEN=0`.
Подробности — [README](README.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Что должно проходить

Перед pull request запустите:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Если вы меняли интерфейс (экраны, доску, маскота, поведение партии), запустите и сквозные тесты:

```bash
pnpm exec playwright install chromium   # один раз
pnpm e2e
```

CI запускает всё это на каждый pull request; PR с красным CI не сливается. Новое поведение — с тестом
(Vitest рядом с кодом, `*.test.ts`).

Правила кода: TypeScript только со «стираемым» синтаксисом (без `enum`, `namespace`, параметров-свойств),
относительные импорты с расширением `.ts`/`.tsx` — Node 26 запускает исходники напрямую.

## Коммиты

Заголовок — по-английски, простым предложением, без префиксов вроде `feat:`; повелительное наклонение или
описание того, что стало: «Fix the clock pausing while the coach speaks», «Open registration without an invite
code». Одна мысль — один коммит. В теле можно объяснить «почему».

## Тексты для детей

Всё, что говорит или пишет Гамбитик, читают и слушают дети 7–10 лет. Главный документ — [docs/TEACHING.md](docs/TEACHING.md);
формулировки лежат в `packages/content/src/teaching/`, правила проверяет линтер `packages/core/src/coach/lesson/lint.ts`
(его запускает `pnpm test`; отдельно — `node tools/teaching/lintLines.ts`). Коротко:

- **Гамбитик не называет клетки.** В словах нет латиницы, цифр, названий клеток и вертикалей по букве («е4», «на
  эф три» — нельзя). Он говорит, *зачем* ход и *какая фигура*; куда — показывают стрелка и подсветка.
- **Гамбитик — мальчик** (он говорит о себе в мужском роде). Обращение к ребёнку по роду — только через
  плейсхолдер `{g:…}`.
- **Никакого пустого «молодец».** Хвалим только за дело и конкретно: что именно получилось и почему это хорошо.
- **Ошибку объясняем правилом**, а не упрёком. Тон добрый, спокойный, без сарказма, страшилок и сравнения с
  другими детьми.
- **Коротко и по возрасту:** одно предложение — одна мысль; лимиты длины и словарь ступеней (слово «связка» не
  раньше 3-й ступени и т. п.) — в TEACHING.md §2.10 и §4.2.
- **Шахматная правда:** всё, что тренер утверждает о позиции (угроза, «лучший ход», вопрос с кнопками), должно
  подтверждаться движком — см. §6 TEACHING.md.

Нашли неудачную фразу, но не хотите писать код? Откройте issue по шаблону «Текст урока».

## Решения, которые не обсуждаются в PR

- **Никакого генеративного ИИ в партии ребёнка.** Ходы и оценки — только Stockfish, все слова — заранее
  написанные и проверенные тестами. Это осознанное решение проекта, а не временное ограничение. Код за флагом
  `GAMBIT_RUNTIME_AI` остаётся выключенным по умолчанию; PR, которые включают его, добавляют вызовы LLM,
  генерацию речи или распознавание голоса в детскую партию, не принимаются.
- **Никакой рекламы, трекинга и аналитики.** Никаких счётчиков, пикселей, сторонних скриптов, «телеметрии»,
  сторонних шрифтов и CDN в рантайме.
- **Приватность детей.** Не добавляйте сбор личных данных: почты, настоящих имён, телефонов, геолокации, фото,
  записей голоса, IP-адресов в базе. Аккаунты публичного сайта — ник и пароль, и так должно остаться. Любое
  новое поле о ребёнке нужно обосновать в issue до PR.
- **Никаких секретов в репозитории.** Ключи — только в `.env` (он в `.gitignore`).

## Небольшие и понятные PR

- Один PR — одна задача. Лучше три маленьких PR, чем один огромный.
- Не смешивайте рефакторинг, форматирование и изменение поведения.
- Для изменений интерфейса приложите скриншот «было / стало».
- Не обновляйте зависимости «заодно» — это делает Dependabot отдельными PR.

## Метки issues

| Метка | Что значит |
|---|---|
| `bug` | что-то работает не так |
| `enhancement` | идея новой функции или улучшения |
| `lesson-content` | тексты тренера: ошибки, неудачные фразы, предложения |
| `good first issue` | хорошая задача для первого вклада |
| `help wanted` | мейнтейнер будет рад помощи |
| `needs-triage` | новое, мейнтейнер ещё не посмотрел |
| `question` | вопрос, а не задача |
| `wontfix` / `duplicate` | не будет сделано / уже есть |

Метки ставит мейнтейнер; шаблоны issues ставят первую метку сами.

## Безопасность и поведение

- Уязвимости — **не** в открытых issues, а приватно: [SECURITY.md](SECURITY.md).
- Правила общения — [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Лицензия вклада

Отправляя pull request, вы соглашаетесь, что ваш вклад распространяется по лицензии проекта —
[AGPL-3.0-or-later](LICENSE). Не добавляйте чужой код, картинки, звуки или тексты, если их лицензия несовместима
с AGPL; новые сторонние компоненты указывайте в [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Записи голоса
в `apps/web/public/voice/` не под AGPL — не заменяйте и не добавляйте туда аудио без согласования.

---

## English

Thanks for helping! Short version:

1. **Fork** the repo, create a **branch** for one change, open a **pull request** and fill in the template. CI must
   be green; **only the maintainer ([@artemiimillier](https://github.com/artemiimillier)) merges**. For big changes
   open an issue first.
2. **Setup:** Node 26+, pnpm 11 (`npm install --global pnpm@11.5.2`), `pnpm install`, `pnpm dev` →
   <http://localhost:5173>. No API keys needed.
3. **Must pass:** `pnpm typecheck`, `pnpm test`, `pnpm build`; for UI changes also `pnpm e2e`
   (after `pnpm exec playwright install chromium`).
4. **Commits:** plain English subject lines, imperative or descriptive ("Fix the hint arrow in puzzles"), no
   `feat:`-style prefixes.
5. **Child-facing texts** (Russian, ages 7–10) follow [docs/TEACHING.md](docs/TEACHING.md) and the lint in
   `packages/core/src/coach/lesson/lint.ts`: no square names or Latin notation in spoken lines, the mascot is a boy,
   no empty praise ("молодец"), explain mistakes with a rule, kind tone, age-appropriate vocabulary per stage.
6. **Non-negotiable:** no generative AI at runtime in the child's game (design decision); no ads, tracking or
   analytics; never add collection of children's personal data; no secrets in the repo.
7. **Keep PRs small and focused**; include before/after screenshots for UI changes.
8. **Security issues** go through private reporting ([SECURITY.md](SECURITY.md)), not public issues. Be kind:
   [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

By contributing you agree that your contribution is licensed under [AGPL-3.0-or-later](LICENSE).
