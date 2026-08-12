import { getBridge } from '../sdk/bridge.ts';
import { loadConfig, saveConfig, type Config } from '../config.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const fields = {
  sttKey: $<HTMLInputElement>('sttKey'),
  hints: $<HTMLTextAreaElement>('hints'),
  provider: $<HTMLSelectElement>('provider'),
  llmKey: $<HTMLInputElement>('llmKey'),
  model: $<HTMLInputElement>('model'),
  baseUrl: $<HTMLInputElement>('baseUrl'),
  webSearch: $<HTMLInputElement>('webSearch'),
  city: $<HTMLInputElement>('city'),
};

const statusEl = $('status');
const savedEl = $('saved');

const PRESETS: Record<string, { model: string; baseUrl: string }> = {
  anthropic: { model: 'claude-haiku-4-5-20251001', baseUrl: 'https://api.anthropic.com' },
  openai:    { model: 'gpt-4o-mini',               baseUrl: 'https://api.openai.com' },
};

async function init() {
  const bridge = await getBridge();
  const cfg = await loadConfig(bridge);

  fields.sttKey.value = cfg.sttKey;
  fields.hints.value = cfg.hints.join(', ');
  fields.provider.value = cfg.provider;
  fields.llmKey.value = cfg.llmKey;
  fields.model.value = cfg.model;
  fields.baseUrl.value = cfg.baseUrl;
  fields.webSearch.checked = cfg.webSearch;
  fields.city.value = cfg.city;

  render(cfg);

  // Проверяем формат по ходу ввода: узнать, что вставлен не тот ключ,
  // лучше сразу, а не после похода к очкам и ошибки на их экране.
  const recheck = () => render({
    sttKey: fields.sttKey.value.trim(),
    llmKey: fields.llmKey.value.trim(),
    provider: fields.provider.value as Config['provider'],
  });
  fields.sttKey.addEventListener('input', recheck);
  fields.llmKey.addEventListener('input', recheck);
  fields.provider.addEventListener('change', recheck);

  // Смена провайдера подставляет разумные значения, но не затирает
  // то, что человек уже вписал вручную.
  fields.provider.addEventListener('change', () => {
    const p = PRESETS[fields.provider.value];
    if (!p) return;
    const wasDefault = Object.values(PRESETS).some((x) => x.model === fields.model.value);
    if (!fields.model.value || wasDefault) fields.model.value = p.model;
    const wasDefaultUrl = Object.values(PRESETS).some((x) => x.baseUrl === fields.baseUrl.value);
    if (!fields.baseUrl.value || wasDefaultUrl) fields.baseUrl.value = p.baseUrl;
  });

  $('save').addEventListener('click', async () => {
    const next: Partial<Config> = {
      sttKey: fields.sttKey.value.trim(),
      hints: fields.hints.value.split(',').map((s) => s.trim()).filter(Boolean),
      provider: fields.provider.value as Config['provider'],
      llmKey: fields.llmKey.value.trim(),
      model: fields.model.value.trim(),
      baseUrl: fields.baseUrl.value.trim().replace(/\/$/, ''),
      webSearch: fields.webSearch.checked,
      city: fields.city.value.trim(),
    };

    try {
      await saveConfig(bridge, next);

      // Перечитываем записанное: сообщать «Сохранено», не убедившись,
      // что запись прошла, — худший вид вранья в настройках. Человек
      // уходит уверенным, а работает старый ключ.
      const check = await loadConfig(bridge);
      if (check.llmKey !== next.llmKey || check.sttKey !== next.sttKey) {
        savedEl.style.color = 'var(--alert)';
        savedEl.textContent = 'Не удалось сохранить — попробуйте ещё раз.';
        return;
      }

      render(check);
      savedEl.style.color = '';
      savedEl.textContent = 'Сохранено.';
    } catch (e) {
      console.error(e);
      savedEl.style.color = 'var(--alert)';
      savedEl.textContent = 'Ошибка сохранения. Попробуйте ещё раз.';
      return;
    }
    setTimeout(() => { savedEl.textContent = ''; }, 4000);
  });
}

/**
 * Ключи двух разных сервисов легко перепутать местами: оба выглядят как
 * длинная строка. Формат у них разный, и это стоит проверить прямо в
 * форме — иначе ошибка всплывёт только на очках как «КЛЮЧ НЕ ПРИНЯТ»,
 * без намёка на то, какой именно ключ не тот.
 */
function keyWarning(cfg: Partial<Config>): string {
  const llm = (cfg.llmKey ?? '').trim();
  const stt = (cfg.sttKey ?? '').trim();

  if (llm && stt && llm === stt) {
    return 'Ключ модели и ключ Deepgram совпадают — вставлен один и тот же.';
  }
  if (llm && cfg.provider === 'anthropic' && !llm.startsWith('sk-ant-')) {
    return 'Ключ Anthropic должен начинаться с sk-ant- — похоже, вставлен не тот ключ.';
  }
  if (llm && cfg.provider === 'openai' && !llm.startsWith('sk-')) {
    return 'Ключ OpenAI должен начинаться с sk-.';
  }
  if (stt && stt.startsWith('sk-')) {
    return 'В поле Deepgram похоже вставлен ключ языковой модели.';
  }
  return '';
}

function render(cfg: Partial<Config>) {
  const ready = Boolean(cfg.sttKey && cfg.llmKey);
  const warn = keyWarning(cfg);

  statusEl.dataset.ok = String(ready && !warn);
  statusEl.textContent = warn ? warn
    : ready ? 'готово к работе'
    : !cfg.sttKey && !cfg.llmKey ? 'нужны оба ключа'
    : !cfg.sttKey ? 'нужен ключ Deepgram'
    : 'нужен ключ модели';
}

init().catch((e) => {
  console.error(e);
  statusEl.dataset.ok = 'false';
  statusEl.textContent = 'ошибка загрузки настроек';
});
