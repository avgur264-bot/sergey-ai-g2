import type { Bridge } from './sdk/bridge.ts';

export interface Config {
  provider: 'anthropic' | 'openai';
  llmKey: string;
  model: string;
  /** Пусто = прямой вызов провайдера. Иначе — URL вашего прокси. */
  baseUrl: string;
  sttKey: string;
  /** Слова, которые STT путает: имена, термины, названия проектов. */
  hints: string[];
  /**
   * Поиск в интернете силами провайдера (~$0.01 за запрос).
   *
   * Включён по умолчанию намеренно. Без него ассистент не знает ни
   * рейтингов, ни отзывов, ни свежих цен — и вместо ответа выдаёт
   * оговорки «нет доступа». Экономия в один цент не стоит бесполезного
   * ответа; выключать имеет смысл, только если баланс на исходе.
   */
  webSearch: boolean;
  /** Город для локальных запросов: «рестораны рядом», «аптека поблизости». */
  city: string;
  /**
   * Активация голосом вместо тапа. Требует непрерывно включённого
   * микрофона и постоянного распознавания, поэтому по умолчанию
   * выключена: это заметно расходует батарею очков и стоит примерно
   * $0.46 в час распознавания.
   */
  wakeEnabled: boolean;
  /** Слово-обращение, после которого идёт вопрос. */
  wakeWord: string;
  /**
   * Ключ Tavily — глубокого поиска с извлечением текста страниц.
   * 1000 запросов в месяц бесплатно, карта не нужна. Без ключа
   * работает только встроенный поиск провайдера.
   */
  searchKey: string;
  /** Версия набора настроек — см. CONFIG_VERSION ниже. */
  version?: number;
}

const DEFAULTS: Config = {
  provider: 'anthropic',
  llmKey: '',
  model: 'claude-sonnet-5',
  baseUrl: 'https://api.anthropic.com',
  sttKey: '',
  hints: [],
  webSearch: true,
  city: '',
  wakeEnabled: false,
  wakeWord: 'сергей',
  searchKey: '',
  version: 3,
};

/**
 * KVS в SDK строковый — числа и массивы конвертируем руками.
 * Ключи живут на устройстве и переживают перезагрузку.
 */
/**
 * Версия набора настроек.
 *
 * Нужна из-за неочевидной ловушки: сохранённые значения перекрывают
 * значения по умолчанию НАВСЕГДА. Когда поиск был выключен по
 * умолчанию и человек сохранил настройки, в хранилище осел
 * webSearch: false. Позже умолчание сменилось на true — но у всех,
 * кто успел сохраниться, поиск так и остался выключенным, и ассистент
 * молча отвечал по памяти вместо интернета. Со стороны это выглядит
 * как «поисковик плохой», хотя поиска не было вовсе.
 *
 * Версия позволяет один раз переспросить такие решения при обновлении.
 */
const CONFIG_VERSION = 3;

/** Прежнее умолчание — по нему узнаём тех, кто модель не выбирал сам. */
const LEGACY_MODEL = 'claude-haiku-4-5-20251001';

export async function loadConfig(bridge: Bridge): Promise<Config> {
  const raw = await bridge.get('cfg');
  if (!raw) return { ...DEFAULTS };

  let saved: Partial<Config> & { version?: number };
  try {
    saved = JSON.parse(raw);
  } catch {
    return { ...DEFAULTS };
  }

  const cfg = { ...DEFAULTS, ...saved };

  const from = saved.version ?? 1;
  if (from < CONFIG_VERSION) {
    // Версия 2: включаем поиск тем, у кого он остался выключенным с
    // прежних умолчаний. Осознанно выключить его можно снова — версия
    // уже поднята, второй раз включать не станем.
    if (from < 2) cfg.webSearch = true;

    // Версия 3: переводим на более сильную модель. Она заметно лучше
    // разбирает результаты поиска и реже принимает старое за
    // актуальное. Трогаем только тех, кто не менял модель сам: чужой
    // осознанный выбор перезаписывать нельзя.
    if (from < 3 && saved.model === LEGACY_MODEL) cfg.model = DEFAULTS.model;

    cfg.version = CONFIG_VERSION;
    await bridge.set('cfg', JSON.stringify(cfg)).catch(() => {});
  }

  return cfg;
}

export async function saveConfig(bridge: Bridge, cfg: Partial<Config>): Promise<void> {
  const current = await loadConfig(bridge);
  await bridge.set('cfg', JSON.stringify({ ...current, ...cfg }));
}
