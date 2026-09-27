# 10. Голос тренера через OpenRouter: TTS + STT + «мозг» (рация «нажми и говори»)

Источники — официальная документация OpenRouter, публичные (без авторизации) эндпоинты каталога моделей OpenRouter и документация провайдеров; каталог и цены — по состоянию на 2026-09-21. Платных вызовов при подготовке не делалось. Всё, что нельзя подтвердить без реального вызова, помечено **«НЕ ПРОВЕРЕНО»** и собрано в чек-лист §10.

> TL;DR
> 1. У OpenRouter действительно есть `POST /api/v1/audio/speech` (TTS, ответ — сырой поток байтов mp3/pcm) и `POST /api/v1/audio/transcriptions` (STT, JSON base64 **или** multipart). Realtime/WebRTC нет.
> 2. **Важная неожиданность:** OpenAI-TTS (`openai/gpt-4o-mini-tts-2025-12-15`) всё ещё упоминается в гайдах, но **в каталоге OpenRouter его уже нет** (страница модели и `/endpoints` → 404, в списке TTS-моделей отсутствует). Значит, `provider.options.openai.instructions` применять не к чему.
> 3. **Вторая неожиданность:** у Gemini 3.1 Flash TTS (лучший русский по отзывам) на OpenRouter сейчас **p50 задержки ≈ 5–6 с, p90 ≈ 27–48 с** — для живого ответа не годится, только для заранее кэшируемых фраз.
> 4. Рекомендация: TTS — `microsoft/mai-voice-2-flash` с русским голосом `ru-RU-Masha` (нужна 1 проверка, что OpenRouter принимает ru-RU голос), запасной — `x-ai/grok-voice-tts-1.0` (`eve`/`ara`, p50 ≈ 0.17 с, русский официально поддержан); Gemini (`Leda`/`Puck`) — «студийный» вариант для офлайн-кэша/прослушивания. STT — `microsoft/mai-transcribe-2` (Azure, ZDR, $0.10/час, русский, подсказка словаря) с запасным `openai/gpt-transcribe`. Мозг — `openai/gpt-5.6-luna` c `reasoning.effort:"none"` (в партии) и `openai/gpt-5.6-terra` (разбор).
> 5. Рекордер в браузере: **WAV PCM16 моно 16 кГц через AudioWorklet** — без конвертации принимается всеми STT-моделями (MAI-Transcribe принимает только WAV/MP3/FLAC; Safari-mp4 исторически ломает Whisper).

---

## 0. Как это ложится на архитектуру «Гамбитика»

```
[кнопка-микрофон зажата]  AudioWorklet → Float32 → WAV 16 kHz mono
        │ отпустили
        ▼
POST /api/voice/stt (audio/wav, ≤2 МБ) ──► OpenRouter /audio/transcriptions ──► { text }
        │
        ▼
POST /api/coach/ask { question, context(FEN, факты движка, последний вердикт) }
        │   сервер: факты из @gambit/core + LLM (chat/completions, json_schema strict, stream)
        ▼   SSE: sentence → sentence → final{ say, bubble, pose, annotationId }
POST /api/voice/tts { text }  (по предложению)  ──► диск-кэш sha256 ──► OpenRouter /audio/speech
        │
        ▼
браузер: decodeAudioData → AudioBufferSourceNode → AnalyserNode → рот маскота
```

Принцип «движок решает, код доказывает, ИИ только пересказывает» сохраняется: LLM получает готовые факты и возвращает только текст/позу/ID разрешённой аннотации. Проактивные шаблонные фразы (`CoachEvent.text`) идут в тот же `/api/voice/tts` и почти всегда попадают в кэш.

Замечание по контракту: `VoiceLayer.kind` перечисляет `'browser-tts' | 'openai-realtime' | 'silent'`. Для этого слоя нужен отдельный литерал (например, `'openrouter-ptt'`) и поле в `HealthInfo.voice` — это правка `contracts.ts`.

---

## 1. TTS: `POST https://openrouter.ai/api/v1/audio/speech`

### 1.1 Схема запроса (из OpenAPI `SpeechRequest`)

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `model` | string | да | id TTS-модели |
| `input` | string | да | текст для озвучки |
| `voice` | string (minLength 1) | зависит от провайдера | идентификатор голоса. Если не передан, запрос уйдёт только провайдерам с голосом по умолчанию, иначе 400 |
| `response_format` | `"mp3"` \| `"pcm"` | нет | **по умолчанию `pcm`** (!). Других значений в enum нет (в описании эндпоинта упомянут wav, но в схеме его нет) |
| `speed` | number | нет | множитель скорости; «используется только моделями, которые его поддерживают (OpenAI TTS)», для Azure MAI задокументирован диапазон 0.5–2.0; остальными молча игнорируется |
| `provider.options.<slug>` | object | нет | сквозные опции провайдера; пересылаются только опции того провайдера, который обслужил запрос; неизвестные ключи молча отбрасываются |
| `input_references` | array | нет | клонирование голоса (1 `input_audio` + опц. `text`), ≤ 20 МиБ base64; только у эндпоинтов с `supports_voice_cloning` (Fish Audio) |
| `session_id` | string ≤256 | нет | группировка в логах; провайдеру не отправляется |
| `user` | string ≤256 | нет | id конечного пользователя для логов; провайдеру не отправляется. **Не передавать имя ребёнка** |
| `trace` | object | нет | метаданные трассировки (Broadcast) |

Заголовки: `Authorization: Bearer sk-or-v1-…`, `Content-Type: application/json`.

### 1.2 Ответ

- `200` — **сырой поток байтов аудио, не JSON**. `Content-Type: audio/mpeg` (mp3) или `audio/pcm` (pcm, **16-bit little-endian**; по блогу-туториалу OpenRouter — «optionally with `rate` and `channels` parameters», т.е. возможен `audio/pcm;rate=24000;channels=1` — парсить заголовок). Заголовок `X-Generation-Id` — id генерации для биллинга/отладки.
- Частота PCM в доках OpenRouter не зафиксирована. По докам провайдеров: Gemini TTS — 24 кГц/16 бит/моно; MAI-Voice-2-Flash — 24 кГц моно; Grok — 24 кГц по умолчанию. **Точное значение для конкретной модели — НЕ ПРОВЕРЕНО**, читать из `Content-Type`, иначе считать 24000.
- Потоковость: в OpenAPI ответ описан как «Audio bytes stream», в гайде есть пример `with_streaming_response … stream_to_file`, в блоге: «Progressive playback requires a player that buffers the incoming chunks». То есть тело можно читать по мере поступления. **Отдаёт ли конкретный провайдер звук кусками до конца генерации — НЕ ПРОВЕРЕНО** (у Gemini через Vertex, судя по задержкам, приходит всё разом).
- Ошибки — JSON `{"error":{"code":<n>,"message":"…","metadata":{…}}}` со статусами 400/401/402/403/404/413/429/500/502/503/524/529. «Failed generations are not billed».

### 1.3 Лимит длины входа

В доках OpenRouter **общего максимума нет** («для очень длинных текстов делите на сегменты — это надёжнее и снижает задержку до первого чанка»). Ограничения провайдеров: Grok — до 15 000 символов на запрос (описание модели на OpenRouter); Gemini TTS — 8 192 входных токена, 16 384 выходных (≈ 10 мин аудио при 25 ток/с); Voxtral/Kokoro/Orpheus — контекст 4 096. Наш собственный лимит на маршруте — **600 символов** (реплика тренера всегда короче).

### 1.4 `instructions` для OpenAI и стили других провайдеров

- OpenAI: в гайде задокументировано `provider.options.openai.instructions: "Speak in a warm, friendly tone."` — **но модели OpenAI-TTS в каталоге сейчас нет** (см. §1.5), так что это справочно.
- Azure MAI-Voice: `provider.options.azure.style` (строка) и `provider.options.azure.styledegree` (число, по умолчанию 1.0) — OpenRouter сам заворачивает в SSML `mstts:express-as`. `speed` 0.5–2.0 поддержан.
- Gemini 3.1 Flash TTS: стиль задаётся **прямо в тексте** английскими аудио-тегами в квадратных скобках: `[excited]`, `[whispers]`, `[laughs]`, `[short pause]`, `[slow]`/`[fast]`, `[curious]`… (200+ тегов; теги только на английском, но работают с русским текстом; два тега подряд нельзя — между ними должен быть текст). В примерах OpenRouter: `"input": "[calm] The warm light…"`.
- Grok: inline-теги `[pause]`, `[long-pause]`, `[laugh]` и обёртки `<whisper>…</whisper>`, `<slow>…</slow>`; у нативного API есть параметр `language` (`ru` в списке, есть `auto`). Пробрасывается ли `provider.options.xai.language` — **НЕ ПРОВЕРЕНО** (автоопределение кириллицы должно сработать и так).
- Fish Audio S2.x: свободные теги на естественном языке `[whispers sweetly]`, `[laughing nervously]`.

### 1.5 ВСЕ TTS-модели в каталоге на 2026-09-21

Источник: `GET https://openrouter.ai/api/v1/models?output_modalities=speech` (18 шт.) + страницы моделей. Задержка — статистика OpenRouter за последние 30 мин на момент замера (метрика `latency`, по всем пользователям и любым длинам текста; что именно меряется для TTS — время до первого байта или до конца — **НЕ ПРОВЕРЕНО**).

| id | Цена | Голоса (`supported_voices`) | Русский | p50 / p90 задержка | ZDR-эндпоинт |
|---|---|---|---|---|---|
| `google/gemini-3.1-flash-tts-preview` | $1/M вх. токенов + $20/M вых. аудио-токенов (25 ток/с ⇒ ≈ **$0.0005/с звука**, ≈ $0.03/мин) | 30: Zephyr, Puck, Charon, Kore, Fenrir, Leda, Orus, Aoede, Callirrhoe, Autonoe, Enceladus, Iapetus, Umbriel, Algieba, Despina, Erinome, Algenib, Rasalgethi, Laomedeia, Achernar, Alnilam, Schedar, Gacrux, Pulcherrima, Achird, Zubenelgenubi, Vindemiatrix, Sadachbia, Sadaltager, Sulafat | **да, официально** (70+ языков, автоопределение; в доке Google русский `ru` в списке). Отзывы (Хабр, vc.ru): без акцента, верные ударения, сбои на редких фамилиях/омографах | **5.4–6.1 с / 27–48 с** (!) | да (google-vertex) |
| `microsoft/mai-voice-2-flash` | $15/M симв. | в каталоге OpenRouter перечислены 4: `en-US-Harper:MAI-Voice-2`, `es-MX-Valeria:…`, `fr-FR-Soleil:…`, `de-DE-Klaus:…` | модель — **да** (15 языков/18 локалей, русский в списке). У Azure есть готовые русские голоса **`ru-RU-Masha`** (ж) и **`ru-RU-Lev`** (м) со стилями adventurous, caring/empathy, curious, encouraging, excited, friendly/cheerful, nostalgic, reflective, sad/disappointed, serious. **Принимает ли OpenRouter голос вне своего списка из 4 — НЕ ПРОВЕРЕНО** | 0.75 с / 1.5 с | да (azure) |
| `microsoft/mai-voice-2` | $22/M симв. | те же 4 | то же; «приоритет натуральности над задержкой» | 1.3 с / 2.1 с | да |
| `x-ai/grok-voice-tts-1.0` | $15/M симв. | `eve`, `ara`, `rex`, `sal`, `leo` | **да, официально** (`ru` в списке 20 языков, автоопределение). Качество русского на слух — НЕ ПРОВЕРЕНО | **0.17 с / 0.22 с** | нет (xAI хранит 30 дней; уходит только текст тренера) |
| `fish-audio/s2.1-pro` (+ `fish-audio/s2.1-pro-free:free`, `s2-pro`, `s1`) | $15/M **байт UTF-8** ⇒ для кириллицы ≈ $30/M симв. | список пуст: `voice` = id голоса из библиотеки fish.audio (пример в доке `b347db033a6549378b48d00acb0d06cd`) либо клонирование через `input_references` | да, «Tier 2» (80+ языков; Tier 1 — ja/en/zh). Нужен подбор русского голоса в библиотеке — НЕ ПРОВЕРЕНО | 0.29 с / 0.66 с | да |
| `minimax/speech-2.8-turbo` / `-hd` | $60 / $100 за M симв. | 45 английских пресетов + «произвольные MiniMax voice ID» | у MiniMax русский заявлен; голоса в каталоге английские — НЕ ПРОВЕРЕНО | 0.48 с / 1.4 с | нет |
| `qwen/qwen-audio-3.0-tts-flash` / `-plus` | $15 / $20 за M симв. | `loongjohn`, `longanhuan_v3.6` / `longanlingxin`, `longanlufeng` | НЕ ПРОВЕРЕНО (голоса китайские) | 0.50 с / 1.0 с | нет |
| `mistralai/voxtral-mini-tts-2603` | $16/M симв. | 30 (en_paul_*, gb_oliver_*, gb_jane_*, fr_marie_*) | **нет** (9 языков: en, fr, de, es, nl, pt, it, hi, ar) | 0.5 с / 2.5–3.5 с | да (mistral/zdr) |
| `deepgram/aura-2` | $30/M симв. | 90 (en, es, fr, de, it, nl, ja) | нет | — | — |
| `deepgram/flux-tts:free` | бесплатно | 36 английских | нет | — | да |
| `hexgrad/kokoro-82m` | ≈ $0.6–4/M симв. | 54 (en, es, fr, hi, it, ja, pt, zh) | нет | — | — |
| `canopylabs/orpheus-3b-0.1-ft` | $15/M (на странице $7/M) | tara, leah, jess, leo, dan, mia, zac | нет (английский) | — | — |
| `sesame/csm-1b` | $7/M симв. | conversational_a/b, read_speech_a–d | нет (английский) | — | — |
| ~~`openai/gpt-4o-mini-tts-2025-12-15`~~ | — | alloy, nova, … (по гайду) | сообщество отмечает акцент в русском | — | **МОДЕЛИ НЕТ В КАТАЛОГЕ**: `/api/v1/models/openai/gpt-4o-mini-tts-2025-12-15/endpoints` → 404, страница → 404, в коллекции «Text-to-Speech» OpenAI отсутствует. В гайдах/блоге (май 2026) упоминание осталось |

Характеры голосов Gemini (дока Google): Zephyr — Bright, **Puck — Upbeat**, Charon — Informative, Kore — Firm, **Fenrir — Excitable**, **Leda — Youthful**, Orus — Firm, Aoede — Breezy, Callirrhoe — Easy-going, Autonoe — Bright, Enceladus — Breathy, Iapetus — Clear, Umbriel — Easy-going, Algieba — Smooth, Despina — Smooth, Erinome — Clear, Algenib — Gravelly, Rasalgethi — Informative, **Laomedeia — Upbeat**, Achernar — Soft, Alnilam — Firm, Schedar — Even, Gacrux — Mature, Pulcherrima — Forward, **Achird — Friendly**, Zubenelgenubi — Casual, Vindemiatrix — Gentle, **Sadachbia — Lively**, Sadaltager — Knowledgeable, **Sulafat — Warm**.

Известные ограничения Gemini TTS (дока Google): preview; иногда модель возвращает текстовые токены вместо аудио → 500, «рекомендуется повтор»; на длинных текстах голос «плывёт»; несоответствие тона промпта и голоса даёт нестабильность.

### 1.6 Рекомендация по TTS

Главное ограничение — **в приложении один голос** (маскот): кэшированные шаблоны и живые ответы должны звучать одинаково. Поэтому модель выбирается одна на всё, и она обязана быть быстрой (живой ответ) и хорошо говорить по-русски.

| Роль | Модель / голос | Почему |
|---|---|---|
| **Основной** | `microsoft/mai-voice-2-flash`, голос `ru-RU-Masha:MAI-Voice-2` (если 400 — попробовать `ru-RU-Masha:MAI-Voice-2-Flash`), стиль `excited`/`encouraging`/`curious`, `speed` 1.05 | родной русский голос (не «мультиязычный англоязычный»), стили ровно под детского тренера, p50 0.75 с, ZDR (Azure), $15/M симв. Женский молодой голос — классическое «травести» для мальчика-жеребёнка. **Риск: OpenRouter публикует только 4 голоса → нужен 1 тестовый вызов (≈ $0.001).** |
| **Запасной (и основной, если Masha не принимается)** | `x-ai/grok-voice-tts-1.0`, голос `eve` (энергичный) или `ara` (тёплый) | самый быстрый (p50 0.17 с), русский в официальном списке, $15/M симв. Минус: не ZDR (но уходит только текст тренера), качество русского надо послушать |
| **«Студийный» кандидат для прослушивания/офлайн-кэша** | `google/gemini-3.1-flash-tts-preview`, голоса `Leda` (Youthful), `Puck` (Upbeat), `Fenrir` (Excitable); стиль тегом `[excited]` | лучший русский по отзывам и тонкое управление эмоцией, ZDR (Vertex). Но p50 5–6 с — в живой диалог только если замер на коротких фразах покажет ≤1.5 с (НЕ ПРОВЕРЕНО) |

Точные JSON-запросы:

```jsonc
// A. Основной: MAI-Voice-2-Flash, русская Маша, радостно
POST https://openrouter.ai/api/v1/audio/speech
{
  "model": "microsoft/mai-voice-2-flash",
  "input": "Отличный ход! Твой конь теперь смотрит сразу на две фигуры.",
  "voice": "ru-RU-Masha:MAI-Voice-2",
  "response_format": "mp3",
  "speed": 1.05,
  "provider": { "options": { "azure": { "style": "excited", "styledegree": 1.2 } } }
}
```
```jsonc
// B. Запасной: Grok, голос eve
{
  "model": "x-ai/grok-voice-tts-1.0",
  "input": "Хм, дай подумать… [pause] Посмотри, что хочет сделать соперник?",
  "voice": "eve",
  "response_format": "mp3"
}
```
```jsonc
// C. Gemini: стиль — тегом в начале текста (тег НЕ показывать в пузыре и не класть в ключ «текста для ребёнка»)
{
  "model": "google/gemini-3.1-flash-tts-preview",
  "input": "[excited] Ура! Ты нашёл вилку! [short pause] Давай посмотрим, что будет дальше.",
  "voice": "Leda",
  "response_format": "mp3"
}
```

Соответствие `CoachEvent.kind → стиль` (адаптер на сервере, чтобы клиент о модели не знал):

| kind | Azure `style` | Gemini-тег | Grok |
|---|---|---|---|
| praise, gameEnd (победа), greeting | `excited` | `[excited]` | — |
| hint, thinkingRoutine, answer | `curious` / `encouraging` | `[curious]` | — |
| takebackOffer, threatWarning | `caring` (точное имя стиля у Flash в доке Azure записано как `caringempathy` — НЕ ПРОВЕРЕНО) | `[gently]` | `<slow>…</slow>` |
| gameEnd (поражение), encourage | `encouraging` | `[warmly]` | — |

Оценка стоимости: реплика 100 символов ≈ $0.0015 (MAI/Grok). Первичное наполнение кэша ~300 шаблонов × 80 симв. ≈ $0.36 разово. Живые ответы: 30 реплик × 120 симв. за занятие ≈ $0.05.

---

## 2. STT: `POST https://openrouter.ai/api/v1/audio/transcriptions`

### 2.1 Две формы запроса

**A. JSON + base64 (родная форма OpenRouter):**
```jsonc
{
  "model": "microsoft/mai-transcribe-2",
  "input_audio": { "data": "<base64 сырых байтов, НЕ data: URI>", "format": "wav" },
  "language": "ru",            // ISO-639-1; без него — автоопределение
  "temperature": 0,            // 0..1
  "response_format": "json",   // или "verbose_json" (language, duration, segments, words)
  "provider": { "options": { "azure": { "phraseList": { "phrases": ["ферзь","ладья","рокировка","Гамбитик"] } } } }
}
```
`input_audio.format` — строка по шаблону `^[a-zA-Z0-9][a-zA-Z0-9+._-]{0,15}$`; примеры из дока: `wav, mp3, flac, m4a, ogg, webm, aac`. «Supported formats vary by provider».

**B. OpenAI-совместимый `multipart/form-data`:** поля `file` (формат берётся из расширения имени файла или content-type части), `model`, `language`, `temperature`, `response_format` (`json` | `verbose_json`; `text`/`srt`/`vtt` → 400), `timestamp_granularities[]`, `session_id`. **`prompt` принимается, но игнорируется.** Лимит multipart — **25 МБ**; больше — только JSON base64.

Прочее: «Routing preferences (`order`, `only`, `ignore`) are not applied to transcription requests» — провайдера для STT выбрать нельзя; у многопровайдерных моделей (Whisper) опция `provider.options.groq.prompt` сработает, только если запрос случайно попал на Groq. Таймаут апстрима — **≈ 60 с обработки на запрос**; фиксированного лимита длительности нет.

### 2.2 Ответ
```json
{ "text": "Почему конь лучше пойти на эф три?",
  "usage": { "seconds": 3.4, "total_tokens": 113, "input_tokens": 83, "output_tokens": 30, "cost": 0.000094 } }
```
`usage.seconds` и `usage.cost` — всегда полезны для учёта; токены — только у токенных моделей. С `verbose_json` добавляются `language`, `duration`, `segments[]`, опц. `words[]`, `confidence` (некоторые модели, напр. `openai/gpt-4o-transcribe` и `microsoft/mai-transcribe-1.5`, на `verbose_json` отвечают 400). Заголовок `X-Generation-Id`.

### 2.3 Форматы: webm/opus из Chrome и mp4 из Safari

- `webm` и `m4a` есть в общем списке форматов OpenRouter; Whisper-модели в описании прямо перечисляют «mp3, mp4, wav, webm, flac, ogg». Значит, **Chrome `audio/webm;codecs=opus` → `format:"webm"` пройдёт у Whisper/OpenAI-моделей** (у конкретного провайдера — НЕ ПРОВЕРЕНО).
- **`microsoft/mai-transcribe-2` принимает только WAV, MP3, FLAC** (дока Azure) — webm/mp4 не пройдут. `meta/muse-voice-transcribe-1.0` — только WAV PCM16 моно 16/24 кГц.
- Safari до 18.4 пишет только **фрагментированный MP4/AAC**, который Whisper исторически отвергает («Invalid file format», лечится перепаковкой ffmpeg). С Safari 18.4 (март 2025) `audio/webm;codecs=opus` поддержан.

**Решение: писать WAV PCM16 моно 16 кГц прямо в браузере (AudioWorklet)** — без конвертации, без ffmpeg, принимается всеми 21 STT-моделью, одинаково в Chrome и Safari. Цена — размер: 32 КБ/с (10 с = 320 КБ, base64 ≈ 430 КБ) — на домашнем канале это +0.1–0.3 с против opus; приемлемо. Бонус: у нас есть сырые сэмплы → индикатор громкости, обрезка тишины и отсев «пустых» нажатий до платного вызова. Ограничения записи: мин. 0.4 с, макс. 15 с.

### 2.4 Модели STT и цены (каталог на 2026-09-21; задержка — p50/p90 OpenRouter за 30 мин)

| id | Цена | Русский | Подсказки словаря | p50 / p90 | ZDR |
|---|---|---|---|---|---|
| **`microsoft/mai-transcribe-2`** | **$0.10/час** (≈ $0.0017/мин) | да (`ru` в таблице 60 языков; №1 на FLEURS по заявлению MS; «устойчив к шуму») | `provider.options.azure.phraseList.phrases`; стиль `provider.options.azure.enhancedMode.modelOptions.transcribeStyle: "clean"` убирает «э-э», фальстарты | 0.53 с / 1.5 с | **да** (один провайдер — Azure) |
| **`openai/gpt-transcribe`** (вышла 28.07.2026, преемник gpt-4o-transcribe) | $0.000075/с = $0.0045/мин | да (мультиязычная) | «free-form context, keyword hints, multiple language hints» у OpenAI; как пробросить через OpenRouter (`provider.options.openai.prompt`?) — **НЕ ПРОВЕРЕНО** | 0.59 с / 1.1 с | нет (OpenAI хранит) |
| `openai/gpt-4o-transcribe` | $2.5/M вх. + $10/M вых. токенов (≈ $0.006/мин) | да | то же, НЕ ПРОВЕРЕНО | 0.78 с / 2.1 с | нет |
| `openai/gpt-4o-mini-transcribe` | $1.25/M + $5/M (≈ $0.003/мин) | да | — | 0.69 с / 1.5 с | нет |
| `openai/whisper-large-v3` | $0.0000075–0.0000308/с (DeepInfra / Together / Groq) | да (99+ языков, WER 10.3%) | только если попали на Groq: `provider.options.groq.prompt` | DeepInfra 1.5 с / 4.5 с; Together 0.62 с; Groq 0.35 с (провайдера выбрать нельзя, основной трафик идёт на дешёвый DeepInfra) | да (все три) |
| `openai/whisper-large-v3-turbo` | $0.00000333/с | да (WER 12%) | — | DeepInfra 0.95 с; Groq 0.37 с | да |
| `openai/whisper-1` | $0.0001/с ($0.006/мин) | да | — | — | нет |
| `google/chirp-3` | $0.000267/с ($0.016/мин) | да | — | 1.8 с / 4.6 с | да |
| `deepgram/nova-3` | $0.000072/с (мультиязычный $0.000087/с) | да | allowlist опций: `punctuate, diarize, smart_format, detect_language` | 0.95 с / 2.3 с | да |
| `mistralai/voxtral-mini-transcribe` | $0.00005/с | да (Voxtral) — НЕ ПРОВЕРЕНО | — | 0.53 с / 1.6 с | да (mistral/eu) |
| `x-ai/grok-stt-1.0` | $0.0000278/с | НЕ ПРОВЕРЕНО | — | 1.05 с / 2.6 с | нет |
| `qwen/qwen3-asr-flash-2026-02-10` | $0.000035/с | да (11 языков, русский в списке; «контекстный текст для словаря») | контекст | — | нет |
| прочие: `meta/muse-voice-transcribe-1.0` ($0.00005/с, только WAV), `nvidia/parakeet-tdt-0.6b-v3`, `nvidia/nemotron-3.5-asr-…`, `qwen/qwen3-asr-0.6b/1.7b`, `mistralai/voxtral-small-24b-2507-stt`, `voxtral-mini-3b-2507`, `fish-audio/transcribe-1`, `microsoft/mai-transcribe-1.5` ($0.36/час) | | | | | |

### 2.5 Что лучше для РЕБЁНКА, говорящего по-русски

Публичных бенчмарков «детская русская речь» нет ни у одной модели — **НЕ ПРОВЕРЕНО, нужен свой мини-тест** (20 записанных фраз ребёнка → WER по трём моделям, стоимость < $0.05). Исходная расстановка:

1. **Основной: `microsoft/mai-transcribe-2`** — голос ребёнка самые чувствительные данные, а это единственный топ-кандидат с гарантированным ZDR (один провайдер Azure), плюс подсказка шахматного словаря, стиль `clean`, самая низкая цена и p50 0.53 с.
2. **Запасной / A/B: `openai/gpt-transcribe`** — семейство OpenAI, высокая точность, p50 0.59 с; минус — данные хранятся у OpenAI (до 30 дней для abuse-мониторинга), подсказки словаря через OpenRouter не подтверждены.
3. Третий: `openai/whisper-large-v3` (ZDR, дёшево), но: нельзя выбрать быстрый Groq; Whisper на тишине/шуме **галлюцинирует русские субтитры** («Субтитры сделал DimaTorzok», «Продолжение следует…», «Спасибо за просмотр!» — известная по сообществу проблема) → обязателен фильтр.

Шахматный словарь для `phraseList` (короткий, 30–50 слов): названия фигур во всех частых падежах, «рокировка, шах, мат, пат, вилка, связка, зевок, гамбит, дебют, эндшпиль, ничья, подсказка, верни ход, Гамбитик», имена ботов (Петя, Соня, Гриша, Саша, Вика, Лёва, Ника, Дима), буквы-поля как говорят дети: «е четыре, дэ пять, эф три, же шесть, аш семь».

---

## 3. «Мозг» тренера: `POST https://openrouter.ai/api/v1/chat/completions`

### 3.1 Модели OpenAI в каталоге (цены OpenRouter, за 1M токенов)

| id | Вход / выход | Кэш-чтение | Reasoning | Контекст | Замечание |
|---|---|---|---|---|---|
| **`openai/gpt-5.6-luna`** (09.07.2026) | **$0.20 / $1.20** | $0.02 | efforts: max…low, **`none`**; по умолчанию medium (включён) | 1.05M | «fast, cost-efficient… latency-sensitive chat». Тот же модельный ряд, что уже выбран в проекте для Codex |
| `openai/gpt-5.4-mini` (17.03.2026) | $0.75 / $4.50 | $0.075 | по умолчанию **выключен** | 400k | p50 TTFT ≈ 1.0 с, ~68 ток/с |
| `openai/gpt-5.4-nano` | $0.20 / $1.25 | $0.02 | выключен по умолчанию | 400k | p50 ≈ 1.1 с, ~66 ток/с |
| `openai/gpt-4.1-mini` | $0.40 / $1.60 | $0.10 | нет | 1M | p50 ≈ 1.0 с, ~36 ток/с; поддерживает `temperature` |
| `openai/gpt-chat-latest` | $5 / $30 | $0.5 | нет | 400k | алиас Instant-модели ChatGPT; дорого |
| **`openai/gpt-5.6-terra`** | **$2 / $12** (та же цена на Azure-ZDR) | $0.2 | есть, вкл. `none` | 1.05M | «balanced» — для разборов партии |
| `openai/gpt-5.6-sol` | $2 / $10 у OpenAI; **$5 / $30 на Azure (ZDR)** | $0.2 | есть | 1.05M | флагман 5.6 |
| `openai/gpt-6-astra` (04.09.2026) | $10 / $50 | $1 | **обязателен** (нет `none`) | 1.05M | избыточно и дорого |

Замеры OpenRouter (30 мин, весь трафик, **с включённым reasoning у большинства клиентов**): `gpt-5.6-luna` — p50 до первого токена 2.1 с (openai), 1.6 с (`openai/fast`, приоритетный тариф $0.40/$2.40), 1.5 с (azure/eu), 0.76 с (Bedrock, но там нет `structured_outputs`); пропускная ~63–84 ток/с. С `reasoning.effort:"none"` TTFT должен упасть до уровня нерассуждающих моделей (≈ 0.6–1.0 с) — **НЕ ПРОВЕРЕНО, замерить первым же вызовом**.

**Рекомендация:**
- (a) быстрые ответы в партии: **`openai/gpt-5.6-luna`**, `reasoning: { effort: "none" }`, `max_completion_tokens: 200`, stream; фолбэк `models: ["openai/gpt-5.6-luna", "openai/gpt-5.4-mini"]`. Если замер покажет TTFT > 1.2 с — поменять местами (у 5.4-mini измеренный p50 ≈ 1.0 с).
- (b) разбор партии: **`openai/gpt-5.6-terra`**, `reasoning: { effort: "low" }` (или `medium`), без стрима, `max_completion_tokens: 4000`. «Максимум качества» — `openai/gpt-5.6-sol`.

Стоимость: вопрос в партии ≈ 1 500 вх. + 80 вых. токенов ⇒ $0.0004 (Luna); 30 вопросов за занятие ≈ **$0.012**. Разбор партии ≈ 6k вх. + 1.5k вых. + reasoning ⇒ ≈ $0.03–0.05 (Terra).

### 3.2 Structured outputs (strict JSON Schema)

```jsonc
POST /api/v1/chat/completions
{
  "model": "openai/gpt-5.6-luna",
  "models": ["openai/gpt-5.6-luna", "openai/gpt-5.4-mini"],   // автофолбэк между моделями
  "stream": true,
  "reasoning": { "effort": "none" },
  "max_completion_tokens": 200,
  "messages": [
    { "role": "system", "content": "<COACH_SYSTEM_PROMPT_RU — статичный, ≥1024 токенов в начале ⇒ авто-кэш OpenAI>" },
    { "role": "user", "content": "ФАКТЫ (от движка, не спорь с ними): …\nРАЗРЕШЁННЫЕ ПОКАЗЫ: a1=стрелка g1→f3 …\nВОПРОС РЕБЁНКА: «почему конь лучше на эф три?»" }
  ],
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "coach_answer",
      "strict": true,
      "schema": {
        "type": "object",
        "properties": {
          "say":    { "type": "string", "description": "1–3 коротких предложения по-русски для озвучки. Без латиницы и нотации: «конь на эф три»." },
          "bubble": { "type": "string", "description": "То же для пузыря, можно Кf3." },
          "pose":   { "type": "string", "enum": ["talk","think","cheer","oops","idle"] },
          "intent": { "type": "string", "enum": ["answer","hint","explain","smalltalk","offtopic"] },
          "annotationId": { "type": ["string","null"], "description": "id из списка РАЗРЕШЁННЫЕ ПОКАЗЫ или null" }
        },
        "required": ["say","bubble","pose","intent","annotationId"],
        "additionalProperties": false
      }
    }
  },
  "provider": { "data_collection": "deny", "zdr": true, "require_parameters": true }
}
```
Правила strict-режима OpenAI: все поля в `required`, `additionalProperties:false`, опциональность — через `["string","null"]`. **`say` стоит первым**, чтобы при стриминге первое предложение появилось раньше остальных полей (см. §5). Поддержка определяется **по эндпоинту**: у `gpt-5.6-luna` `structured_outputs` есть у OpenAI и Azure, **нет у Amazon Bedrock**. `require_parameters:true` гарантирует маршрут только на эндпоинты, понимающие все параметры (и без него `response_format`/`tools` — «мягкое предпочтение»).

Тонкость: у Azure-эндпоинтов в `supported_parameters` значится `max_completion_tokens`, у OpenAI — `max_tokens`. С `zdr:true` + `require_parameters:true` безопаснее слать **`max_completion_tokens`**; не исключит ли это OpenAI-эндпоинты при `zdr:false` — **НЕ ПРОВЕРЕНО** (при проблеме убрать `require_parameters`).

### 3.3 Tool calling

Формат OpenAI: `tools: [{ "type":"function", "function": { "name", "description", "parameters": <JSON Schema> } }]`, `tool_choice: "auto" | "none" | "required" | {"type":"function","function":{"name":"…"}}`, `parallel_tool_calls: false`. Ответ — `message.tool_calls[{id,type:"function",function:{name,arguments:"<json-строка>"}}]`, далее сообщение `{"role":"tool","tool_call_id","content"}` и повторный вызов (tools нужно передавать в каждом запросе). Для push-to-talk инструменты **не рекомендую**: каждый вызов — лишний круг 0.8–2 с. Сервер заранее кладёт в промпт всё, что вернул бы `CoachToolHost` (сводка позиции, факты, последний вердикт, список разрешённых показов), и получает ответ за один проход. Tools оставить для разборов партии, где задержка не важна.

### 3.4 Стриминг

`"stream": true` → SSE. Строки-комментарии `: OPENROUTER PROCESSING` — keep-alive, не JSON, пропускать. Текст — в `choices[0].delta.content`. Последний чанк перед `data: [DONE]` несёт `usage`. Ошибка посреди потока приходит как чанк с верхнеуровневым `error` и `finish_reason:"error"` при HTTP 200. Отмена — `AbortController.abort()` (у поддерживающих провайдеров останавливает генерацию и биллинг) — использовать, когда ребёнок перебил тренера.

### 3.5 Политика данных (пользователь — ребёнок)

Поля `provider`:

| Поле | Значение | Эффект |
|---|---|---|
| `data_collection` | `"deny"` | только провайдеры, которые не собирают данные (не обучаются/не хранят нетранзитно); по умолчанию `"allow"` |
| `zdr` | `true` | только эндпоинты с Zero Data Retention. Работает как «ИЛИ» с настройками аккаунта: включить можно, выключить — нельзя |
| `require_parameters` | `true` | только эндпоинты, понимающие все параметры |
| `only` / `order` / `ignore` | `["azure"]` … | ручной выбор провайдера (база `azure` матчит все регионы; тарифные `openai/fast`, `…/flex` — только явным слагом) |
| `sort` | `"latency"` \| `"throughput"` \| `"price"` | отключает балансировку по цене; шорткаты `:nitro` (throughput + priority-tier), `:floor` |
| `preferred_max_latency` | число (с) или `{p50,p90}` | мягкое предпочтение |
| `allow_fallbacks` | bool | запрет перехода на других провайдеров |

Что это значит на практике (данные `GET /api/v1/endpoints/zdr` и таблицы провайдеров):
- Модели OpenAI с `zdr:true` обслуживает **только Azure** (`azure`, `azure/us`, `azure/eu`): Luna/Terra — по той же цене, Sol — в 2.5–3 раза дороже. Задержка Azure у Luna в среднем хуже, чем у OpenAI (p50 4.1 с против 2.1 с на общем трафике; `azure/eu` — 1.5 с). Рекомендация: **`zdr:true` по умолчанию + флаг `OR_ZDR=false` в конфиге**, решение — по замеру. В LLM уходит только текст (транскрипт + факты позиции, псевдоним), голоса там нет.
- OpenAI как провайдер: не обучается на API-данных, **но хранит промпты** (`retainsPrompts:true`, `requiresUserIDs:true` — OpenRouter передаёт анонимный id пользователя). Azure, Google Vertex, Groq, DeepInfra, Together, Fish Audio, Deepgram — «zero retention»; Mistral и xAI — 30 дней; Google AI Studio — 55 дней; MiniMax — хранит.
- Плагины/веб-поиск под ZDR не подпадают — не включать.
- То же самое лучше продублировать **на уровне аккаунта**: https://openrouter.ai/settings/privacy → запретить провайдеров, обучающихся на данных (платные и бесплатные модели), включить ZDR по группам (OpenAI → останется Azure; «All other models»). Это единственный способ ограничить STT, где `provider`-предпочтения маршрутизации не применяются.

### 3.6 Заголовки

```
Authorization: Bearer sk-or-v1-…        (только на сервере, из .env; в браузер не попадает)
Content-Type: application/json
HTTP-Referer: http://localhost:8787      (необязательно — атрибуция приложения)
X-OpenRouter-Title: Gambitik             (новое имя заголовка; X-Title поддерживается для совместимости)
X-OpenRouter-App-Visibility: hidden      (приложение не попадёт в публичные рейтинги/маркетплейс)
```
Атрибуция нужна только для публичных рейтингов OpenRouter. Без `HTTP-Referer` страница приложения не создаётся вовсе; для localhost она создаётся только вместе с `X-OpenRouter-Title`. **Для детского приватного приложения — либо не слать эти заголовки совсем (рекомендую), либо слать с `X-OpenRouter-App-Visibility: hidden`** (учитывается только в момент первого создания записи приложения).

---

## 4. Аудио-выход прямо из chat completions (`modalities: ["text","audio"]`)

Возможность есть: `openai/gpt-audio` и `openai/gpt-audio-mini` (вход text+audio → выход text+audio, поддерживают tools и structured outputs по карточке OpenRouter).

```jsonc
{ "model": "openai/gpt-audio-mini",
  "modalities": ["text","audio"],
  "audio": { "voice": "alloy", "format": "pcm16" },   // в примере OpenRouter — "wav"; у OpenAI для stream нужен pcm16 — НЕ ПРОВЕРЕНО
  "stream": true,                                       // ОБЯЗАТЕЛЬНО: «Audio output requires streaming»
  "messages": [ { "role":"user", "content":[ { "type":"input_audio", "input_audio": { "data":"<base64>", "format":"wav" } } ] } ] }
```
Чанки: `choices[0].delta.audio.data` (base64-кусок) и `delta.audio.transcript`. Входные форматы: wav, mp3, aiff, aac, ogg, flac, m4a, pcm16, pcm24.

Цены: `gpt-audio` — текст $2.5/$10, аудио **$32 вх. / $64 вых.** за 1M токенов (≈ $0.02/мин входа и ≈ $0.08/мин речи при ~10/20 ток/с — оценка); `gpt-audio-mini` — на OpenRouter указано $0.60/$2.40 и для аудио, тогда как официальный прайс OpenAI — аудио $10/$20 (**расхождение, НЕ ПРОВЕРЕНО**, по факту смотреть `usage.cost`). Для сравнения отдельный TTS: ~840 симв./мин × $15/M ≈ **$0.013/мин речи**.

Задержка: p50 до первого токена ≈ 0.54 с (обе модели) и звук идёт сразу — экономит один круг (~0.5–1 с) и даже STT (можно слать аудио ребёнка напрямую).

**Вердикт: не основным путём.** Причины: (1) голоса OpenAI-семейства в русском звучат с акцентом (отзывы; у realtime-2.1 замечен «уход в английский»); (2) **несовместимо со структурным JSON-ответом** — модель озвучивает то же, что пишет, т.е. прочитает JSON вслух; пришлось бы переводить позу/аннотации на tool calls; (3) ничего нельзя кэшировать; (4) голос не совпадёт с кэшированными шаблонными фразами (нарушение «один голос»); (5) только первый-party OpenAI, не ZDR, а во вход уходит голос ребёнка; (6) дороже отдельного TTS (у `gpt-audio`). Оставить как эксперимент за тем же `VoiceLayer`.

---

## 5. Бюджет задержки одного хода «рации» и приёмы

Оценка по p50/p90 OpenRouter (не наш замер — **НЕ ПРОВЕРЕНО** на месте):

| Этап | p50 | p90 |
|---|---|---|
| отпустили кнопку → WAV → локальный сервер | 0.03 с | 0.05 с |
| STT (`mai-transcribe-2` / `gpt-transcribe`), 3–6 с речи, аплоад ~150 КБ | 0.6 с | 1.5 с |
| сбор фактов (кэш анализа судьи уже есть) | 0.05 с | 0.1 с |
| LLM до конца первого предложения (`luna`, effort none, stream) | 1.0–1.3 с | 2.5 с |
| TTS первого предложения (MAI-Flash 0.75 с / Grok 0.17 с) + загрузка mp3 | 0.3–0.9 с | 1.7 с |
| `decodeAudioData` + старт | 0.04 с | 0.08 с |
| **Итого до первого слова ответа** | **≈ 2.0–2.9 с** | **≈ 4.5–6 с** |

Приёмы (по убыванию эффекта):
1. **Мгновенная реакция локально**: в момент отпускания кнопки — поза `think`, звук «дзынь»; если через 600 мс ответа ещё нет — кэшированный филлер («Хм, дай подумать…», «Так-так…», «Интересный вопрос!», 6–8 вариантов, не чаще 2 раз из 3). Филлеры предзагружаются в `AudioBuffer` при `init()` → воспринимаемая задержка ≈ 0.
2. **Без LLM, когда можно**: после STT — детерминированный классификатор намерения по ключевым словам («подскажи/помоги», «почему», «какой лучший ход», «верни ход», «кто выигрывает»). Совпало → `CoachToolHost.getHint()/explainLastMove()` + шаблон из `@gambit/core/coach` → почти всегда **попадание в TTS-кэш**, ответ через ~0.7 с. LLM — только для свободных вопросов.
3. **Стрим LLM + нарезка по предложениям**: `say` — первое поле схемы; инкрементально вытаскивать завершённые предложения из частичного JSON и сразу слать в TTS; предложение №2 синтезируется, пока играет №1 (параллелизм 2).
4. **Короткие ответы**: 1–3 предложения, `max_completion_tokens: 200`, `reasoning.effort:"none"`.
5. **Кэш промпта**: статичный системный промпт ≥1024 токенов в начале, изменяемые факты — в конце ⇒ авто-кэш OpenAI (чтение $0.02/M) и ниже TTFT.
6. **Тёплое соединение**: один общий keep-alive HTTP-агент (undici в Node держит соединения сам); при старте партии прогревающий `GET /api/v1/key` (заодно проверка кредитов).
7. **Дисковый TTS-кэш + предгенерация**: скрипт один раз прогоняет все варианты шаблонов (приветствия, похвала, ритуал мышления, филлеры); динамические вставки («конь на эф три») — отдельными предложениями, чтобы статичная часть кэшировалась.
8. **Обрезка тишины** в начале/конце записи; нажатия < 0.4 с и тихие (RMS < порога) — не отправлять.
9. `provider.sort:"latency"` или `openai/gpt-5.6-luna:nitro` (подключает priority-tier `openai/fast` по $0.40/$2.40) — если замеры покажут выигрыш; несовместимо с `zdr:true` (у Azure priority-tier нет).
10. Дедупликация одновременных одинаковых TTS-запросов (map «ключ → Promise»).
11. v2: `response_format:"pcm"` + потоковое проигрывание (планирование `AudioBuffer`-кусков по мере чтения тела) — только если провайдер реально стримит (НЕ ПРОВЕРЕНО).

---

## 6. Кредиты, лимиты, ошибки

### 6.1 Остаток
- **`GET https://openrouter.ai/api/v1/key`** (обычный ключ `sk-or-v1-…`):
```ts
type KeyInfo = { data: {
  label: string;
  limit: number | null;            // лимит кредитов на ключ; null = без лимита
  limit_reset: string | null;      // период сброса лимита
  limit_remaining: number | null;  // остаток по лимиту ключа; null = без лимита
  include_byok_in_limit: boolean;
  usage: number; usage_daily: number; usage_weekly: number; usage_monthly: number;   // в долларах-кредитах
  byok_usage: number; byok_usage_daily: number; byok_usage_weekly: number; byok_usage_monthly: number;
  is_free_tier: boolean;
  free_model_daily_requests: { used: number; limit: number; remaining: number };
} };
```
- **`GET /api/v1/credits`** → `{ data: { total_credits, total_usage } }`, **но требует Management-ключ** (обычному ключу — 403 «Only management keys can perform this operation»). Management-ключ в приложение класть не нужно.
- **Рекомендация родителю:** создать отдельный ключ «Gambitik» с **лимитом кредитов** (напр. $10, сброс ежемесячно). Тогда `limit_remaining` — честный «остаток на голос», и это же потолок расходов. Статус для родителя: «Осталось ≈ $7.40 из $10 · сегодня потрачено $0.12»; при `limit_remaining < 1` — жёлтый, при 402 — красный + авто-переход на `speechSynthesis`.

### 6.2 Лимиты запросов
Для платных моделей поминутных лимитов OpenRouter нет (только Cloudflare DDoS-защита; лимиты «общие на аккаунт», новые ключи их не увеличивают). Бесплатные `:free`-модели: 20 запр./мин; 50/день при покупках < 10 кредитов, 1000/день при ≥ 10. 429 от апстрима OpenRouter сначала пробует обойти фолбэком на другого провайдера. Успешные ответы `X-RateLimit-*` не содержат; на 429/503 (и на 402 `in_flight`) может быть `Retry-After`.

### 6.3 Классификация ошибок
Формат: `{ "error": { "code": 402, "message": "…", "metadata": { "error_type": "…", "limit_source": "…", "reason": "…", "provider_name": "…", "provider_code": "…" } } }`. Ветвиться по `metadata.error_type`, а не по тексту.

| HTTP | `error_type` | Причина | Действие приложения |
|---|---|---|---|
| 400 | `invalid_request`, `invalid_prompt`, `context_length_exceeded`, `string_too_long` | наш баг / неподдерживаемый голос или формат аудио | не повторять; лог; фолбэк-модель (другой голос/формат) |
| 401 | `authentication` | ключ неверен/отозван | голос выключить, родителю: «Проверьте ключ» |
| **402** | `payment_required` | `limit_source`: `openrouter_credits` (баланс), `openrouter_key_limit` (лимит ключа), `openrouter_in_flight_budget` (временная блокировка «в полёте» — ждать `Retry-After` и повторить) | первые два → перейти на бесплатный голос браузера + плашка родителю «Пополните кредиты»; третий → 1 повтор |
| 403 | `permission_denied`, `content_policy_violation`, `refusal` | guardrail / модерация / отказ модели | шаблонная фраза «Давай лучше про шахматы!» |
| 404 | `not_found` | модель снята (как OpenAI-TTS!) или ни один провайдер не проходит фильтры (`zdr`) | фолбэк-модель; в health — предупреждение |
| 408 / 524 | — | таймаут | 1 повтор, потом фолбэк |
| 413 | `payload_too_large` | слишком длинная запись | не должно случаться (лимит 15 с) |
| **429** | `rate_limit_exceeded` | лимит OpenRouter или апстрима | `Retry-After`, 1 повтор с паузой ≤ 1 с, потом фолбэк-модель |
| 502 / 503 / 529 | `provider_unavailable`, `provider_overloaded` | апстрим упал/перегружен («failed generations are not billed») | сразу фолбэк-модель; circuit breaker на 60 с |
| 200 + `finish_reason:"error"` в SSE | то же | обрыв посреди стрима | доиграть уже полученные предложения, остальное — шаблон |
| 200, пустой `content`, `finish_reason:"length"` | — | reasoning съел весь `max_tokens` | наш случай исключён `effort:"none"` |

---

## 7. Приватность детского голоса

**Что хранит OpenRouter по умолчанию:** промпты и ответы **не хранит**; любое хранение — opt-in: (1) *Private Input & Output Logging* (Observability; выключено; при включении хранится ≥ 3 месяцев в изолированном GCS — **не включать**; можно исключить конкретный ключ); (2) *OpenRouter Use of Inputs/Outputs* за скидку 1% (**не включать**). Метаданные (время, модель, число токенов/секунд, стоимость) хранятся всегда. «Anonymous input categorization» — малая выборка промптов классифицируется ZDR-моделью анонимно. Политика хранения для самого аудио в `/audio/*` отдельно не описана — считаем как «промпт» (**НЕ ПРОВЕРЕНО**).

**Провайдеры:** см. §3.5. Голос ребёнка уходит только в STT-провайдера ⇒ выбираем ZDR-эндпоинт (`microsoft/mai-transcribe-2` → Azure; Whisper → Groq/DeepInfra/Together; `google/chirp-3` → Vertex; `deepgram/nova-3`). `openai/gpt-transcribe` — не ZDR.

**Как минимизировать (чек-лист реализации):**
1. Только push-to-talk: микрофон открыт, пока зажата кнопка; поза `listen` + видимый индикатор; `MediaStream` останавливать (`track.stop()`) после каждого нажатия — индикатор микрофона в браузере гаснет.
2. Аудио **не писать на диск** нигде (ни WAV, ни base64 в логах); в журнал партии идёт только текст транскрипта (локально).
3. В запросы не класть имя/возраст/школу: псевдоним, поле `user` не слать (или константа `"student"`), `session_id` — случайный id партии.
4. STT — на ZDR-модель; LLM — `provider.data_collection:"deny"` (+ `zdr:true` по флагу); TTS получает только текст тренера.
5. Настройки аккаунта OpenRouter (делает родитель): Privacy → запрет обучающихся провайдеров, ZDR-тогглы; Observability → I/O logging **off**; Broadcast — не настраивать; плагины/веб-поиск — off.
6. Отдельный ключ с лимитом кредитов; ключ только в `.env` сервера; маршруты `/api/voice/*` защищены теми же Host/Origin-проверками и лимитами размера тела, что и остальные.
7. Системный промпт: не спрашивать личные данные, не обсуждать ничего кроме шахмат и поддержки; ответы LLM ≤ 3 предложений; фильтр транскрипта перед LLM (если ребёнок назвал адрес/телефон — не пересылать, ответить шаблоном).
8. Атрибуцию приложения не слать (или `hidden`).
9. В настройках приложения — родительский тумблер «Голосовые вопросы (нужен интернет, звук отправляется на распознавание)», по умолчанию выключен до явного согласия родителя.

---

## 8. Эскиз сервера (Hono, Node 26, без SDK — чистый `fetch`)

Env (добавить в `.env.example` — правит ответственный за модуль server): `OPENROUTER_API_KEY=`, `OR_TTS_MODEL=microsoft/mai-voice-2-flash`, `OR_TTS_VOICE=ru-RU-Masha:MAI-Voice-2`, `OR_TTS_FALLBACK_MODEL=x-ai/grok-voice-tts-1.0`, `OR_TTS_FALLBACK_VOICE=eve`, `OR_STT_MODEL=microsoft/mai-transcribe-2`, `OR_STT_FALLBACK_MODEL=openai/gpt-transcribe`, `OR_COACH_MODEL=openai/gpt-5.6-luna`, `OR_COACH_FALLBACK_MODEL=openai/gpt-5.4-mini`, `OR_REVIEW_MODEL=openai/gpt-5.6-terra`, `OR_ZDR=true`.

```ts
// apps/server/src/voice/openrouter.ts
const OR = 'https://openrouter.ai/api/v1';

export class OpenRouterError extends Error {
  status: number; errorType: string | undefined; limitSource: string | undefined; retryAfterSec: number | undefined;
  constructor(status: number, message: string, meta?: { error_type?: string; limit_source?: string }, retryAfterSec?: number) {
    super(message); this.status = status; this.errorType = meta?.error_type; this.limitSource = meta?.limit_source; this.retryAfterSec = retryAfterSec;
  }
  get kind(): 'no-credits' | 'rate-limited' | 'auth' | 'bad-request' | 'blocked' | 'upstream' {
    if (this.status === 402) return this.limitSource === 'openrouter_in_flight_budget' ? 'rate-limited' : 'no-credits';
    if (this.status === 429) return 'rate-limited';
    if (this.status === 401) return 'auth';
    if (this.status === 403) return 'blocked';
    if (this.status === 400 || this.status === 404 || this.status === 413) return 'bad-request';
    return 'upstream';
  }
}

export async function orFetch(key: string, path: string, init: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<Response> {
  const res = await fetch(OR + path, {
    method: init.method ?? 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, // атрибуцию сознательно не шлём
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  });
  if (res.ok) return res;
  let message = `OpenRouter HTTP ${res.status}`; let meta: { error_type?: string; limit_source?: string } | undefined;
  try { const j = (await res.json()) as { error?: { message?: string; metadata?: typeof meta } }; message = j.error?.message ?? message; meta = j.error?.metadata; } catch { /* тело не JSON */ }
  const ra = Number(res.headers.get('Retry-After'));
  throw new OpenRouterError(res.status, message, meta, Number.isFinite(ra) && ra > 0 ? ra : undefined);
}
```

```ts
// apps/server/src/routes/voiceTts.ts — POST /api/voice/tts  { text: string; style?: 'neutral'|'excited'|'curious'|'caring'|'encouraging' }
import { createHash } from 'node:crypto';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';

const Body = z.object({ text: z.string().trim().min(1).max(600), style: z.enum(['neutral','excited','curious','caring','encouraging']).default('neutral') });
const inflight = new Map<string, Promise<Buffer>>();

interface TtsTarget { model: string; voice: string }

/** Адаптер «стиль → запрос конкретной модели». Клиент о модели ничего не знает. */
function buildSpeechRequest(t: TtsTarget, text: string, style: string) {
  const base = { model: t.model, voice: t.voice, response_format: 'mp3' as const };
  if (t.model.startsWith('microsoft/mai-voice'))
    return { ...base, input: text, speed: 1.05, provider: { options: { azure: style === 'neutral' ? {} : { style, styledegree: 1.2 } } } };
  if (t.model.startsWith('google/gemini'))
    return { ...base, input: style === 'neutral' ? text : `[${style === 'caring' ? 'gently' : style}] ${text}` };
  return { ...base, input: text }; // grok, fish, …
}

export function ttsRoute(cfg: { key: string | null; primary: TtsTarget; fallback: TtsTarget; cacheDir: string }) {
  const app = new Hono();
  app.post('/', async (c) => {
    if (!cfg.key) return c.json({ error: 'no-api-key' }, 503);
    const { text, style } = Body.parse(await c.req.json());
    const norm = text.replace(/\s+/g, ' ');

    for (const target of [cfg.primary, cfg.fallback]) {
      const hash = createHash('sha256').update([target.model, target.voice, style, 'mp3', norm].join('|')).digest('hex');
      const file = join(cfg.cacheDir, hash.slice(0, 2), `${hash}.mp3`);
      if (await stat(file).then(() => true, () => false)) {
        c.header('Content-Type', 'audio/mpeg'); c.header('X-Tts-Cache', 'hit'); c.header('Cache-Control', 'private, max-age=31536000, immutable');
        return c.body(Readable.toWeb(createReadStream(file)) as ReadableStream);
      }
      try {
        let job = inflight.get(hash);
        if (!job) {
          job = (async () => {
            const res = await orFetch(cfg.key!, '/audio/speech', { body: buildSpeechRequest(target, norm, style), signal: AbortSignal.timeout(8000) });
            const buf = Buffer.from(await res.arrayBuffer());             // фразы короткие (20–60 КБ) — буферизуем целиком
            if (buf.length < 256) throw new OpenRouterError(502, 'empty audio');
            await mkdir(join(cfg.cacheDir, hash.slice(0, 2)), { recursive: true });
            await writeFile(`${file}.tmp`, buf); await rename(`${file}.tmp`, file);  // атомарно
            return buf;
          })().finally(() => inflight.delete(hash));
          inflight.set(hash, job);
        }
        const buf = await job;
        c.header('Content-Type', 'audio/mpeg'); c.header('X-Tts-Cache', 'miss');
        return c.body(new Uint8Array(buf));
      } catch (e) {
        if (e instanceof OpenRouterError && (e.kind === 'no-credits' || e.kind === 'auth')) return c.json({ error: e.kind }, 503);
        // иначе пробуем fallback-модель
      }
    }
    return c.json({ error: 'tts-unavailable' }, 502);   // клиент переключится на speechSynthesis
  });
  return app;
}
```
Кэш: `data/cache/tts/<2 hex>/<sha256>.mp3`, ключ `sha256(model|voice|style|format|text)` (стиль и формат обязаны входить в ключ; при смене голоса старые файлы просто перестают использоваться). Очистка — LRU по `atime` при превышении, например, 200 МБ.

```ts
// apps/server/src/routes/voiceStt.ts — POST /api/voice/stt   тело: сырые байты audio/wav (≤ 2 МБ)
import { bodyLimit } from 'hono/body-limit';

const CHESS_PHRASES = ['ферзь','ладья','слон','конь','пешка','король','рокировка','шах','мат','пат','вилка','связка','зевок','гамбит','подсказка','верни ход','Гамбитик'];
const HALLUCINATIONS = [/субтитры (сделал|создавал|подогнал)/i, /продолжение следует/i, /спасибо за просмотр/i, /редактор субтитров/i, /dimatorzok/i];

function buildSttRequest(model: string, wavBase64: string) {
  const base = { model, input_audio: { data: wavBase64, format: 'wav' }, language: 'ru', temperature: 0, response_format: 'json' };
  if (model.startsWith('microsoft/mai-transcribe'))
    return { ...base, provider: { options: { azure: { phraseList: { phrases: CHESS_PHRASES }, enhancedMode: { modelOptions: { transcribeStyle: 'clean' } } } } } };
  if (model.startsWith('openai/whisper'))
    return { ...base, provider: { options: { groq: { prompt: `Шахматы: ${CHESS_PHRASES.join(', ')}.` } } } };  // сработает только на Groq
  return base;
}

export function sttRoute(cfg: { key: string | null; models: string[] }) {
  const app = new Hono();
  app.post('/', bodyLimit({ maxSize: 2 * 1024 * 1024 }), async (c) => {
    if (!cfg.key) return c.json({ error: 'no-api-key' }, 503);
    if (!(c.req.header('content-type') ?? '').startsWith('audio/wav')) return c.json({ error: 'wav-only' }, 415);
    const wav = Buffer.from(await c.req.arrayBuffer());
    if (wav.length < 44 + 16000 * 2 * 0.4 || wav.subarray(0, 4).toString('latin1') !== 'RIFF') return c.json({ text: '', reason: 'too-short' });
    const b64 = wav.toString('base64');                       // аудио живёт только в памяти, на диск и в логи не пишем
    for (const model of cfg.models) {
      try {
        const res = await orFetch(cfg.key, '/audio/transcriptions', { body: buildSttRequest(model, b64), signal: AbortSignal.timeout(10_000) });
        const j = (await res.json()) as { text: string; usage?: { seconds?: number; cost?: number } };
        const text = j.text.trim();
        if (text === '' || HALLUCINATIONS.some((r) => r.test(text))) return c.json({ text: '', reason: 'no-speech' });
        return c.json({ text, seconds: j.usage?.seconds ?? null, model });
      } catch (e) {
        if (e instanceof OpenRouterError && (e.kind === 'no-credits' || e.kind === 'auth')) return c.json({ error: e.kind }, 503);
      }
    }
    return c.json({ error: 'stt-unavailable' }, 502);
  });
  return app;
}
```

```ts
// apps/server/src/routes/coachAsk.ts — POST /api/coach/ask → text/event-stream
//   body: { question: string; context: { fen: string; summary: string; lastJudgement?: MoveJudgement; allowedAnnotations: { id: string; label: string }[] }; history?: { who:'child'|'coach'; text:string }[] }
//   SSE:  event: sentence  data: {"text":"…"}     (по мере готовности предложений — сразу в TTS)
//         event: final     data: CoachAnswer       (say, bubble, pose, intent, annotationId — annotationId проверен по списку)
import { streamSSE } from 'hono/streaming';

export function coachAskRoute(cfg: { key: string | null; model: string; fallbackModel: string; zdr: boolean; systemPrompt: string; schema: object }) {
  const app = new Hono();
  app.post('/', async (c) => {
    if (!cfg.key) return c.json({ error: 'no-api-key' }, 503);
    const body = AskBody.parse(await c.req.json());                     // zod; question ≤ 300 симв.
    const upstream = await orFetch(cfg.key, '/chat/completions', {
      signal: c.req.raw.signal,                                         // ребёнок перебил → abort → провайдер прекращает генерацию
      body: {
        model: cfg.model, models: [cfg.model, cfg.fallbackModel],
        stream: true, reasoning: { effort: 'none' }, max_completion_tokens: 200,
        messages: [
          { role: 'system', content: cfg.systemPrompt },               // статичный → кэш промпта
          ...(body.history ?? []).slice(-6).map((h) => ({ role: h.who === 'child' ? 'user' : 'assistant', content: h.text })),
          { role: 'user', content: renderFactsAndQuestion(body) },     // факты движка + разрешённые показы + вопрос
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'coach_answer', strict: true, schema: cfg.schema } },
        provider: { data_collection: 'deny', ...(cfg.zdr ? { zdr: true } : {}), require_parameters: true },
      },
    });

    return streamSSE(c, async (sse) => {
      let raw = ''; let spoken = 0; let buf = '';
      const reader = upstream.body!.getReader(); const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop()!;
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;                    // в т.ч. пропускаем ": OPENROUTER PROCESSING"
          const data = line.slice(6).trim(); if (data === '[DONE]') continue;
          const chunk = JSON.parse(data) as { error?: { message: string }; choices?: { delta?: { content?: string } }[] };
          if (chunk.error) throw new Error(chunk.error.message);       // ошибка посреди потока (HTTP уже 200)
          raw += chunk.choices?.[0]?.delta?.content ?? '';
          const say = extractPartialSay(raw);                          // текст поля "say" из НЕзавершённого JSON (с разэкранированием)
          for (const s of completeSentences(say.slice(spoken))) {      // режем по [.!?…] + пробел
            spoken += s.length; await sse.writeSSE({ event: 'sentence', data: JSON.stringify({ text: s.trim() }) });
          }
        }
      }
      const answer = CoachAnswer.parse(JSON.parse(raw));
      const tail = answer.say.slice(spoken).trim();
      if (tail) await sse.writeSSE({ event: 'sentence', data: JSON.stringify({ text: tail }) });
      if (answer.annotationId && !body.context.allowedAnnotations.some((a) => a.id === answer.annotationId)) answer.annotationId = null; // код доказывает
      await sse.writeSSE({ event: 'final', data: JSON.stringify(answer) });
    });
  });
  return app;
}
```
`/api/health` дополнить блоком `openrouter: { key: boolean; limitRemaining: number | null; usageDaily: number }` (из `GET /key`, кэш 60 с) — **поле в `HealthInfo` добавляет архитектор**.

---

## 9. Эскиз браузерного слоя (`VoiceLayer`)

```ts
// apps/web/src/coach/openRouterVoice.ts
import type { VoiceLayer } from '@gambit/shared';
import { createEmitter, createFrameLoop, computeRms, rmsToMouthTarget, smoothLevel, splitIntoSentences } from './voiceUtils.ts';

const WORKLET = `registerProcessor('pcm-tap', class extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; } });`;

export interface PttDeps {
  /** полный ход диалога после распознавания: спрашивает /api/coach/ask, отдаёт предложения по мере готовности */
  ask(question: string, onSentence: (text: string) => void, signal: AbortSignal): Promise<void>;
}

export function createOpenRouterPttVoice(deps: PttDeps): VoiceLayer {
  const level = createEmitter<number>(), speaking = createEmitter<boolean>(), transcript = createEmitter<['child' | 'coach', string]>();
  let play: AudioContext | null = null, analyser: AnalyserNode | null = null;
  let queueEnd = 0; let active = new Set<AudioBufferSourceNode>(); let abort = new AbortController(); let mouth = 0;
  let rec: { ctx: AudioContext; stream: MediaStream; chunks: Float32Array[] } | null = null;

  const loop = createFrameLoop(() => {
    if (!analyser) return;
    const buf = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(buf);
    mouth = smoothLevel(mouth, active.size ? rmsToMouthTarget(computeRms(buf)) : 0); level.emit(mouth);
  });

  async function fetchAudio(text: string, signal: AbortSignal): Promise<AudioBuffer> {
    const res = await fetch('/api/voice/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal });
    if (!res.ok) throw new Error(`tts ${res.status}`);
    return play!.decodeAudioData(await res.arrayBuffer());           // mp3 декодируют и Chrome, и Safari
  }
  function schedule(buffer: AudioBuffer): Promise<void> {
    return new Promise((resolve) => {
      const src = play!.createBufferSource(); src.buffer = buffer; src.connect(analyser!);
      const at = Math.max(play!.currentTime + 0.02, queueEnd); queueEnd = at + buffer.duration + 0.12;   // пауза между предложениями
      active.add(src); if (active.size === 1) { speaking.emit(true); loop.start(); }
      src.onended = () => { active.delete(src); if (!active.size) { speaking.emit(false); loop.stop(); level.emit(0); } resolve(); };
      src.start(at);
    });
  }
  async function speakSentences(sentences: string[], signal: AbortSignal): Promise<void> {
    const pending = sentences.map((s) => fetchAudio(s, signal));    // запросы параллельно, проигрывание строго по порядку
    for (const p of pending) { const b = await p; if (signal.aborted) return; await schedule(b); }
  }

  const layer: VoiceLayer = {
    kind: 'openai-realtime' as VoiceLayer['kind'],                  // TODO(architect): добавить 'openrouter-ptt' в contracts.ts
    async init() {                                                  // вызывать из жеста пользователя (см. gestureGate.ts)
      play = new AudioContext(); analyser = play.createAnalyser(); analyser.fftSize = 1024; analyser.connect(play.destination);
      await play.resume();
    },
    async speak(text, opts) {
      if (opts?.interrupt) layer.stop();
      transcript.emit(['coach', text]);
      try { await speakSentences(splitIntoSentences(text), abort.signal); }
      catch { /* контроллер поймает и переключит слой на browser-tts */ throw new Error('tts-failed'); }
    },
    stop() { abort.abort(); abort = new AbortController(); for (const s of active) { try { s.stop(); } catch { /* уже остановлен */ } } active.clear(); queueEnd = 0; speaking.emit(false); level.emit(0); },
    onLevel: (cb) => level.on(cb),
    onSpeakingChange: (cb) => speaking.on(cb),
    onTranscript: (cb) => transcript.on(([who, t]) => cb(who, t)),

    async startListening() {                                        // pointerdown на кнопке микрофона
      layer.stop();                                                 // ребёнок перебивает тренера
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const ctx = new AudioContext({ sampleRate: 16000 });          // браузер сам ресемплит микрофон; если ctx.sampleRate !== 16000 — ресемплить вручную
      await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })));
      const node = new AudioWorkletNode(ctx, 'pcm-tap'); const chunks: Float32Array[] = [];
      node.port.onmessage = (e: MessageEvent<Float32Array>) => { chunks.push(e.data); level.emit(rmsToMouthTarget(computeRms(e.data))); };
      ctx.createMediaStreamSource(stream).connect(node);            // к destination не подключаем — эха нет
      rec = { ctx, stream, chunks };
      setTimeout(() => { if (rec?.ctx === ctx) layer.stopListening?.(); }, 15_000);   // потолок 15 с
    },
    stopListening() {                                               // pointerup / pointercancel
      const r = rec; rec = null; if (!r) return;
      r.stream.getTracks().forEach((t) => t.stop()); void r.ctx.close();
      const pcm = trimSilence(concat(r.chunks), 0.01);
      if (pcm.length < 16000 * 0.4) return;                         // случайное касание — ничего не отправляем
      void (async () => {
        const res = await fetch('/api/voice/stt', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: encodeWav16(pcm, r.ctx.sampleRate) });
        const { text } = (await res.json()) as { text?: string };
        if (!text) { await layer.speak('Я не расслышал. Нажми кнопку и скажи ещё раз!'); return; }   // фраза из кэша
        transcript.emit(['child', text]);
        const queue: Promise<AudioBuffer>[] = []; let chain = Promise.resolve();
        await deps.ask(text, (sentence) => {                        // предложения приходят по SSE — синтез сразу, проигрывание по порядку
          transcript.emit(['coach', sentence]);
          const p = fetchAudio(sentence, abort.signal); queue.push(p);
          chain = chain.then(async () => { const b = await p; if (!abort.signal.aborted) await schedule(b); });
        }, abort.signal);
        await chain;
      })();
    },
    dispose() { layer.stop(); loop.stop(); void play?.close(); level.clear(); speaking.clear(); transcript.clear(); },
  };
  return layer;
}

function concat(chunks: Float32Array[]): Float32Array { const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0)); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; } return out; }
function trimSilence(x: Float32Array, thr: number): Float32Array { let a = 0, b = x.length; while (a < b && Math.abs(x[a]!) < thr) a++; while (b > a && Math.abs(x[b - 1]!) < thr) b--; const pad = 1600; return x.subarray(Math.max(0, a - pad), Math.min(x.length, b + pad)); }
function encodeWav16(x: Float32Array, rate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + x.length * 2); const v = new DataView(buf); const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + x.length * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) { const s = Math.max(-1, Math.min(1, x[i]!)); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return buf;
}
```
Замечания: (1) `AudioContext` создаётся/резюмится только из жеста (в модуле уже есть `gestureGate.ts`); (2) слой при любой ошибке TTS бросает исключение — `coachController` переключается на `createBrowserTtsVoice()`, текст ребёнок всё равно видит в пузыре; (3) филлеры и «не расслышал» предзагружаются в `AudioBuffer` при `init()`; (4) для lip-sync используется один `AnalyserNode` на выходе; во время записи тот же `onLevel` показывает громкость микрофона (поза `listen`).

---

## 10. Чек-лист «НЕ ПРОВЕРЕНО» (первые вызовы с ключом, общий бюджет < $0.20)

1. Принимает ли OpenRouter `voice: "ru-RU-Masha:MAI-Voice-2"` (и вариант `…-Flash`, и `ru-RU-Lev`) для `microsoft/mai-voice-2-flash`; работают ли стили `excited`/`encouraging`/`curious`. Если 400 — основной TTS = Grok `eve`.
2. Прослушивание 5 русских фраз × {MAI Masha, Grok eve, Grok ara, Gemini Leda, Gemini Puck, Fish (подобранный русский голос; есть бесплатный `fish-audio/s2.1-pro-free:free`)}: акцент, ударения («ферзя», «ладьёй», «е-четыре»), детскость. Решение принимает родитель на слух.
3. Реальная задержка TTS на **коротких** фразах (до первого байта и полная), особенно у Gemini (p50 5–6 с по общей статистике); стримит ли провайдер тело кусками; фактический `Content-Type`/частота для `pcm`.
4. STT на 20 реальных фразах ребёнка: `mai-transcribe-2` vs `gpt-transcribe` vs `whisper-large-v3`; работает ли `phraseList`; пробрасывается ли `provider.options.openai.prompt`; поведение на тишине.
5. TTFT `gpt-5.6-luna` с `reasoning.effort:"none"` через OpenAI и через Azure (`zdr:true`); не ломает ли `require_parameters:true` маршрут при `max_completion_tokens`.
6. Что именно остаётся доступным при `data_collection:"deny"` для моделей OpenAI (first-party OpenAI хранит промпты, но не обучается).
7. Фактическая цена аудио у `openai/gpt-audio-mini` (по `usage.cost`), формат аудио при стриме.
8. Политика OpenRouter по хранению аудио в `/audio/*` (в доках описаны только «prompts»); применяются ли аккаунтные ZDR-тогглы к STT/TTS.
9. `provider.options.xai.language:"ru"` для Grok TTS.

---

## 11. Главные риски

1. **Каталог аудио-моделей OpenRouter нестабилен**: OpenAI-TTS исчез за 4 месяца после анонса; Gemini TTS — preview. ⇒ модель/голос только в конфиге, фолбэк-цепочка, ключ кэша включает модель и голос, `/api/health` показывает предупреждение при 404.
2. **Русский голос для маскота не гарантирован ни одной моделью «из коробки» через OpenRouter**: у MAI русские голоса есть у Azure, но не в списке OpenRouter; у Grok/Gemini русский официально есть, но голоса мультиязычные. Без прослушивания выбирать нельзя.
3. **Задержка**: реалистично 2–3 с p50 и 5+ с p90 до первого слова; без филлера и локальных шаблонных ответов ребёнку будет скучно. Gemini TTS в живом режиме сейчас непригоден.
4. **Распознавание детской речи** не подтверждено бенчмарками; Whisper галлюцинирует на тишине; шахматные термины и «е четыре/эф три» требуют словаря и терпимого к ошибкам «мозга» (переспрашивать, а не выдумывать).
5. **Приватность**: `provider`-маршрутизация не действует на STT ⇒ приватность обеспечивается выбором однопровайдерной ZDR-модели и настройками аккаунта; first-party OpenAI-модели (gpt-transcribe, gpt-audio) — не ZDR.
6. **Контракт**: нужен новый `VoiceLayer.kind`, поля в `HealthInfo`, три маршрута (`/voice/tts`, `/voice/stt`, `/coach/ask`) — правка `contracts.ts`.
7. `GET /credits` недоступен обычному ключу ⇒ остаток показываем только через лимит ключа (`/key.limit_remaining`); без лимита на ключе остаток узнать нельзя.

---

## Источники (открытые страницы и эндпоинты)

Документация OpenRouter:
- https://openrouter.ai/docs/llms.txt
- https://openrouter.ai/docs/guides/overview/multimodal/tts.md
- https://openrouter.ai/docs/api/api-reference/tts/create-speech.md
- https://openrouter.ai/docs/guides/overview/multimodal/stt.md
- https://openrouter.ai/docs/api/api-reference/stt/create-transcription.md
- https://openrouter.ai/docs/guides/overview/multimodal/audio.md
- https://openrouter.ai/docs/guides/features/structured-outputs.md
- https://openrouter.ai/docs/guides/features/tool-calling.md
- https://openrouter.ai/docs/guides/routing/provider-selection.md
- https://openrouter.ai/docs/guides/routing/model-fallbacks.md
- https://openrouter.ai/docs/guides/features/service-tiers.md
- https://openrouter.ai/docs/guides/features/zdr.md
- https://openrouter.ai/docs/guides/privacy/data-collection.md
- https://openrouter.ai/docs/guides/privacy/provider-logging.md
- https://openrouter.ai/docs/guides/features/input-output-logging.md
- https://openrouter.ai/docs/guides/best-practices/reasoning-tokens.md
- https://openrouter.ai/docs/api_reference/limits.md
- https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits.md
- https://openrouter.ai/docs/api_reference/errors-and-debugging.md
- https://openrouter.ai/docs/api_reference/streaming.md
- https://openrouter.ai/docs/api_reference/authentication.md
- https://openrouter.ai/docs/app-attribution.md

Блог и каталог OpenRouter:
- https://openrouter.ai/blog/announcements/announcing-audio-apis/ (01.05.2026)
- https://openrouter.ai/blog/tutorials/text-to-speech/
- https://openrouter.ai/blog/tutorials/transcription-on-openrouter/
- https://openrouter.ai/collections/text-to-speech-models
- Публичные эндпоинты без ключа: `https://openrouter.ai/api/v1/models?output_modalities=speech`, `…=transcription`, `…=all`; `https://openrouter.ai/api/v1/models/<id>/endpoints`; `https://openrouter.ai/api/v1/endpoints/zdr`; `https://openrouter.ai/api/frontend/v1/all-providers`
- Страницы моделей и их `/llms.txt` (описания, цены, статистика задержек): google/gemini-3.1-flash-tts-preview, microsoft/mai-voice-2, microsoft/mai-voice-2-flash, x-ai/grok-voice-tts-1.0, fish-audio/s2.1-pro, fish-audio/s1, fish-audio/s2-pro, mistralai/voxtral-mini-tts-2603, minimax/speech-2.8-turbo, qwen/qwen-audio-3.0-tts-flash, deepgram/aura-2, hexgrad/kokoro-82m, openai/gpt-transcribe, openai/gpt-4o-transcribe, openai/gpt-4o-mini-transcribe, openai/whisper-large-v3, openai/whisper-large-v3-turbo, google/chirp-3, deepgram/nova-3, microsoft/mai-transcribe-2, mistralai/voxtral-mini-transcribe, qwen/qwen3-asr-flash-2026-02-10, x-ai/grok-stt-1.0, meta/muse-voice-transcribe-1.0, openai/gpt-5.6-luna, openai/gpt-5.6-terra, openai/gpt-5.6-sol, openai/gpt-5.4-mini, openai/gpt-5.4-nano, openai/gpt-4.1-mini, openai/gpt-chat-latest, openai/gpt-audio, openai/gpt-audio-mini
- https://openrouter.ai/openai/gpt-4o-mini-tts-2025-12-15 → 404 (модель снята)

Провайдеры:
- https://ai.google.dev/gemini-api/docs/speech-generation
- https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-tts-preview
- https://ai.google.dev/gemini-api/docs/pricing
- https://cloud.google.com/blog/products/ai-machine-learning/gemini-3-1-flash-tts-on-google-cloud
- https://learn.microsoft.com/en-us/azure/ai-services/speech-service/mai-voices
- https://learn.microsoft.com/en-us/azure/ai-services/speech-service/mai-transcribe?pivots=programming-language-rest
- https://microsoft.ai/news/mai-voice-2/
- https://ai.azure.com/catalog/models/MAI-Voice-2-Flash
- https://docs.x.ai/developers/model-capabilities/audio/text-to-speech
- https://docs.x.ai/developers/model-capabilities/audio/voice-agent
- https://developers.openai.com/api/docs/pricing
- https://developers.openai.com/api/docs/models/gpt-transcribe

Только выдача поиска (страницы не открывались — сведения вторичны): fish.audio/s2 и docs.fish.audio (языковые «тиры», теги), mistral.ai/news/voxtral-tts (9 языков без русского), habr.com/ru/companies/otus/news/1024252 и vc.ru/ai/2016922 (отзывы о русском у Gemini TTS), webkit.org/blog/11353/mediarecorder-api и community.openai.com (Safari fMP4 и Whisper), testmuai.com MediaRecorder support (Safari 18.4 webm/opus).
