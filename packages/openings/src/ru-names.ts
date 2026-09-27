/**
 * Hand-written Russian names for opening families and a few kid-famous variations.
 *
 * Keys are prefixes of the English names used by lichess-org/chess-openings
 * ("Family", "Family: Variation", "Family: Variation, Sub-variation"). `openingNameRu` picks the
 * LONGEST key that matches the name at a segment boundary (end of string, ':' or ','), so
 * "Italian Game: Evans Gambit, Anderssen Variation" → «Гамбит Эванса», while any other Italian
 * line falls back to the family name «Итальянская партия».
 *
 * Names follow common Russian chess literature usage; they are general vocabulary, not copied
 * from any licensed source.
 */
export const RU_FAMILY_NAMES: Readonly<Record<string, string>> = {
  // ── open games (1.e4 e5) ──
  "King's Pawn Game": 'Дебют королевской пешки',
  "King's Pawn Opening": 'Дебют королевской пешки',
  "King's Pawn Game: Wayward Queen Attack": 'Ранний выход ферзя',
  "King's Pawn Game: Damiano Defense": 'Защита Дамиано',
  "King's Pawn Game: Napoleon Attack": 'Атака Наполеона',
  "King's Knight Opening": 'Дебют королевского коня',
  'Italian Game': 'Итальянская партия',
  'Italian Game: Evans Gambit': 'Гамбит Эванса',
  'Italian Game: Giuoco Piano': 'Итальянская партия, джоко пиано',
  'Italian Game: Giuoco Pianissimo': 'Итальянская партия, тихий вариант',
  'Italian Game: Two Knights Defense': 'Защита двух коней',
  'Italian Game: Two Knights Defense, Fried Liver Attack': 'Атака «жареная печень»',
  'Italian Game: Hungarian Defense': 'Венгерская защита',
  'Ruy Lopez': 'Испанская партия',
  'Ruy Lopez: Berlin Defense': 'Испанская партия, берлинская защита',
  'Ruy Lopez: Exchange Variation': 'Испанская партия, разменный вариант',
  'Ruy Lopez: Marshall Attack': 'Испанская партия, атака Маршалла',
  'Scotch Game': 'Шотландская партия',
  'Scotch Game: Scotch Gambit': 'Шотландский гамбит',
  'Four Knights Game': 'Дебют четырёх коней',
  'Four Knights Game: Halloween Gambit': 'Гамбит «Хэллоуин»',
  'Three Knights Opening': 'Дебют трёх коней',
  "Petrov's Defense": 'Русская партия',
  "Petrov's Defense: Stafford Gambit": 'Гамбит Стаффорда',
  'Philidor Defense': 'Защита Филидора',
  'Ponziani Opening': 'Дебют Понциани',
  'Vienna Game': 'Венская партия',
  'Vienna Gambit': 'Венский гамбит',
  "Bishop's Opening": 'Дебют слона',
  'Center Game': 'Центральный дебют',
  'Center Game Accepted': 'Центральный дебют',
  'Danish Gambit': 'Датский гамбит',
  'Danish Gambit Accepted': 'Датский гамбит',
  'Danish Gambit Declined': 'Датский гамбит',
  "King's Gambit": 'Королевский гамбит',
  "King's Gambit Accepted": 'Принятый королевский гамбит',
  "King's Gambit Declined": 'Отказанный королевский гамбит',
  "King's Gambit Declined: Falkbeer Countergambit": 'Контргамбит Фалькбеера',
  'Latvian Gambit': 'Латышский гамбит',
  'Latvian Gambit Accepted': 'Латышский гамбит',
  'Elephant Gambit': 'Гамбит слона',
  'Portuguese Opening': 'Португальский дебют',

  // ── semi-open games (1.e4, other replies) ──
  'Sicilian Defense': 'Сицилианская защита',
  'Sicilian Defense: Najdorf Variation': 'Сицилианская защита, вариант Найдорфа',
  'Sicilian Defense: Dragon Variation': 'Сицилианская защита, вариант дракона',
  'Sicilian Defense: Alapin Variation': 'Сицилианская защита, вариант Алапина',
  'Sicilian Defense: Closed': 'Закрытая сицилианская защита',
  'Sicilian Defense: Smith-Morra Gambit': 'Гамбит Морра',
  'French Defense': 'Французская защита',
  'French Defense: Advance Variation': 'Французская защита, система с продвижением',
  'French Defense: Exchange Variation': 'Французская защита, разменный вариант',
  'Caro-Kann Defense': 'Защита Каро — Канн',
  'Caro-Kann Defense: Advance Variation': 'Защита Каро — Канн, система с продвижением',
  'Caro-Kann Defense: Exchange Variation': 'Защита Каро — Канн, разменный вариант',
  'Scandinavian Defense': 'Скандинавская защита',
  'Alekhine Defense': 'Защита Алехина',
  'Pirc Defense': 'Защита Пирца — Уфимцева',
  'Modern Defense': 'Современная защита',
  'Robatsch Defense': 'Защита Робача',
  'Nimzowitsch Defense': 'Дебют Нимцовича',
  'Owen Defense': 'Защита Оуэна',
  'St. George Defense': 'Защита святого Георгия',
  'Czech Defense': 'Чешская защита',
  'Lion Defense': 'Защита «Лев»',
  'Rat Defense': 'Защита «Крыса»',
  'Hippopotamus Defense': 'Защита «Бегемот»',
  'Borg Defense': 'Защита Борга',

  // ── closed games (1.d4 d5) ──
  "Queen's Pawn Game": 'Дебют ферзевой пешки',
  "Queen's Pawn": 'Дебют ферзевой пешки',
  "Queen's Pawn Game: London System": 'Лондонская система',
  "Queen's Pawn Game: Colle System": 'Система Колле',
  "Queen's Pawn Game: Torre Attack": 'Атака Торре',
  "Queen's Pawn Game: Accelerated London System": 'Лондонская система',
  "Queen's Gambit": 'Ферзевый гамбит',
  "Queen's Gambit Accepted": 'Принятый ферзевый гамбит',
  "Queen's Gambit Declined": 'Отказанный ферзевый гамбит',
  "Queen's Gambit Declined: Albin Countergambit": 'Контргамбит Альбина',
  "Queen's Gambit Declined: Exchange Variation": 'Отказанный ферзевый гамбит, разменный вариант',
  'Slav Defense': 'Славянская защита',
  'Semi-Slav Defense': 'Полуславянская защита',
  'Semi-Slav Defense Accepted': 'Полуславянская защита',
  'Tarrasch Defense': 'Защита Тарраша',
  'London System': 'Лондонская система',
  'Colle System': 'Система Колле',
  'Torre Attack': 'Атака Торре',
  'Trompowsky Attack': 'Атака Тромповского',
  'Richter-Veresov Attack': 'Дебют Вересова',
  'Rapport-Jobava System': 'Система Раппорта — Джобавы',
  'Blackmar-Diemer Gambit': 'Гамбит Блэкмара — Димера',
  'Blackmar-Diemer Gambit Accepted': 'Гамбит Блэкмара — Димера',
  'Blackmar-Diemer Gambit Declined': 'Гамбит Блэкмара — Димера',
  'Englund Gambit': 'Гамбит Энглунда',
  'Englund Gambit Declined': 'Гамбит Энглунда',

  // ── Indian defences (1.d4 Nf6) ──
  'Indian Defense': 'Индийская защита',
  "King's Indian Defense": 'Староиндийская защита',
  "Queen's Indian Defense": 'Новоиндийская защита',
  "Queen's Indian Accelerated": 'Новоиндийская защита',
  'Nimzo-Indian Defense': 'Защита Нимцовича',
  'Bogo-Indian Defense': 'Защита Боголюбова',
  'Old Indian Defense': 'Древнеиндийская защита',
  'Grünfeld Defense': 'Защита Грюнфельда',
  'Neo-Grünfeld Defense': 'Защита Грюнфельда',
  'Benoni Defense': 'Защита Бенони',
  'Benko Gambit': 'Волжский гамбит',
  'Benko Gambit Accepted': 'Волжский гамбит',
  'Benko Gambit Declined': 'Волжский гамбит',
  'Blumenfeld Countergambit': 'Контргамбит Блюменфельда',
  'Indian Defense: Budapest Gambit': 'Будапештский гамбит',
  'Indian Defense: Accelerated London System': 'Лондонская система',
  'Catalan Opening': 'Каталонское начало',
  'Dutch Defense': 'Голландская защита',
  'English Defense': 'Английская защита',
  'Mikenas Defense': 'Защита Микенаса',
  'Polish Defense': 'Польская защита',

  // ── flank openings ──
  'English Opening': 'Английское начало',
  'Réti Opening': 'Дебют Рети',
  'Zukertort Opening': 'Дебют Цукерторта',
  "King's Indian Attack": 'Староиндийское начало',
  'Bird Opening': 'Дебют Бёрда',
  'Nimzo-Larsen Attack': 'Дебют Ларсена',
  'Polish Opening': 'Дебют Сокольского',
  'Hungarian Opening': 'Дебют королевского фианкетто',
  'Grob Opening': 'Дебют Гроба',
  'Van Geet Opening': 'Дебют ферзевого коня',
  "Van't Kruijs Opening": 'Дебют ван Круйса',
  'Mieses Opening': 'Дебют Мизеса',
  'Saragossa Opening': 'Сарагосское начало',
  "Anderssen's Opening": 'Дебют Андерсена',
  'Amar Opening': 'Дебют Амара',
  'Barnes Opening': 'Дебют Барнса',
  "Barnes Opening: Fool's Mate": 'Дурацкий мат',
  'Ware Opening': 'Дебют Уэра',
  'Clemenz Opening': 'Дебют Клеменца',
  'Sodium Attack': 'Дебют Дуркина',
};

const SORTED_KEYS: readonly string[] = Object.keys(RU_FAMILY_NAMES).sort((a, b) => b.length - a.length);

function matchesAtBoundary(name: string, key: string): boolean {
  if (!name.startsWith(key)) return false;
  if (name.length === key.length) return true;
  const next = name[key.length];
  return next === ':' || next === ',';
}

/**
 * Russian name for an English lichess opening name, by longest-prefix match against
 * {@link RU_FAMILY_NAMES}. Returns `undefined` for rare openings that have no entry — the coach
 * then simply does not name the opening (or uses the English name in a parent-facing view).
 */
export function openingNameRu(name: string): string | undefined {
  for (const key of SORTED_KEYS) {
    if (matchesAtBoundary(name, key)) return RU_FAMILY_NAMES[key];
  }
  return undefined;
}
