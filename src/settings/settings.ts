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

  render(cfg);

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
    };

    await saveConfig(bridge, next);
    render(next as Config);

    savedEl.textContent = 'Сохранено. Перезапустите приложение на очках.';
    setTimeout(() => { savedEl.textContent = ''; }, 4000);
  });
}

function render(cfg: Partial<Config>) {
  const ready = Boolean(cfg.sttKey && cfg.llmKey);
  statusEl.dataset.ok = String(ready);
  statusEl.textContent = ready
    ? 'готово к работе'
    : !cfg.sttKey && !cfg.llmKey ? 'нужны оба ключа'
    : !cfg.sttKey ? 'нужен ключ Soniox'
    : 'нужен ключ модели';
}

init().catch((e) => {
  console.error(e);
  statusEl.dataset.ok = 'false';
  statusEl.textContent = 'ошибка загрузки настроек';
});
