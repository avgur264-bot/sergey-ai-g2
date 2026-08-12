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
}

const DEFAULTS: Config = {
  provider: 'anthropic',
  llmKey: '',
  model: 'claude-haiku-4-5-20251001',
  baseUrl: 'https://api.anthropic.com',
  sttKey: '',
  hints: [],
  webSearch: true,
  city: '',
  wakeEnabled: false,
  wakeWord: 'сергей',
};

/**
 * KVS в SDK строковый — числа и массивы конвертируем руками.
 * Ключи живут на устройстве и переживают перезагрузку.
 */
export async function loadConfig(bridge: Bridge): Promise<Config> {
  const raw = await bridge.get('cfg');
  if (!raw) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveConfig(bridge: Bridge, cfg: Partial<Config>): Promise<void> {
  const current = await loadConfig(bridge);
  await bridge.set('cfg', JSON.stringify({ ...current, ...cfg }));
}
