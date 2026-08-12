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
}

const DEFAULTS: Config = {
  provider: 'anthropic',
  llmKey: '',
  model: 'claude-haiku-4-5-20251001',
  baseUrl: 'https://api.anthropic.com',
  sttKey: '',
  hints: [],
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
