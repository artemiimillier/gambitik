# 03. Голосовой тренер: OpenAI realtime speech-to-speech (состояние на 21.09.2026)

> Исследование для проекта «шахматный тренер для ребёнка». Версии, цены, id моделей и имена событий — по официальной документации OpenAI (`developers.openai.com`, markdown-версии страниц), `npm view`, `gh api` и `.d.ts` установленных пакетов; запросы к `api.openai.com` не выполнялись. Непроверенное помечено «(не проверено)» / **НЕ ПРОВЕРЕНО**.

---

## 0. Главное за 2 минуты

1. **Два голосовых API.** У OpenAI ДВА разных голосовых API:
   - **GPT-Live** (`gpt-live-1`, GA с **10.09.2026**, эндпоинт `/v1/live/sessions`) — настоящий **full-duplex** («слушает и говорит одновременно»), голосовая «оболочка», которая сама почти не думает и **делегирует** рассуждения/инструменты отдельному backend'у (Responses-модель OpenAI или *ваш собственный* код). Цена — **$0.05/мин**, посекундно, включая тишину. Документация OpenAI теперь прямо говорит: «для нового разговорного голосового приложения начинайте с GPT-Live».
   - **Realtime API** (`gpt-realtime-2.1`, `gpt-realtime-2.1-mini`, эндпоинт `/v1/realtime`) — классическая speech-to-speech модель «всё в одном»: сама слышит, рассуждает (настраиваемый `reasoning.effort`), сама вызывает function tools, говорит. Оплата по токенам, **тишина бесплатна** (VAD отсекает). Зрелая, есть ephemeral-ключи для браузера, поддержана в Agents SDK.
2. **ChatGPT/Codex-подписка голос НЕ покрывает.** Ни `/v1/realtime`, ни `/v1/live/sessions`, ни TTS/STT по OAuth-токену Codex не работают — нужен обычный API-ключ платформы и предоплата (минимум $5 → Tier 1). Вход в Codex через ChatGPT (`codex login status`) — это вход по подписке, а не по API-ключу; для голоса нужен отдельный `OPENAI_API_KEY`. Зато **«мозг» можно оставить на подписке**: GPT-Live в режиме *client delegation* и наша собственная архитектура позволяют генерировать текст реплик тренера чем угодно (в т.ч. `codex exec`), а API платить только за «рот и уши».
3. **Рекомендуемая архитектура — «мозг в приложении, голос — сменный слой».** Движок (Stockfish) + текстовый LLM формируют *что сказать* и *какие стрелки показать*; голосовой слой только озвучивает и слушает. Тогда один и тот же код работает с четырьмя бэкендами голоса: `gpt-realtime-2.1(-mini)` → `gpt-live-1` → `gpt-4o-mini-tts` → браузерный `speechSynthesis`.
4. **Стартовый выбор:** Realtime API + `gpt-realtime-2.1` (для экономии — `gpt-realtime-2.1-mini`), WebRTC из браузера, ephemeral client secret с маленького локального сервера. Через 1–2 недели — A/B-прослушивание `gpt-live-1` на русском; если русский звучит хорошо — переход на GPT-Live как основной (он точнее соответствует требованию «слушает и говорит одновременно»).
   > **ВНИМАНИЕ:** id модели Realtime обязан быть **настройкой, а не константой**. На форуме разработчиков OpenAI с 15.07.2026 открыт воспроизводимый баг без ответа OpenAI — **«GPT Realtime 2.1 exhibits language drift»**: на НЕанглийских языках (исп., нем., фр., порт., дат.) `gpt-realtime-2.1` и особенно `-2.1-mini` сползают в английский акцент или целиком на английский даже при промпте на целевом языке; авторы пишут, что `gpt-realtime-2` и `gpt-realtime-1.5` ведут себя заметно стабильнее. Про русский там данных нет, но риск прямой. Поэтому **до выбора модели** слушаем по-русски три модели: `gpt-realtime-2.1`, `gpt-realtime-2` (цена та же, тоже reasoning) и `gpt-realtime-1.5` (не-reasoning, 32k) — и стартуем на той, что держит русский. `-2.1-mini` как «экономный режим» считать **не подтверждённым** для русского до теста. Подробности — §6 и §14.
5. **Стоимость 10 минут сессии:** `gpt-realtime-2.1` ≈ **$0.5–1.0**, `gpt-realtime-2.1-mini` ≈ **$0.15–0.30**, `gpt-live-1` ≈ **$0.50 + backend ($0.01–0.15)**, цепочка «текстовый LLM + `gpt-4o-mini-tts`» ≈ **$0.04–0.06**, `speechSynthesis` — **$0**.
6. **Ребёнок до 13 лет — серьёзное ограничение политики.** Официальный «Under-18 guidance» OpenAI: *нельзя обрабатывать персональные данные детей до 13 лет без включённого Zero Data Retention (ZDR)*; ZDR выдаётся по одобрению OpenAI. Голос ребёнка — персональные данные. См. раздел 11 — там практичные смягчения (push-to-talk, без имени/ПДн в промптах, локальный STT, родитель рядом).
7. **Русские голоса:** ни в Realtime (10 голосов), ни в GPT-Live (22 голоса) нет «родных» русских — все оптимизированы под английский (в GPT-Live есть ещё португальские). Русский поддерживается, но возможен лёгкий акцент. Качество русского у `gpt-live-1` — **НЕ ПРОВЕРЕНО** (официального списка языков нет). Нужен тест на слух до выбора.

---

## 1. Модели (точные id)

### 1.1. Голосовые (разговорные)

| Модель (id) | API / эндпоинт | Что это | Контекст | Цена | Статус |
|---|---|---|---|---|---|
| **`gpt-live-1`** | Live: `POST/WSS /v1/live/sessions` | Full-duplex голосовая модель; рассуждения и tools делегирует backend'у. Вход: audio+text, выход: audio+text. Knowledge cutoff 31.07.2025 | 128k (авто-сжатие истории при >90%) | **$0.05/мин**, посекундно, без округления до минуты; backend отдельно | GA 10.09.2026 |
| **`gpt-realtime-2.1`** | Realtime: `/v1/realtime` (WebRTC/WebSocket/SIP) | Speech-to-speech reasoning-модель с tools; улучшены распознавание букв/цифр, тишина/шум, перебивания. Вход: text+audio+image. Cutoff 30.09.2024 | 128k, до 32k output | audio $32 / cached $0.40 / out $64; text $4 / $0.40 / $24; image $5 / $0.50 за 1M | релиз 06.07.2026 |
| **`gpt-realtime-2.1-mini`** | Realtime | Дистиллированная быстрая/дешёвая версия | 128k | audio $10 / $0.30 / $20; text $0.60 / $0.06 / $2.40 | релиз 06.07.2026 |
| `gpt-realtime-2` | Realtime | Первая reasoning-realtime (07.05.2026) | 128k | как у 2.1 | актуальна, но 2.1 лучше |
| `gpt-realtime-1.5` | Realtime | Быстрая НЕ-reasoning s2s | 32k | audio $32/$0.40/$64; text $4/$0.40/$16 | актуальна |
| `gpt-realtime`, `gpt-realtime-mini` | Realtime | Поколение 2025 г. | 32k | см. pricing | **deprecated 20.07.2026, отключение 20.01.2027** (`deprecations`, «Legacy audio, realtime, and transcription models»; замена по доке: `gpt-realtime-2.1` / `-2.1-mini`) — не использовать |
| `gpt-4o-realtime-preview*` | Realtime Beta | — | — | — | **Beta-интерфейс удалён 12.05.2026** |

### 1.2. Вспомогательные (для fallback-цепочки и транскриптов)

| Модель (id) | Назначение | Цена |
|---|---|---|
| **`gpt-4o-mini-tts`** (снапшот `gpt-4o-mini-tts-2025-12-15`) | Text-to-speech, `POST /v1/audio/speech`, 13 голосов, параметр `instructions` (стиль речи), стриминг, лимит 2000 входных токенов. **Преемника нет** — это по-прежнему актуальная TTS-модель | text in $0.60/1M, audio out $12/1M ≈ **$0.015/мин речи** (оценка: ~1200 аудио-токенов/мин) |
| `tts-1` / `tts-1-hd` | Старые TTS | $15 / $30 за 1M символов |
| **`gpt-transcribe`** | STT для файлов (и realtime-входа) | **$0.0045/мин** |
| **`gpt-live-transcribe`** | Потоковый STT с низкой задержкой (поддерживает `languages: ["ru"]`, `keywords`) | **$0.017/мин** |
| `gpt-realtime-whisper` | Потоковый STT | $0.017/мин |
| `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `gpt-4o-transcribe-diarize` | Старые STT | **deprecated 26.08.2026, отключение 26.02.2027** — не закладываться |
| `gpt-realtime-translate` | Потоковый перевод речи | $0.034/мин (нам не нужен) |

### 1.3. Текстовые «мозги» (для backend'а/делегирования)

| id | Цена (input / cached / output за 1M) | Роль у нас |
|---|---|---|
| `gpt-6-astra` | $10 / $1 / $50 | избыточно |
| `gpt-5.6-sol` | $4 / $0.40 / $20 | разбор партий после игры |
| **`gpt-5.6-terra`** | $2 / $0.20 / $12 | рекомендованный OpenAI backend для GPT-Live |
| **`gpt-5.6-luna`** | $0.20 / $0.02 / $1.20 | дешёвые реплики по ходу партии, guardrail-проверки |

Цены — для short context; для long context тарифы выше.

---

## 2. Три архитектуры и наши требования

| Требование проекта | GPT-Live (`gpt-live-1`) | Realtime API (`gpt-realtime-2.1`) | Цепочка STT → текстовый LLM → TTS |
|---|---|---|---|
| «Слушает и говорит одновременно» | **Да, нативный full-duplex**, бэкчаннелы («угу»), нет turn-детектора | Пошаговые реплики + barge-in (перебивание через VAD) | Нет (push-to-talk / свой VAD) |
| Проактивная реплика по событию приложения («стой, верни ход») | `session.commentary.append` (произнести, перефразируя) / `session.instructions.append` (жёсткая команда, может перебить речь) | `conversation.item.create` (role `system`) + `response.create` | Просто вызвать TTS |
| Тихо подложить контекст (позиция после каждого хода) | `session.thinking.append` (≤500 токенов, не озвучивается) | `conversation.item.create` без `response.create` | В промпт LLM |
| Tools: `get_position_analysis`, `show_arrow`, `highlight_squares`, `take_back_move`, `get_student_profile` | Только в backend'е: Responses delegation (`delegation.responses.tools`, вызовы приходят вложенными `response.event`) **или** client delegation (инструменты вызывает наш код/наш LLM) | **Напрямую у голосовой модели** (`session.tools`), минимальная задержка «сказал → стрелка» | В текстовом LLM |
| Ум при объяснении «почему этот ход лучший» | Backend любой (terra/sol/Codex) — **умнее** | Сама realtime-модель (cutoff 2024, но есть reasoning); обязательно кормить анализом движка | Любой LLM |
| Подключение из браузера | WebRTC, **SDP-обмен только через наш сервер** (ephemeral-ключей нет) | WebRTC с **ephemeral client secret** (`ek_…`) или unified-интерфейс через сервер; WebSocket — альтернатива | HTTP |
| Блокировка «лишних» команд с фронта | `client.data_channel.allowed_client_events / allowed_server_events` | Нет: обладатель `ek_` может слать `session.update` (см. §4.2) | — |
| Тишина (ребёнок думает над ходом) | **Оплачивается** ($0.05/мин всегда) | **Бесплатна** | Бесплатна |
| Зрелость | 11 дней в GA; в Agents SDK JS **нет**; есть в `openai@7.20.0` (`client.live.*`) | Год в GA; `@openai/agents@0.18.0` | Максимальная |
| Русский | **НЕ ПРОВЕРЕНО** (нет офиц. списка языков; сторонние обзоры: «оптимизирован под популярные языки ChatGPT, в части языков неродной акцент») | Работает (мультиязычная), голоса оптимизированы под английский; качество на слух — **НЕ ПРОВЕРЕНО** | TTS-док-ция: русский в списке поддерживаемых; «voices are currently optimized for English» |
| Макс. длительность сессии | есть лимит (`reason: "expired"`, `expires_at` в `session.started`), точное значение **НЕ ПРОВЕРЕНО** | **60 минут** | — |

**Вывод по архитектуре.** Нам в любом случае нужен «мозг в приложении»: проверка зевка движком ДО ответа бота — это детерминированная логика приложения, а не LLM. Поэтому проектируем так:

```
ход ребёнка → Stockfish (eval до/после) → детектор зевка (порог по Δeval, зависит от уровня)
            → CoachBrain (текстовый LLM: gpt-5.6-luna / Codex-подписка) → { say: "...", ui: [show_arrow…], takeBack: true }
            → VoiceLayer.say(text)  ← сменная реализация: Realtime | Live | TTS | speechSynthesis
голос ребёнка → VoiceLayer → (вопрос) → CoachBrain / tools → ответ голосом
```

Голосовой слой получает уже готовую мысль («скажи это тепло, по-русски») — это одинаково ложится и на `conversation.item.create + response.create`, и на `session.commentary.append`, и на TTS.

---

## 3. GPT-Live (`gpt-live-1`) — детали

### 3.1. Подключение

- **Браузер (WebRTC):** браузер создаёт `RTCPeerConnection`, data channel с меткой **`oai-events`**, SDP-offer → наш сервер → `POST https://api.openai.com/v1/live/sessions` (JSON: `{ session: {...}, transport: { type: "webrtc", sdp } }`, обычный API-ключ) → ответ `201 { session: { id: "live_…" }, transport: { type: "webrtc", sdp: "<answer>" } }`. **Не отправлять `session.start` по data channel** — сессию стартует HTTP-запрос; ждать `session.started`.
- **Сервер (WebSocket):** `wss://api.openai.com/v1/live/sessions`, заголовок `Authorization: Bearer …`, первым сообщением `session.start`; аудио — `session.input_audio.append` / `session.output_audio.delta` (PCM16 16/24 кГц, G.711).
- **Sideband** (сервер наблюдает/управляет браузерной WebRTC-сессией): `wss://api.openai.com/v1/live/sessions/{session_id}/attach`.
- Fork/возобновление: `POST /v1/live/sessions/{id}/fork` (нужен `store: true`; при ZDR недоступно). Запись: `GET /v1/live/sessions/{id}/content` (стерео WAV).
- SDK: `openai@7.20.0` — `client.live.create(...)`, `client.live.sessions.fork/hangup/downloadRecording`, классы `LiveWS`, `SidebandWS` (проверено в установленном пакете). Пример сервера в доке требует Node ≥ 22.6.
- **Биллинг инициализации:** создание WebRTC-сессии сразу списывает 15 с (засчитываются в длительность).

### 3.2. Конфигурация сессии (всё задаётся при старте, почти всё неизменяемо)

| Поле | Значение |
|---|---|
| `model` | `"gpt-live-1"` (обязательно) |
| `instructions` | до 16 384 токенов; **только стиль речи + политика делегирования**. Рекомендуемые заголовки: `Backchannel policy`, `Interruption policy`, `Delegation policy` (`Backend tools` / `Delegate to the backend when` / `Do not delegate…`). Промпт и примеры писать **на языке, на котором должен говорить ассистент** |
| `input` | стартовая текстовая история: до 128 сообщений / 8 192 токена, роли `developer`/`user`/`assistant` (сюда — профиль ученика, итог прошлой партии) |
| `audio.output.voice` | по умолчанию `marin`; менять нельзя после старта |
| `delegation` | `{type:"client"}` (по умолчанию) или `{type:"responses", responses:{ model, instructions, tools:[function|web_search], tool_choice, parallel_tool_calls, reasoning:{effort}, text:{verbosity}, max_output_tokens, service_tier }}`. Сменить режим = новая сессия |
| `client.data_channel` | `allowed_client_events`, `allowed_server_events` — права недоверенного фронта |
| `store` | `false` по умолчанию (для ребёнка — оставить `false`) |

Параметров VAD/turn detection/noise reduction/input transcription **нет** — модель сама решает, когда говорить; транскрипты приходят всегда (`session.input_transcript.delta`, `session.output_transcript.delta` с `start_ms/end_ms`; события «конец реплики» нет — группируем сами).

### 3.3. События (полный список из reference)

**Клиент →** `session.start` (только WS), `session.update` (только настройки `delegation.responses`), `session.input_audio.append` (только WS), `session.input_audio.mute` / `unmute`, **`session.instructions.append`**, **`session.thinking.append`**, **`session.commentary.append`**, `response.item.create`, `response.create`, `session.close`.

**Сервер →** `session.started`, `session.updated`, `session.input_audio.muted/unmuted`, `session.instructions.appended`, `session.thinking.appended`, `session.commentary.appended` (сопоставлять по `client_event_id`), `session.output_audio.delta` (WS), `session.input_transcript.delta`, `session.output_transcript.delta`, **`session.delegation.created`**, **`response.event`** (конверт с вложенными событиями Responses), `session.usage.updated` (`usage.seconds`, `context_window.usage_ratio`), `session.closed` (`reason`: `close_requested | expired | content | remote_hangup | connection_lost`), `error`, а также `info` и телефонные `transport.*` (`transport.dtmf.received/send`, `transport.ringing`, `transport.answered`, `transport.failed`) — нам не нужны, но парсер событий не должен на них падать.

### 3.4. Три способа «впрыснуть» событие приложения (ключевое для тренера)

| Событие | Как модель использует | Наш случай |
|---|---|---|
| `session.instructions.append` | Доверенная инструкция; **может перебить текущую речь**; для приветствия, точных формулировок, guardrail-разворота | «Немедленно скажи по-русски: „Стоп-стоп! Давай вернём ход и подумаем ещё раз“. Потом замолчи и слушай.» |
| `session.thinking.append` | Тихий фактический контекст, не озвучивается сразу | После каждого хода: «Ход 12: белые (ученик) Сf4. Оценка +0.3. Угроз нет.» |
| `session.commentary.append` | Текст, который надо **произнести** (модель перефразирует) | Готовая реплика от CoachBrain: «Конь на f3 под ударом пешки e4 — посмотри, кто его защищает?» |

Все три: `content` — строка ≤ **500 токенов**, обязательное поле `delegation_id` (`null` — общий контекст сессии). Подтверждение приходит, когда контекст «доехал» до модели, а не когда речь сыграна.

### 3.5. Tools в GPT-Live

- **Responses delegation:** описываем функции в `delegation.responses.tools` (схема Responses). Когда голосовая модель делегирует — приходит `session.delegation.created {target:"responses"}`; вызовы функций читаем из вложенных `response.event → event.type === "response.output_item.done"` (в `item`: `call_id`, `name`, `arguments`); результат — `response.item.create { item: { type:"function_call_output", call_id, output } }`, затем **обязательно** `response.create`. (В `response.completed` массив `output` пустой — читать именно item-события.)
- **Client delegation:** приходит только `session.delegation.created {target:"client", delegation.id, offset_ms}` — **без текста запроса**. Приложение само собирает контекст из транскриптов + состояния доски, запускает свой backend (любой LLM, `codex exec`, Stockfish) и возвращает `session.commentary.append` с тем же `delegation_id`.
- Картинки фронт-модель не принимает (только backend).

### 3.6. Голоса GPT-Live (22 встроенных)

`alloy, ash, ballad, beacon, bossa, cedar, cinder, coral, delta, echo, gleam, marin, meridian, quartz, ripple, sage, shimmer, stone, tempo, verse, vesper, willow` + custom voice (только для «eligible customers» через отдел продаж).
12 новых: Quartz/Ripple (австрал. англ.), Vesper (брит.), Willow/Stone (ирл.), Gleam/Meridian (сев.-амер.), Bossa/Tempo (**португальский**), Beacon (филиппин. англ.), Delta/Cinder (юг США). **Русских нет.** Для русского тестировать в первую очередь: `marin`, `coral`, `gleam`, `shimmer` (женские, тёплые), `cedar`, `meridian` (мужские). Характеристики «молодой/дружелюбный» — субъективны, **НЕ ПРОВЕРЕНО на слух**.

### 3.7. Модерация и «детский» режим

Встроенная модерация может (а) завершить сессию (`reason: "content"`), (б) оборвать текущую реплику с `error`. Рекомендуемый OpenAI паттерн guardrail: следить за `session.input_transcript.delta` / `session.output_transcript.delta` дешёвой моделью (`gpt-5.6-luna`, low effort) → при срабатывании блокировать действия в приложении + `session.instructions.append` с разворотом. Уже услышанное «отозвать» нельзя; для строгой пред-проверки речи нужно буферизовать аудио у себя (дорого по задержке).

---

## 4. Realtime API (`gpt-realtime-2.1`) — детали

### 4.1. Подключение из браузера

**Вариант A — ephemeral client secret (то, что просили):**
1. Сервер: `POST https://api.openai.com/v1/realtime/client_secrets` (обычный ключ; тело `{ expires_after:{anchor:"created_at",seconds:10…7200}, session:{ type:"realtime", … } }`; по умолчанию TTL 600 с) → `{ value: "ek_…", expires_at, session }`. Заголовок `OpenAI-Safety-Identifier: <хэш id пользователя>` ставится здесь и привязывается к токену.
2. Браузер: `RTCPeerConnection` + `getUserMedia` + data channel `oai-events` → `POST https://api.openai.com/v1/realtime/calls` с `Authorization: Bearer ek_…`, `Content-Type: application/sdp`, тело — offer SDP → ответ — answer SDP (в заголовке `Location: /v1/realtime/calls/rtc_…` — id звонка для sideband).

**Вариант B — unified interface:** браузер шлёт SDP на наш сервер, сервер делает multipart `POST /v1/realtime/calls` (`sdp` + `session` JSON) обычным ключом и возвращает answer. Проще, конфигурация не видна фронту, но сервер — в критическом пути.

**WebSocket-альтернатива:** `wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1`; из браузера — подпротоколы `["realtime", "openai-insecure-api-key." + ek]`. OpenAI рекомендует для браузера WebRTC (устойчивее к сети, сервер сам ведёт буфер воспроизведения и авто-усечение при перебивании). **Sideband:** `wss://api.openai.com/v1/realtime?call_id=rtc_…`.

Beta-заголовок `OpenAI-Beta: realtime=v1` больше не нужен (beta удалена 12.05.2026).

### 4.2. Конфигурация сессии (`session`, GA-форма)

```jsonc
{
  "type": "realtime",
  "model": "gpt-realtime-2.1",
  "instructions": "…",                       // системный промпт тренера (по-русски)
  "output_modalities": ["audio"],            // или ["text"]
  "reasoning": { "effort": "low" },          // minimal | low | medium | high | xhigh; старт — low
  "max_output_tokens": 1200,
  "tools": [ /* function | mcp */ ], "tool_choice": "auto", "parallel_tool_calls": true,
  "audio": {
    "input": {
      "format": { "type": "audio/pcm", "rate": 24000 },          // для WebRTC не нужно
      "noise_reduction": { "type": "far_field" },                // near_field — гарнитура; far_field — ноутбук/колонки
      "transcription": { "model": "gpt-live-transcribe", "languages": ["ru"],
                         "keywords": ["ферзь","ладья","рокировка","вилка","связка","цугцванг"] },
      "turn_detection": { "type": "semantic_vad", "eagerness": "low",
                          "create_response": true, "interrupt_response": true }
    },
    "output": { "voice": "marin", "speed": 1.0 }                  // speed 0.25–1.5
  },
  "truncation": { "type": "retention_ratio", "retention_ratio": 0.8,
                  "token_limits": { "post_instructions": 8000 } }
  // поле "prompt": { "id": "pmpt_…" } (хранимый промпт) в схеме ещё есть, но НЕ использовать:
  // reusable prompts объявлены deprecated 03.06.2026, `v1/prompts` отключается 30.11.2026 — промпт держим в коде.
}
```

- `turn_detection` типа `server_vad` имеет ещё поле `idle_timeout_ms` (авто-реплика модели после долгой паузы, «для телефонных звонков»). Для шахмат долгие паузы — норма, поэтому **оставлять `null`/не задавать**, иначе тренер будет дёргать думающего ребёнка.

- `voice` нельзя менять после первой аудио-реплики. Остальное — `session.update` в любой момент.
- **Внимание:** конфигурацию, привязанную к `ek_`, клиент *может переопределить* (`session.update` с фронта). Для домашнего приложения это приемлемо; если важно — вариант B + sideband, tools исполнять на сервере.
- Макс. длительность сессии — **60 минут** → на длинных занятиях переподключаться (между партиями), передавая краткое резюме в `instructions`/первый item.

### 4.3. Голоса Realtime

`alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar`. OpenAI: «For best quality — `marin` или `cedar`». Детского голоса нет; «молодость» достигается промптом («говори как весёлый старшеклассник-наставник, энергично, короткими фразами») и `speed` ≈ 1.05–1.1. Custom voices — только по согласованию с sales. Субъективно (**НЕ ПРОВЕРЕНО на слух, по общим описаниям**): `coral`/`shimmer` — тёплые дружелюбные женские, `marin` — самый естественный женский, `cedar` — спокойный мужской, `ballad`/`verse` — экспрессивные.

### 4.4. Turn detection, перебивание, push-to-talk

- `server_vad` (по тишине: `threshold`, `prefix_padding_ms` = 300, `silence_duration_ms` = 500) — дефолт. `semantic_vad` (`eagerness: low|medium|high|auto`; максимальное ожидание 8/4/2 с для low/medium/high) — ждёт смыслового конца фразы; для ребёнка, который думает вслух с паузами, брать **`eagerness: "low"`**.
- `interrupt_response: true` — barge-in: при `input_audio_buffer.speech_started` текущий ответ отменяется; по WebRTC сервер сам усекает несыгранное аудио; вручную — `response.cancel` + `output_audio_buffer.clear` (WebRTC) / `conversation.item.truncate` (WS).
- `create_response:false, interrupt_response:false` — VAD режет реплики, но отвечает модель только по нашему `response.create` (удобно, когда ответ надо сначала «заземлить» на движок).
- Push-to-talk: `turn_detection: null` → `input_audio_buffer.clear` при нажатии → `input_audio_buffer.commit` + `response.create` при отпускании. **Рекомендуется как режим по умолчанию при игре через колонки** (см. §7) и как privacy-мера для ребёнка.
- Паттерн «молчи, если не к тебе»: no-op tool `wait_for_user` + инструкция вызывать его на шум/ТВ/разговор в комнате (официальная рекомендация из prompting guide).

### 4.5. Function calling

1. `session.tools` (или `response.tools` на один ответ): `{ type:"function", name, description, parameters: JSONSchema }`.
2. Модель выдаёт `response.function_call_arguments.delta/done`, итог — в `response.output_item.done` / `response.done` → `output[i] = { type:"function_call", name, call_id, arguments }`.
3. Клиент исполняет → `conversation.item.create { item:{ type:"function_call_output", call_id, output:"<json-строка>" } }` → `response.create`.
4. У `gpt-realtime-2.x` ответ может иметь фазы: `response.output[i].phase = "commentary"` (преамбула «сейчас посмотрю…» + tool calls) и `"final_answer"`.
5. MCP-tools (`type:"mcp"`, `server_url`) тоже поддерживаются — нам не нужны.

### 4.6. Впрыск событий приложения и проактивная речь

```js
// тихий контекст (не вызывает ответа)
dc.send(JSON.stringify({ type:"conversation.item.create",
  item:{ type:"message", role:"system", content:[{ type:"input_text", text:"[СОБЫТИЕ] Ход 12: ученик сыграл Фd2. Оценка упала с +0.4 до −3.1: ферзь под вилкой Кe4." }] } }));
// заставить заговорить прямо сейчас
dc.send(JSON.stringify({ type:"response.create",
  response:{ instructions:"Мягко останови ученика: попроси вернуть ход и подумать ещё раз. Не называй правильный ход, дай одну подсказку-вопрос. 1–2 предложения." } }));
```

Нюанс: если модель в этот момент уже говорит, второй `response.create` вернёт ошибку активного ответа — сначала `response.cancel` (+ `output_audio_buffer.clear`) либо дождаться `response.done`. (Поведение известно по GA-API; точный код ошибки — **НЕ ПРОВЕРЕНО** в текущей доке.)

### 4.7. Out-of-band ответы

`response.create` с `response.conversation: "none"` — ответ НЕ попадает в историю; можно задать `metadata` (чтобы отличить в `response.done`), `output_modalities:["text"]`, собственный `input` (в т.ч. `{type:"item_reference", id}`), а `input: []` — ответ «без контекста» («скажи ровно это»). Применения у нас: (а) тихая классификация «ребёнок задал вопрос про позицию / болтает / расстроен»; (б) текстовая запись «мысли ученика» в журнал (markdown) без озвучки; (в) короткая дословная фраза без влияния истории.

### 4.8. Входная транскрипция

`audio.input.transcription` — асинхронный отдельный STT (биллинг отдельно); поля `model`, `languages`, `keywords`, `prompt`, `delay`. События: `conversation.item.input_audio_transcription.delta` / `.completed` (с `usage`). Модели: `gpt-live-transcribe` (рекомендую; `languages:["ru"]`, `keywords`), `gpt-transcribe`, `gpt-realtime-whisper`; старые `whisper-1`/`gpt-4o-*-transcribe` deprecated. Транскрипт ответа тренера: `response.output_audio_transcript.delta/done`. Это и есть источник для журналов «что говорил ребёнок / что ответил тренер».

> **Оговорка:** схема `session.audio.input.transcription.model` для сессии `type:"realtime"` действительно перечисляет `gpt-live-transcribe` (и Agents SDK 0.18.0 его типизирует), но на странице модели `gpt-live-transcribe` в таблице эндпоинтов стоит «Realtime `v1/realtime` — Not supported; Realtime transcription — Supported». Документация противоречит сама себе; живым запросом не проверено. Если `session.update`/`client_secrets` отклонит эту модель — запасной вариант для WebRTC: `gpt-realtime-whisper` (без `prompt`, без `languages`); `gpt-transcribe` внутри Realtime-сессии гайд описывает как «специализированный сценарий, требующий WebSocket». Журнал не должен зависеть от конкретной STT-модели.

---

## 5. OpenAI Agents SDK для JS

| Пакет | Версия (npm, 21.09.2026) | Лицензия | Примечание |
|---|---|---|---|
| `@openai/agents` | **0.18.0** (опубл. 10.09.2026) | MIT | реэкспортирует realtime: `import … from "@openai/agents/realtime"` |
| `@openai/agents-realtime` | **0.18.0** | MIT | deps: `@openai/agents-core@0.18.0`, `ws@^8.21`; peer `zod@^4` |
| `openai` | **7.20.0** (19.09.2026) | Apache-2.0 | содержит `client.live.*`, `client.realtime.*` |
| репозиторий `openai/openai-agents-js` | 3 837 ★, push 21.09.2026 | MIT | релизы почти еженедельно, всё ещё 0.x → ломающие изменения возможны |

- **Рекомендован ли?** Да — для **Realtime API**: официальный «Getting started with the Realtime API» начинается именно с `RealtimeAgent` + `RealtimeSession` (в браузере автоматически WebRTC, микрофон и воспроизведение настраиваются сами; tools через `tool({ parameters: z.object(...) , execute })`; есть guardrails по транскрипту, `tool_approval_requested`, `history_updated`, `session.interrupt()`, `session.mute()`, `session.sendMessage()`, `session.transport.sendEvent(rawEvent)`). Типы моделей в 0.18.0: `'gpt-realtime-2.1' | 'gpt-realtime-2.1-mini' | 'gpt-realtime-2' | …`.
- **GPT-Live SDK НЕ поддерживает** (в коде 0.18.0 упоминается лишь `gpt-live-transcribe`). Для Live — `openai@7.20.0` на сервере + «голый» WebRTC в браузере.
- **Вывод для проекта:** наш поток управления нестандартный (события движка важнее реплик пользователя, сменный голосовой слой), SDK на 0.x. Поэтому — **тонкий собственный клиент на сыром WebRTC (~150 строк)** за интерфейсом `VoiceLayer`; Agents SDK — приемлемая альтернатива для быстрого прототипа (скетч в §13.3).

---

## 6. Русский язык

- Realtime- и TTS-модели мультиязычны; в TTS-гайде русский явно в списке поддерживаемых, но «voices are currently optimized for English» → возможен лёгкий акцент/неверные ударения в шахматных терминах («ферзя́», «ладья́», «пе́шка», «эндшпиль»). Лечится подсказками произношения в промпте и короткими фразами.
- В промпте **жёстко закрепить язык** (официальная рекомендация — иначе модель может «переключиться» из-за акцента/шума): «Говори ТОЛЬКО по-русски. Не меняй язык из-за акцента, шума, отдельных иностранных слов или шахматной нотации. Меняй язык только по явной просьбе». Промпт и примеры писать по-русски.
- Нотацию озвучивать словами: просить модель говорить «конь на эф-три», а не «Nf3»; в tool-выводах отдавать уже русифицированные ходы (`"move_ru": "конь f3"`).
- Транскрипция: `gpt-live-transcribe` + `languages:["ru"]` + `keywords` с шахматной лексикой. Детская речь распознаётся хуже взрослой — не строить логику на точном тексте (ходы вводятся на доске, не голосом).
- **Известные проблемы не-английских языков (форум community.openai.com):**
  - Тред «GPT Realtime 2.1 exhibits language drift» (15.07.2026, 6 сообщений, ответа OpenAI нет): на испанском/немецком/французском/португальском/датском `gpt-realtime-2.1` и `-2.1-mini` регулярно сползают в английский акцент или целиком переходят на английский, даже когда весь промпт и контекст на целевом языке (это снижает частоту, но не убирает). Цитаты участников: регрессия «2.1 vs 2» по французскому; «2.1 mini … on other languages except english is very very bad … 1.5 is much better on multi language». → Для русского тренера: `[СОБЫТИЕ]`-сообщения, tool-выводы и имена полей по возможности **по-русски**; латиницу/нотацию (`Nf3`, `eval_cp`) в контекст не пускать; иметь переключатель на `gpt-realtime-2` / `gpt-realtime-1.5`.
  - Тред «Realtime Russian voice: any path to Custom Voices or stable pronunciation control?» (25.06–03.07.2026, 17 сообщений): на `gpt-realtime-1.5` и `gpt-4o-mini-tts` русская речь — «English-like melody», нестабильные согласные, ошибки ударений и редукции гласных; носитель языка оценивает её как «не звучит по-русски». Формулировка «лёгкий акцент» поэтому оптимистична. Рабочий обходной путь авторов (проверен на `gpt-realtime-1.5`, голос `alloy`): **предобработка текста расстановкой ударений и «ё» (RUAccent)** + «голосовая маска» в инструкциях. У нас это применимо к слоям, где текст реплики формирует приложение (TTS-цепочка, `session.commentary.append`, дословные фразы): расставлять ударения в шахматных терминах до озвучки. Надёжность — средняя (отчёты пользователей, не OpenAI).
- `gpt-live-1` на русском — **НЕ ПРОВЕРЕНО**. Официального списка языков нет; сторонние обзоры пересказывают формулировку OpenAI «оптимизирован под самые популярные языки ChatGPT; в некоторых языках возможен неродной акцент или пробелы в беглости». Обязателен тест на слух (5 минут, ~$0.25).

---

## 7. Шум и эхо при игре через колонки

1. **Браузерный AEC — первая линия.** `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } })`. Удалённый трек воспроизводить через обычный `<audio autoplay>` с `srcObject` (как в примерах OpenAI) — так браузерный эхоподавитель получает опорный сигнал. Не гонять выход через сторонние плееры/приложения.
2. **Realtime API:** `audio.input.noise_reduction: { type: "far_field" }` для встроенного микрофона ноутбука + колонок; `near_field` для гарнитуры. `gpt-realtime-2.1` заявлен как улучшенный по «silence and noise handling, interruption behavior».
3. **VAD:** `semantic_vad` + `eagerness:"low"`; при ложных срабатываниях от собственного голоса тренера — поднять `threshold` у `server_vad` (0.6–0.7) или временно `interrupt_response:false`.
4. **Механическая страховка:** на время речи тренера глушить микрофон (`track.enabled=false`; в GPT-Live — `session.input_audio.mute`/`unmute`), оставив кнопку «перебить». Для Realtime это убирает само-перебивание ценой barge-in. В GPT-Live mute не останавливает речь модели и биллинг.
5. **Промпт:** блок «Silence and background noise» («не считай кашель, музыку, разговор рядом новым запросом», «молчи, пока ребёнок думает») + tool `wait_for_user` (Realtime).
6. **Практический совет:** детская гарнитура/наушники снимают 90% проблем. Режим по умолчанию — **push-to-talk (кнопка/пробел) + проактивные реплики тренера**; «открытый микрофон» — опция в настройках.
7. Звуки доски (стук фигур, звук хода) — проигрывать тихо или не проигрывать, пока открыт микрофон.

---

## 8. Цены и реалистичная стоимость

### 8.1. Единицы

- Realtime: входное аудио **1 токен / 100 мс** (600 ток/мин речи ребёнка), выходное **1 токен / 50 мс** (1200 ток/мин речи тренера). **Весь разговор пересылается в модель на каждом ответе** → поздние реплики дороже; спасает prompt caching (автоматический, best-effort; cached audio $0.40/1M против $32) и `truncation`. Пустое аудио при включённом VAD не тарифицируется.
- `gpt-realtime-2.1`: минута речи тренера ≈ **$0.077**, минута речи ребёнка ≈ **$0.019** (без учёта повторного чтения контекста). `-mini`: $0.024 и $0.006.
- GPT-Live: **$0.05 × минуты открытой сессии** (говорит кто-то или нет) + backend по обычным тарифам.

### 8.2. Сценарий «10-минутная партия»

Допущения: тренер говорит суммарно 2.5 мин, ребёнок 1 мин, 25 ответов модели (15 с вызовом `get_position_analysis`, вывод ~300 токенов), системный промпт+tools 2.5k токенов, контекст к концу ~12k, в среднем ~7k на ответ.

| Вариант | Расчёт | Итого за 10 мин |
|---|---|---|
| **`gpt-realtime-2.1`** | out audio 3 000×$64/M = $0.19; out text (транскрипт+аргументы+reasoning ~3.2k)×$24/M = $0.08; свежий audio-in 3.6k×$32/M = $0.12; свежий text-in 9k×$4/M = $0.04; кэш ~160k×$0.40/M = $0.07; транскрипция ~$0.02 | **≈ $0.50** при хорошем кэше; **$0.7–1.0** реалистично; до ~$2.4 если кэш не работает |
| **`gpt-realtime-2.1-mini`** | те же объёмы по тарифам mini | **≈ $0.15–0.30** |
| **`gpt-live-1`** + `gpt-5.6-terra` | 10 мин×$0.05 = $0.50; backend 15 делегирований×(3k in+250 out) ≈ $0.08–0.14 | **≈ $0.58–0.64** |
| **`gpt-live-1`** + `gpt-5.6-luna` / свой backend | $0.50 + ~$0.01 | **≈ $0.51** |
| Цепочка: `gpt-5.6-luna` + `gpt-4o-mini-tts` + `gpt-transcribe` (push-to-talk) | LLM ~$0.02; TTS 2.5 мин×$0.015 = $0.04; STT 1 мин×$0.0045 | **≈ $0.06** |
| То же, мозг на Codex-подписке | TTS + STT | **≈ $0.04** |
| `speechSynthesis` + Codex-подписка | — | **$0** |

Важно: контроль «10 минут» в шахматах = по 10 минут **каждому** → партия до ~20 мин + разбор. GPT-Live при этом ≈ $1.0+; Realtime почти не дорожает, если тренер молчит, пока ребёнок думает. Для GPT-Live экономия — закрывать сессию при простое (`session.close`) и открывать по кнопке/событию (каждое открытие WebRTC = минимум 15 с биллинга + секунды на соединение).

### 8.3. В месяц (3 партии в день, 90 партий по ~15 мин сессии)

`gpt-realtime-2.1` ≈ $60–120 · `-mini` ≈ $20–40 · `gpt-live-1` ≈ $70–85 · цепочка TTS ≈ $6–9 · speechSynthesis ≈ $0. Контроль бюджета: лимит расходов в проекте платформы, счётчик `response.done.usage` / `session.usage.updated` в приложении, «дневной лимит голоса» с автопереключением на дешёвый слой.

---

## 9. Rate limits

| Модель | Tier 1 ($5 оплачено) | Tier 2 ($50) | Примечание |
|---|---|---|---|
| `gpt-realtime-2.1` | 200 RPM, **1 000 RPD**, **40 000 TPM** | 400 RPM, 200k TPM | при контексте ~12k и 4+ ответах в минуту можно упереться в 40k TPM → держать `post_instructions ≤ 8000`, короткие tool-выводы; разумно дойти до Tier 2 |
| `gpt-realtime-2.1-mini` | 200 RPM, 40k TPM | 400 RPM, 200k TPM | |
| `gpt-live-1` | **25 одновременных сессий** | 50 | Tier 3–5: 200/300/500; free tier не поддерживается; нам хватает с запасом |
| `gpt-4o-mini-tts` | 500 RPM, 50k TPM | 2 000 RPM | |
| `gpt-live-transcribe` | 500 RPM, 60k TPM | | |

Лимит расходов Tier 1 — $100/мес. Событие `rate_limits.updated` приходит в Realtime после каждого ответа.

---

## 10. Подписка ChatGPT/Codex vs API-биллинг

- Биллинг ChatGPT-подписки и API-платформы **раздельный**; Codex «Sign in with ChatGPT» расходует лимиты плана только на Codex-запросы. Подтверждено и практикой: OAuth-токен Codex работает с Codex Responses-бэкендом ChatGPT, но **Realtime-эндпоинты с ним не работают** (ошибки `invalid_model`/`missing_model`, issue `laiso/whistt#1`, 29.06.2026; в исходниках Codex, `codex-rs/core/src/realtime_conversation.rs`, функция `realtime_api_key` завершается ошибкой «realtime conversation requires API key auth» с TODO про ChatGPT-сессии). В `codex-cli 0.154.0` флаг `realtime_conversation` в состоянии *removed*.
- **Что можно оставить на подписке:** текстовый «мозг» — `codex exec` (неинтерактивный режим) для разбора партии после игры, генерации markdown-журналов, планов занятий, и даже для реплик по ходу (но задержка `codex exec` — секунды-десятки секунд → для живого диалога медленно; для пост-анализа идеально). Допустимость использования Codex-подписки как backend'а приложения с точки зрения условий плана — **НЕ ПРОВЕРЕНО** (для личного локального использования риск минимален).
- **Что неизбежно по API:** любой облачный голос OpenAI (Realtime/Live/TTS/STT). Минимальный платный вариант — `gpt-4o-mini-tts` (~$0.015/мин речи). Нулевой — `speechSynthesis`.
- Нужно: создать проект на platform.openai.com, API-ключ, пополнить ≥ $5 (лучше $50 → Tier 2), выставить месячный лимит. РФ и Беларуси **нет** в списке поддерживаемых стран API (Армения, Грузия, Казахстан, Израиль, Германия, Сербия, Турция, ОАЭ и др. — есть) → учитывать при развёртывании.

---

## 11. Ребёнок до 13 лет: политика и безопасность

**Что говорит OpenAI (официальный «Under-18 guidance», раздел Safety checks):**
- Соблюдать законы о защите детей (COPPA и др.). **«You should not use OpenAI services to process any personal data of children under 13 or the applicable age of digital consent without first implementing zero data retention in our API.»**
- Дать ребёнку понятное по возрасту объяснение, что это ИИ; возрастные контент-фильтры; мониторинг и пути эскалации; при необходимости — age assurance.
- «Use OpenAI's most current flagship models … particularly when building experiences for minors.»
- OpenAI вправе аудировать и отключить доступ при несоблюдении.
- Usage policies: TTS-голос обязан сопровождаться раскрытием, что он сгенерирован ИИ. Пользовательские условия: сервисы OpenAI — 13+, до 18 — с разрешения родителя (это про аккаунты; у нас API-аккаунт принадлежит родителю, ребёнок — конечный пользователь приложения).

**Данные:** по умолчанию API не обучается на данных; abuse-логи хранятся до 30 дней. `/v1/realtime` — состояние не хранится, **ZDR-eligible**; `/v1/live/sessions` — ZDR-eligible с ограничениями (`store` принудительно `false`, fork недоступен); `/v1/audio/speech` — ZDR-eligible. **ZDR и Modified Abuse Monitoring выдаются только по заявке и одобрению OpenAI** (обычно enterprise/sales) — для частного лица получение **НЕ ПРОВЕРЕНО** и маловероятно.

**Нюанс из той же таблицы «Your data»:** у `/v1/audio/transcriptions` (файловый STT, `gpt-transcribe`) в колонке *Abuse monitoring retention* стоит **None** — т.е. даже без ZDR аудио/текст этого эндпоинта в abuse-логах не хранится. У `/v1/realtime`, `/v1/live/sessions` и `/v1/audio/speech` — 30 дней. Вывод: из облачных путей для *голоса ребёнка* наименее «следящий» — **push-to-talk → запись фразы → `POST /v1/audio/transcriptions`** (а не открытый микрофон в Realtime/Live); полностью локальный STT остаётся самым строгим вариантом.

**Практичная позиция для домашнего приложения (не юридическая консультация):**
1. Родитель держит ключ и управляет приложением; ребёнок занимается под присмотром; в UI — экран «Это голос ИИ-тренера».
2. **Минимизировать ПДн:** не передавать в промпты настоящее имя/фамилию, возраст, школу, город; использовать псевдоним («Чемпион»); `OpenAI-Safety-Identifier` = хэш локального id; `store:false`; не включать запись сессий у OpenAI.
3. **Голос ребёнка — самое чувствительное.** Режим по умолчанию: push-to-talk (в облако уходит только то, что ребёнок сказал тренеру осознанно). Строгий вариант: голос ребёнка вообще не покидает Mac — локальный STT (whisper.cpp / Apple Speech) → текст → LLM → облачный TTS озвучивает только *текст тренера* (в нём нет ПДн ребёнка). Это одновременно и самый дешёвый вариант.
4. Подать заявку на ZDR/MAM через поддержку/sales платформы — дёшево попробовать; результат непредсказуем.
5. **Guardrails по содержанию:** узкая роль в промпте («только шахматы, учёба, поддержка; на посторонние темы — мягко вернуть к доске; никогда не спрашивать личные данные; при грусти/злости — поддержать и предложить перерыв/позвать родителя»); все транскрипты локально в markdown-журнал, доступный родителю; лимит времени сессии; кнопка «выключить тренера».
6. GPT-Live даёт доп. контроль: `allowed_client_events` (фронт не может переписать инструкции), серверный sideband-монитор транскриптов.
7. Тон к ребёнку: критика хода, не ребёнка («этот ход теряет коня» вместо «ты зевнул»), правило «одна подсказка-вопрос прежде ответа».

---

## 12. Дешёвые fallback'и

### 12.1. Цепочка «текстовый LLM + TTS (+ STT)»

- **TTS:** `POST /v1/audio/speech`, `model:"gpt-4o-mini-tts"`, голос `marin`/`coral`/`cedar` (всего 13: `alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse, marin, cedar`), **`instructions`** — управление манерой («Говори по-русски, тепло и бодро, как молодой тренер; темп чуть выше среднего; ударения: ферзя́, ладья́»), форматы `mp3/opus/aac/flac/wav/pcm`, стриминг chunked (первый звук ~0.3–0.6 с — **НЕ ПРОВЕРЕНО** замером). Лимит входа 2000 токенов — реплики тренера короткие, хватает.
- **Кэш фраз:** ~50–100 частых реплик («Отличный ход!», «Подожди, давай вернём ход…», «Шах!») сгенерировать один раз в файлы → $0 и нулевая задержка при игре. Сильно рекомендую независимо от основного слоя.
- **STT (если нужен голос ребёнка):** `gpt-transcribe` ($0.0045/мин, файл после push-to-talk) или локально whisper.cpp ($0, приватно). Потоковый `gpt-live-transcribe` ($0.017/мин) не держать открытым постоянно.
- **LLM:** `gpt-5.6-luna` (дёшево/быстро) или Codex-подписка (бесплатно, медленно).
- Минусы: нет перебивания и «живости», задержка 1.5–3 с на реплику, интонация не реагирует на эмоции ребёнка. Плюсы: в 10 раз дешевле, полный контроль текста до озвучки (идеально для детской безопасности), голос ребёнка можно не отправлять в облако.

### 12.2. Браузерный `speechSynthesis` (нулевая стоимость, офлайн)

- На macOS 26.6 (установка по умолчанию, `say -v '?'`) из русских системных голосов установлен только **«Milena» (ru_RU)** в базовом (compact) качестве — звучит роботизированно. В «Системные настройки → Универсальный доступ → Устный контент → Системный голос → Управлять голосами» можно скачать улучшенные варианты (Milena Enhanced/Premium, другие русские голоса — точный список для macOS 26 **НЕ ПРОВЕРЕНО**). Safari и Chrome видят системные голоса через `speechSynthesis.getVoices()`.
- В Chrome дополнительно есть сетевой голос «Google русский» (`localService:false`) — требует интернет, у сетевых голосов известен обрыв длинных фраз (~15 с) → резать текст на предложения.
- Нюансы: `getVoices()` асинхронен (ждать `voiceschanged`); запуск речи — после пользовательского жеста; `utterance.lang="ru-RU"`, `rate≈1.05`, `pitch≈1.15` для «молодого» звучания; событие `onboundary` годится для липсинка маскота; `speechSynthesis.cancel()` — мгновенное «перебивание».
- `SpeechRecognition` (webkit) в Chrome отправляет аудио на серверы Google — для ребёнка нежелательно; не использовать.
- Роль: офлайн-режим, режим «кончился бюджет», и дефолт до появления API-ключа.

### 12.3. Сводка слоёв

| Слой | Живость | Задержка | $/10 мин | Приватность голоса ребёнка | Когда |
|---|---|---|---|---|---|
| `gpt-live-1` | ★★★★★ full-duplex | очень низкая | ~0.5–0.65 | аудио в облако | цель, если русский ок |
| `gpt-realtime-2.1` | ★★★★ | низкая | ~0.5–1.0 | аудио в облако (можно PTT) | **старт** |
| `gpt-realtime-2.1-mini` | ★★★☆ | низкая | ~0.15–0.3 | то же | экономный режим — **только если пройдёт русский тест** (на форуме OpenAI: mini «очень плох» вне английского) |
| `gpt-realtime-2` / `gpt-realtime-1.5` | ★★★★ / ★★★☆ | низкая | как у 2.1 (у 1.5 text-out $16/M, контекст 32k) | то же | запасные модели, если 2.1 «уезжает» в английский акцент |
| LLM + `gpt-4o-mini-tts` | ★★☆ | 1.5–3 с | ~0.04–0.06 | можно полностью локально | бюджет/строгая приватность |
| `speechSynthesis` | ★ | мгновенно | 0 | локально | офлайн/без ключа |

---

## 13. Скетчи кода

> Скетчи собраны по документации (имена эндпоинтов/событий сверены), но **не запускались** против живого API.

### 13.1. Realtime API: сервер (ephemeral key) + браузер (WebRTC, tools, проактивное событие)

**`server.mjs`** (Node ≥ 22; `npm i express`)

```js
import express from "express";
import crypto from "node:crypto";

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use(express.static("public"));

const COACH_INSTRUCTIONS = `
# Роль
Ты — Лёва, весёлый молодой шахматный тренер-маскот. Ученик — ребёнок, уже знает, как ходят фигуры.
# Язык
Говори ТОЛЬКО по-русски. Не меняй язык из-за шума, акцента или шахматной нотации. Ходы произноси словами: «конь на эф-три».
# Стиль
Коротко: 1–3 предложения. Тепло, бодро, без сюсюканья. Критикуй ход, а не ученика. Сначала вопрос-подсказка, потом ответ.
# Истина о позиции
НИКОГДА не оценивай позицию сам. Перед любым утверждением о позиции вызови get_position_analysis и опирайся только на его данные.
# События приложения
Сообщения role=system с префиксом [СОБЫТИЕ] приходят от приложения — это факты. При [СОБЫТИЕ:ЗЕВОК] попроси вернуть ход и подумать ещё раз, вызови take_back_move только после согласия ученика.
# Тишина и шум
Если звук — тишина, шум, ТВ, разговор не с тобой — вызови wait_for_user и молчи. Не торопи ученика, пока он думает.
# Безопасность
Только шахматы и учёба. Не спрашивай личные данные. Если ученик расстроен — поддержи и предложи перерыв или позвать родителя.
`;

const tools = [
  { type: "function", name: "get_position_analysis",
    description: "Анализ текущей позиции движком: оценка, лучший ход, угрозы, почему последний ход слабый.",
    parameters: { type: "object", properties: { depth: { type: "integer", minimum: 8, maximum: 22 } }, required: [] } },
  { type: "function", name: "show_arrow",
    description: "Нарисовать стрелку на доске.",
    parameters: { type: "object", properties: {
      from: { type: "string", pattern: "^[a-h][1-8]$" }, to: { type: "string", pattern: "^[a-h][1-8]$" },
      color: { type: "string", enum: ["green", "red", "blue", "yellow"] } }, required: ["from", "to"] } },
  { type: "function", name: "highlight_squares",
    description: "Подсветить клетки.",
    parameters: { type: "object", properties: {
      squares: { type: "array", items: { type: "string", pattern: "^[a-h][1-8]$" } },
      color: { type: "string", enum: ["green", "red", "blue", "yellow"] } }, required: ["squares"] } },
  { type: "function", name: "take_back_move",
    description: "Вернуть последний ход ученика (только после его согласия).",
    parameters: { type: "object", properties: {}, required: [] } },
  { type: "function", name: "get_student_profile",
    description: "Профиль ученика: уровень, слабые темы, прогресс по программе.",
    parameters: { type: "object", properties: {}, required: [] } },
  { type: "function", name: "wait_for_user",
    description: "Вызвать, когда последний звук не требует ответа (тишина, шум, ТВ, разговор не с тренером).",
    parameters: { type: "object", properties: {}, required: [] } },
];

// Локальное приложение: слушаем только 127.0.0.1. Перед выносом наружу — добавить авторизацию.
app.post("/api/realtime/token", async (_req, res) => {
  const r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": crypto.createHash("sha256").update("local-student-1").digest("hex"),
    },
    body: JSON.stringify({
      expires_after: { anchor: "created_at", seconds: 60 },   // ключ нужен только на время коннекта
      session: {
        type: "realtime",
        model: process.env.RT_MODEL ?? "gpt-realtime-2.1",    // или gpt-realtime-2.1-mini
        instructions: COACH_INSTRUCTIONS,
        output_modalities: ["audio"],
        reasoning: { effort: "low" },
        tools, tool_choice: "auto",
        audio: {
          input: {
            noise_reduction: { type: "far_field" },
            transcription: { model: "gpt-live-transcribe", languages: ["ru"],
                             keywords: ["ферзь", "ладья", "слон", "конь", "пешка", "рокировка", "вилка", "связка", "мат"] },
            turn_detection: { type: "semantic_vad", eagerness: "low", create_response: true, interrupt_response: true },
          },
          output: { voice: "marin", speed: 1.05 },
        },
        truncation: { type: "retention_ratio", retention_ratio: 0.8, token_limits: { post_instructions: 8000 } },
      },
    }),
  });
  const data = await r.json();
  if (!r.ok) return res.status(r.status).json({ error: data?.error?.message ?? "client_secret failed" });
  res.json({ value: data.value, expires_at: data.expires_at });
});

app.listen(3000, "127.0.0.1", () => console.log("http://localhost:3000"));
```

**`public/voice-realtime.js`** (браузер)

```js
export async function connectCoach({ toolHandlers, onTranscript, onSpeaking }) {
  const { value: EPHEMERAL_KEY } = await (await fetch("/api/realtime/token", { method: "POST" })).json();

  const pc = new RTCPeerConnection();
  const audioEl = Object.assign(document.createElement("audio"), { autoplay: true });
  pc.ontrack = (e) => (audioEl.srcObject = e.streams[0]);           // выход через <audio> → работает браузерный AEC

  const mic = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  const micTrack = mic.getAudioTracks()[0];
  pc.addTrack(micTrack, mic);

  const dc = pc.createDataChannel("oai-events");                    // до createOffer()
  const send = (ev) => dc.send(JSON.stringify(ev));
  let responseActive = false;

  dc.addEventListener("message", async ({ data }) => {
    const ev = JSON.parse(data);
    switch (ev.type) {
      case "response.created": responseActive = true; break;
      case "output_audio_buffer.started": onSpeaking?.(true); break;   // маскот открывает рот
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared": onSpeaking?.(false); break;
      case "response.output_audio_transcript.done": onTranscript?.("coach", ev.transcript); break;
      case "conversation.item.input_audio_transcription.completed": onTranscript?.("student", ev.transcript); break;
      case "response.done": {
        responseActive = false;
        const calls = (ev.response.output ?? []).filter((i) => i.type === "function_call");
        if (!calls.length) break;
        for (const c of calls) {
          let output;
          try { output = await toolHandlers[c.name]?.(JSON.parse(c.arguments || "{}")) ?? { error: "unknown_tool" }; }
          catch (err) { output = { error: String(err) }; }
          send({ type: "conversation.item.create",
                 item: { type: "function_call_output", call_id: c.call_id, output: JSON.stringify(output) } });
        }
        if (calls.some((c) => c.name !== "wait_for_user")) send({ type: "response.create" });
        break;
      }
      case "error": console.warn("realtime error", ev.error); break;
    }
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const sdpRes = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST", body: offer.sdp,
    headers: { Authorization: `Bearer ${EPHEMERAL_KEY}`, "Content-Type": "application/sdp" },
  });
  if (!sdpRes.ok) throw new Error(await sdpRes.text());
  await pc.setRemoteDescription({ type: "answer", sdp: await sdpRes.text() });
  await new Promise((ok) => (dc.readyState === "open" ? ok() : dc.addEventListener("open", ok, { once: true })));

  return {
    /** Тихий контекст: позиция/ход. Ответ не вызывает. */
    context(text) {
      send({ type: "conversation.item.create",
             item: { type: "message", role: "system", content: [{ type: "input_text", text: `[СОБЫТИЕ] ${text}` }] } });
    },
    /** Проактивная реплика: приложение решило, что тренер должен заговорить СЕЙЧАС. */
    speakNow(eventText, howToReact) {
      if (responseActive) { send({ type: "response.cancel" }); send({ type: "output_audio_buffer.clear" }); }
      send({ type: "conversation.item.create",
             item: { type: "message", role: "system", content: [{ type: "input_text", text: eventText }] } });
      send({ type: "response.create", response: { instructions: howToReact } });
    },
    /** Out-of-band: текст в журнал, без озвучки и без следа в истории. */
    journalNote(prompt) {
      send({ type: "response.create", response: { conversation: "none", output_modalities: ["text"],
             metadata: { topic: "journal" }, instructions: prompt } });
    },
    setMic(on) { micTrack.enabled = on; },                           // push-to-talk / mute на время речи тренера
    close() { mic.getTracks().forEach((t) => t.stop()); dc.close(); pc.close(); },
  };
}
```

**Использование (зевок ДО ответа бота):**

```js
const coach = await connectCoach({
  toolHandlers: {
    get_position_analysis: ({ depth = 14 }) => engine.analyze(game.fen(), depth),  // → { eval_cp, best_move_ru, threats_ru, why_last_move_bad_ru }
    show_arrow: (a) => (board.arrow(a), { ok: true }),
    highlight_squares: (a) => (board.highlight(a), { ok: true }),
    take_back_move: () => (game.undo(), board.sync(), { ok: true, fen: game.fen() }),
    get_student_profile: () => profileStore.summary(),
    wait_for_user: () => ({ ok: true }),
  },
  onTranscript: (who, text) => journal.append(who, text),
  onSpeaking: (on) => mascot.setTalking(on),
});

async function onStudentMove(move) {
  const verdict = await blunderCheck(move);              // Stockfish: Δeval, порог по уровню ученика
  if (verdict.isBlunder) {
    botClock.pause();                                    // бот НЕ отвечает, пока не разберёмся
    coach.speakNow(
      `[СОБЫТИЕ:ЗЕВОК] Ученик сыграл ${verdict.moveRu}. Оценка упала с ${verdict.before} до ${verdict.after}. Причина: ${verdict.reasonRu}.`,
      "Останови ученика: «Подожди! Давай вернём ход и подумаем ещё раз». Дай одну подсказку-вопрос, не называй лучший ход. 1–2 предложения."
    );
    ui.offerTakeBack();                                  // кнопка «Вернуть ход» — детерминированно, не зависит от LLM
  } else {
    coach.context(`Ученик сыграл ${verdict.moveRu}. Оценка ${verdict.after}.`);
    bot.reply();
  }
}
```

### 13.2. GPT-Live: сервер (SDP-обмен), tools через Responses delegation, проактивное событие

**`server-live.mjs`** (`npm i express openai@^7.20.0`)

```js
import express from "express";
import OpenAI from "openai";

const app = express();
const client = new OpenAI({ maxRetries: 0 });
app.use(express.json({ limit: "64kb" }));
app.use(express.static("public"));

const backendTools = [ /* те же function-схемы, но в формате Responses: {type:"function", name, description, parameters, strict} */ ];

app.post("/api/live/session", async (req, res) => {
  if (typeof req.body?.sdp !== "string") return res.status(400).json({ error: "sdp required" });
  try {
    const result = await client.live.create({
      session: {
        model: "gpt-live-1",
        instructions: `
Ты — Лёва, весёлый молодой шахматный тренер. Говори только по-русски, коротко и тепло.
Backchannel policy: умеренные «угу», «так-так», не перебивая ученика.
Interruption policy: если ученик перебивает — сразу замолчи и слушай.
Delegation policy:
Backend tools:
- Шахматный анализ: оценка позиции, лучший ход, угрозы, стрелки/подсветка на доске, возврат хода, профиль ученика.
Delegate to the backend when:
- Любой вопрос о позиции, ходах, плане, ошибках; просьба показать/вернуть ход.
Do not delegate to the backend when:
- Приветствие, похвала, просьба повторить уже сказанное.
Никогда не оценивай позицию сам — жди результат backend'а. Пока ученик молча думает — молчи.`,
        audio: { output: { voice: "marin" } },
        input: [{ type: "message", role: "developer",
                  content: [{ type: "input_text", text: "Профиль: псевдоним «Чемпион», ~900 Эло, тема недели — вилки." }] }],
        delegation: { type: "responses", responses: {
          model: "gpt-5.6-terra",                         // дешевле: gpt-5.6-luna
          instructions: "Ты шахматный методист. Опирайся ТОЛЬКО на get_position_analysis. Верни 1–3 коротких факта по-русски для озвучки ребёнку; ходы словами.",
          tools: backendTools, tool_choice: "auto", parallel_tool_calls: false,
          reasoning: { effort: "low" }, text: { verbosity: "low" },
        } },
        client: { data_channel: { allowed_client_events: [
          "session.thinking.append", "session.commentary.append", "session.instructions.append",
          "response.item.create", "response.create",
          "session.input_audio.mute", "session.input_audio.unmute", "session.close" ] } },
        store: false,
      },
      transport: { type: "webrtc", sdp: req.body.sdp },
    });
    res.status(201).json(result);                          // { session:{id:"live_…"}, transport:{type:"webrtc", sdp} }
  } catch (e) {
    res.status(e?.status ?? 502).json({ error: "Live session creation failed" });
  }
});
app.listen(3000, "127.0.0.1");
```

**Браузер (суть отличий от 13.1):**

```js
const dc = pc.createDataChannel("oai-events");
// offer → дождаться ICE gathering complete → POST /api/live/session {sdp} → setRemoteDescription(result.transport.sdp)
// НЕ слать session.start. Ждать session.started.
const pending = new Map();                                   // response_id → [function calls]
dc.addEventListener("message", async ({ data }) => {
  const ev = JSON.parse(data);
  if (ev.type === "session.input_transcript.delta")  journal.appendDelta("student", ev.delta, ev.start_ms);
  if (ev.type === "session.output_transcript.delta") journal.appendDelta("coach", ev.delta, ev.start_ms);
  if (ev.type === "response.event") {
    const inner = ev.event;
    if (inner.type === "response.output_item.done" && inner.item?.type === "function_call") {
      const out = await toolHandlers[inner.item.name](JSON.parse(inner.item.arguments || "{}"));
      send({ type: "response.item.create", event_id: crypto.randomUUID(),
             item: { type: "function_call_output", call_id: inner.item.call_id, output: JSON.stringify(out) } });
      send({ type: "response.create", event_id: crypto.randomUUID() });   // продолжить backend (при parallel_tool_calls:false)
    }
  }
  if (ev.type === "session.closed") console.log("usage seconds:", ev.usage?.seconds, ev.reason);
});

// Тихий контекст после каждого хода:
send({ type: "session.thinking.append", event_id: crypto.randomUUID(), delegation_id: null,
       content: "Ход 12: ученик сыграл слон f4. Оценка +0.3. Угроз нет." });

// ПРОАКТИВНО при зевке (жёстко, может перебить текущую речь):
send({ type: "session.instructions.append", event_id: crypto.randomUUID(), delegation_id: null,
       content: "Сейчас же скажи по-русски: попроси ученика вернуть ход и подумать ещё раз. Причина: после ферзь d2 конь e4 делает вилку. Не называй лучший ход, задай один наводящий вопрос. Потом замолчи и слушай." });

// Или мягко — готовая реплика от CoachBrain (модель перефразирует):
send({ type: "session.commentary.append", event_id: crypto.randomUUID(), delegation_id: null,
       content: "Подожди-ка! Давай вернём ход. Посмотри, какое поле теперь может занять чёрный конь?" });

// Завершение: сначала слушатель session.closed, потом
send({ type: "session.close" });
```

Вариант **client delegation** (`delegation:{type:"client"}`): на `session.delegation.created` приложение само берёт последние транскрипты + FEN, вызывает свой CoachBrain (в т.ч. через Codex-подписку) и отвечает `session.commentary.append` с `delegation_id: ev.delegation.id`. UI-инструменты (`show_arrow` и т.д.) тогда вызывает наш код — голосовой слой о них не знает.

### 13.3. Тот же Realtime-клиент через Agents SDK (`@openai/agents@0.18.0`, `zod@^4`)

```ts
import { RealtimeAgent, RealtimeSession, tool } from "@openai/agents/realtime";
import { z } from "zod";

const showArrow = tool({
  name: "show_arrow", description: "Нарисовать стрелку на доске.",
  parameters: z.object({ from: z.string(), to: z.string(), color: z.enum(["green", "red", "blue", "yellow"]).default("green") }),
  async execute(a) { board.arrow(a); return "ok"; },
});
const coachAgent = new RealtimeAgent({ name: "Лёва", instructions: COACH_INSTRUCTIONS, tools: [showArrow /* … */] });

const session = new RealtimeSession(coachAgent, {
  model: "gpt-realtime-2.1",
  config: { outputModalities: ["audio"], reasoning: { effort: "low" },
    audio: { input: { transcription: { model: "gpt-live-transcribe", languages: ["ru"] },
                      turnDetection: { type: "semantic_vad", eagerness: "low", createResponse: true, interruptResponse: true } },
             output: { voice: "marin" } } },
});
await session.connect({ apiKey: ephemeralKey });            // ek_… с нашего /api/realtime/token; в браузере — WebRTC автоматически

// проактивное событие — сырыми событиями транспорта:
session.transport.sendEvent({ type: "conversation.item.create",
  item: { type: "message", role: "system", content: [{ type: "input_text", text: "[СОБЫТИЕ:ЗЕВОК] …" }] } });
session.transport.sendEvent({ type: "response.create", response: { instructions: "Попроси вернуть ход…" } });

session.on("history_updated", (h) => journal.sync(h));
// session.interrupt(); session.mute(true); session.sendMessage("текст от имени ученика");
```

### 13.4. Fallback: TTS-эндпоинт + `speechSynthesis`

```js
// сервер: озвучка готового текста тренера (стриминг)
app.post("/api/tts", async (req, res) => {
  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "marin", input: String(req.body.text).slice(0, 1500),
      instructions: "Говори по-русски, тепло и бодро, как молодой дружелюбный тренер. Темп чуть выше среднего.",
      response_format: "mp3" }),
  });
  res.status(r.status).type("audio/mpeg");
  r.body.pipeTo(new WritableStream({ write: (c) => void res.write(c), close: () => res.end() }));
});

// браузер: нулевой по стоимости слой
export function sayLocal(text, { onStart, onEnd } = {}) {
  const ru = speechSynthesis.getVoices().filter((v) => v.lang.startsWith("ru"));
  const voice = ru.find((v) => /premium|enhanced|улучш/i.test(v.name)) ?? ru.find((v) => v.localService) ?? ru[0];
  for (const part of text.match(/[^.!?…]+[.!?…]*/g) ?? [text]) {      // резать на предложения (баг длинных фраз в Chrome)
    const u = new SpeechSynthesisUtterance(part.trim());
    u.lang = "ru-RU"; if (voice) u.voice = voice; u.rate = 1.05; u.pitch = 1.15;
    u.onstart = onStart; u.onend = onEnd;
    speechSynthesis.speak(u);
  }
}
// speechSynthesis.cancel() — «перебить»; голоса подгружаются асинхронно → ждать событие "voiceschanged".
```

### 13.5. Общий интерфейс голосового слоя

```ts
interface VoiceLayer {
  say(text: string, opts?: { urgent?: boolean }): Promise<void>; // urgent → перебить текущую речь
  context(text: string): void;                                   // тихий факт о партии
  onStudentSpeech(cb: (text: string, final: boolean) => void): void;
  onSpeaking(cb: (talking: boolean) => void): void;              // анимация маскота
  setMic(on: boolean): void;
  close(): Promise<void>;
}
// Реализации: RealtimeVoice (13.1) | LiveVoice (13.2) | TtsVoice (13.4 сервер) | LocalVoice (speechSynthesis)
```

---

## 14. Итоговая рекомендация

1. **Сейчас:** Realtime API, **`gpt-realtime-2.1`** (`reasoning.effort:"low"`, `semantic_vad` + `eagerness:"low"`, `noise_reduction:"far_field"`, голос `marin`, транскрипция `gpt-live-transcribe` c `languages:["ru"]`), сырой WebRTC + ephemeral `client_secrets` (TTL 60 с) с локального сервера на `127.0.0.1`. Экономный режим — **`gpt-realtime-2.1-mini`** тем же кодом.
   Из-за жалоб сообщества на «language drift» у `2.1`/`2.1-mini` в не-английских языках модель выбирается **по результату русского теста на слух до старта**: кандидаты `gpt-realtime-2.1` → `gpt-realtime-2` (та же цена) → `gpt-realtime-1.5`. Id модели — в конфиге (`RT_MODEL`), не в коде. Весь контекст, который приложение впрыскивает в сессию (события, tool-выводы), — по-русски, без латинской нотации. Тогда же имеет смысл послушать и `gpt-live-1` (5 минут ≈ $0.25), а не откладывать на 1–2 недели: если Realtime по-русски звучит плохо, порядок слоёв меняется.
2. **Архитектурно:** проверка зевка — Stockfish в приложении; тренер получает факты `[СОБЫТИЕ]` и **никогда не оценивает позицию сам** (tool `get_position_analysis` — единственный источник истины). Кнопка «Вернуть ход» детерминированная, не зависит от LLM.
3. **Через 1–2 недели:** A/B на слух `gpt-live-1` (русский, естественность, поведение при колонках). Если ок — GPT-Live основной слой (full-duplex = ровно заявленное требование; `session.thinking/commentary/instructions.append` идеально ложатся на «события партии»; backend — `gpt-5.6-luna`/`terra` или свой мозг через client delegation).
4. **Всегда иметь дешёвые слои:** предзаписанные фразы (`gpt-4o-mini-tts`, один раз), TTS-цепочка, `speechSynthesis`. Дневной лимит «дорогого» голоса с автопереключением.
   **Не-OpenAI TTS как «рот»:** у OpenAI нет ни одного «родного» русского голоса, а русскоязычные разработчики на форуме OpenAI прямо пишут, что русская речь Realtime/TTS «не звучит по-русски». Интерфейс `VoiceLayer` позволяет подключить **не-OpenAI русский TTS** только для «рта» (мозг остаётся на OpenAI/Codex, как заложено в архитектуре): облачные Yandex SpeechKit / SaluteSpeech, либо локальные Silero TTS (репозиторий `snakers4/silero-models`, 6.1k звёзд, лицензия нестандартная — проверить условия) и Piper (`OHF-Voice/piper1-gpl`, GPL-3.0; старый `rhasspy/piper` заархивирован). Цены/качество/лицензии этих вариантов (не проверено) — это направление для отдельного сравнения на слух, если русский у OpenAI разочарует. Для слоёв с заранее известным текстом полезна предобработка ударений (RUAccent).
5. **По подписке Codex:** пост-анализ партий, журналы, учебные планы (`codex exec`). Голос — только API-ключ.
6. **Ребёнок <13:** push-to-talk по умолчанию, псевдоним, `store:false`, без ПДн в промптах, локальные журналы для родителя; попытаться получить ZDR; как строгая альтернатива — локальный STT + облачный TTS только текста тренера.

---

## 15. Открытые вопросы

- Качество русского (акцент, ударения, распознавание детской речи) у `gpt-live-1`, `gpt-realtime-2.1(-mini)`, `gpt-4o-mini-tts` — нужен тест на слух; официального списка языков GPT-Live нет.
- Какой голос звучит «молодо и дружелюбно» по-русски — субъективно, нужен тест (`marin`, `coral`, `shimmer`, `gleam`, `cedar`).
- Точная максимальная длительность сессии GPT-Live (есть `expires_at` и `reason:"expired"`, числа в доке нет).
- Реальная доля кэш-попаданий в Realtime и итоговая цена партии — оценки расчётные; замерить по `response.done.usage`. Что именно считается «request» для лимита 1 000 RPD Tier 1 у `gpt-realtime-2.1`.
- Задержка первого звука у `gpt-4o-mini-tts` и у GPT-Live/Realtime на русском — не замерялась.
- Возможность получить ZDR/Modified Abuse Monitoring частному лицу.
- Допустимость использования Codex-подписки как backend'а приложения по условиям плана.
- Точный код ошибки при `response.create` во время активного ответа (в скетче обходится через `response.cancel`).
- Список скачиваемых русских голосов macOS 26 (кроме установленной «Milena»).
- Оригинальные посты openai.com (анонсы GPT-Live-1 и gpt-realtime-2) недоступны для автоматической загрузки (HTTP 403) — факты взяты из официальной документации/changelog и сторонних пересказов. Неофициальная классификация gptlives.com («русский — второй эшелон языков GPT-Live») первоисточником не подтверждена.
- Страна API-аккаунта vs список поддерживаемых стран API (РФ и Беларуси в списке нет).
- Любое живое поведение API: приём конфигурации сессии, порядок `response.cancel` → `response.create`, работоспособность скетчей §13 — запросы к `api.openai.com` не выполнялись.
- Затрагивает ли «language drift» `gpt-realtime-2.1(-mini)` именно русский; принимает ли сессия `type:"realtime"` модель транскрипции `gpt-live-transcribe` на практике (дока противоречива, см. §4.8); качество/цены/лицензии не-OpenAI русских TTS (SpeechKit, SaluteSpeech, Silero, Piper).

---

## Источники (по состоянию на 2026-09-21)

Официальная документация OpenAI (markdown-версии страниц: к URL страницы добавляется `.md`, например `…/guides/live.md`; вариант `…/page.md` отдаёт 404):
- https://developers.openai.com/api/docs/changelog
- https://developers.openai.com/api/docs/models
- https://developers.openai.com/api/docs/models/gpt-live-1
- https://developers.openai.com/api/docs/models/gpt-realtime-2.1
- https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini
- https://developers.openai.com/api/docs/models/gpt-realtime-2
- https://developers.openai.com/api/docs/deprecations
- https://developers.openai.com/api/docs/models/gpt-4o-mini-tts
- https://developers.openai.com/api/docs/models/gpt-live-transcribe
- https://developers.openai.com/api/docs/pricing
- https://developers.openai.com/api/docs/guides/audio
- https://developers.openai.com/api/docs/guides/voice-agents
- https://developers.openai.com/api/docs/guides/live
- https://developers.openai.com/api/docs/guides/live-delegation
- https://developers.openai.com/api/docs/guides/live-conversations
- https://developers.openai.com/api/docs/guides/live-prompting
- https://developers.openai.com/api/docs/guides/live-migration
- https://developers.openai.com/api/docs/guides/realtime
- https://developers.openai.com/api/docs/guides/realtime-conversations
- https://developers.openai.com/api/docs/guides/realtime-mcp
- https://developers.openai.com/api/docs/guides/realtime-vad
- https://developers.openai.com/api/docs/guides/realtime-transcription
- https://developers.openai.com/api/docs/guides/voice-prompting
- https://developers.openai.com/api/docs/guides/voice-webrtc
- https://developers.openai.com/api/docs/guides/voice-websockets
- https://developers.openai.com/api/docs/guides/voice-server-controls
- https://developers.openai.com/api/docs/guides/voice-latency-cost
- https://developers.openai.com/api/docs/guides/text-to-speech
- https://developers.openai.com/api/docs/guides/transcription
- https://developers.openai.com/api/docs/guides/custom-voices
- https://developers.openai.com/api/docs/guides/rate-limits
- https://developers.openai.com/api/docs/guides/your-data
- https://developers.openai.com/api/docs/guides/safety-checks/under-18-api-guidance
- https://developers.openai.com/api/docs/supported-countries
- https://developers.openai.com/api/reference/resources/live/primary-websocket
- https://developers.openai.com/api/reference/resources/live/sideband-websocket
- https://developers.openai.com/api/reference/resources/realtime/client-events
- https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets/methods/create
- https://developers.openai.com/llms.txt , https://developers.openai.com/api/docs/llms.txt , https://developers.openai.com/api/reference/llms.txt

Пакеты и репозитории:
- `npm view @openai/agents` / `@openai/agents-realtime` (0.18.0, MIT), `npm view openai` (7.20.0); типы проверены по установленным пакетам (`openai/resources/live/*`, `@openai/agents-realtime/dist/*.d.ts`)
- https://github.com/openai/openai-agents-js (gh api: 3 837 ★, MIT; релизы v0.17.0–v0.18.0; `examples/docs/voice-agents/*`)
- https://github.com/laiso/whistt/issues/1 (Codex OAuth-токен не работает с Realtime)
- https://github.com/openai/codex — `codex-rs/core/src/realtime_conversation.rs` (ветка main)

Форум community.openai.com (пользовательские отчёты, средняя надёжность):
- тред «GPT Realtime 2.1 exhibits language drift» (15.07.2026)
- тред «Realtime Russian voice: any path to Custom Voices or stable pronunciation control?» (25.06–03.07.2026)

Сторонние обзоры (низкая/средняя надёжность, использованы только для контекста):
- https://www.eesel.ai/blog/gpt-live-1-review
- https://www.testingcatalog.com/openai-launches-gpt-live-1-for-full-duplex-voice-agents/
- https://aicybr.com/blog/openai-gpt-live-1-api-full-duplex-voice
- https://www.mindstudio.ai/blog/what-is-gpt-live-1-openai-voice-model
- https://gptlives.com/gpt-live-languages/ (неофициальная классификация языков; не подтверждена)

Недоступны (HTTP 403), не использованы как первоисточник: https://openai.com/index/introducing-gpt-live-1-in-the-api/ , https://openai.com/index/advancing-voice-intelligence-with-new-models-in-the-api/ , https://openai.com/policies/usage-policies/ , https://help.openai.com/en/articles/9039756

Локальные проверки: `codex --version` → 0.154.0, `codex features list` → `realtime_conversation: removed`; `say -v '?'` (macOS 26.6) → из ru_RU только Milena.
