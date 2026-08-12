import type { ToolSpec } from '../registry.ts';

// ─── Таймер: полностью локальный, без сети ───────────────────

export const timerTool: ToolSpec = {
  name: 'timer_set',
  description: 'Поставить таймер на заданное количество секунд.',
  kind: 'read',
  transport: 'local',
  label: 'ТАЙМЕР',
  schema: {
    type: 'object',
    properties: {
      seconds: { type: 'number', description: 'Длительность в секундах' },
      label: { type: 'string', description: 'Название таймера' },
    },
    required: ['seconds'],
  },
  async run(args) {
    const sec = Math.max(1, Math.min(86400, Number(args.seconds) || 0));
    const name = args.label ? String(args.label) : 'Таймер';
    setTimeout(() => window.dispatchEvent(
      new CustomEvent('sergey:timer', { detail: { name } }),
    ), sec * 1000);
    return { data: 'ok', direct: `${name}\n${fmt(sec)}` };
  },
};

function fmt(s: number) {
  if (s < 60) return `${s} сек`;
  if (s < 3600) return `${Math.round(s / 60)} мин`;
  return `${(s / 3600).toFixed(1)} ч`;
}

// ─── Память: явные факты в KVS ───────────────────────────────

const MEM_INDEX = 'mem:index';

export const memorySaveTool: ToolSpec = {
  name: 'memory_save',
  description:
    'Запомнить факт о пользователе. Вызывать ТОЛЬКО когда пользователь явно просит запомнить.',
  kind: 'write',
  transport: 'local',
  label: 'ПАМЯТЬ',
  schema: {
    type: 'object',
    properties: { fact: { type: 'string', description: 'Что запомнить, одной фразой' } },
    required: ['fact'],
  },
  confirm: (a) => `Запомнить:\n${a.fact}`,
  async run(args, ctx) {
    const fact = String(args.fact).slice(0, 200);
    const raw = await ctx.bridge.get(MEM_INDEX);
    const list: string[] = raw ? JSON.parse(raw) : [];
    list.push(fact);
    // Держим память маленькой — она целиком уходит в каждый промпт.
    await ctx.bridge.set(MEM_INDEX, JSON.stringify(list.slice(-100)));
    return { data: 'сохранено', direct: 'ЗАПОМНИЛ' };
  },
};

export const memoryForgetTool: ToolSpec = {
  name: 'memory_forget',
  description: 'Удалить факт из памяти по совпадению текста.',
  kind: 'write',
  transport: 'local',
  label: 'ПАМЯТЬ',
  schema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
  confirm: (a) => `Забыть:\n${a.query}`,
  async run(args, ctx) {
    const q = String(args.query).toLowerCase();
    const raw = await ctx.bridge.get(MEM_INDEX);
    const list: string[] = raw ? JSON.parse(raw) : [];
    const kept = list.filter((f) => !f.toLowerCase().includes(q));
    await ctx.bridge.set(MEM_INDEX, JSON.stringify(kept));
    return { data: `удалено ${list.length - kept.length}`, direct: 'ЗАБЫЛ' };
  },
};

export async function loadMemory(bridge: any): Promise<string[]> {
  const raw = await bridge.get(MEM_INDEX);
  return raw ? JSON.parse(raw) : [];
}

// ─── Погода: HTTP с CORS, без ключа ──────────────────────────

export const weatherTool: ToolSpec = {
  name: 'weather_now',
  description: 'Текущая погода по координатам пользователя.',
  kind: 'read',
  transport: 'direct',
  label: 'ПОГОДА',
  schema: {
    type: 'object',
    properties: {
      lat: { type: 'number' },
      lon: { type: 'number' },
    },
  },
  async run(args, ctx) {
    // ⚠️ Геолокация в WebView работает только на .ehpk-сборке.
    //    Через QR-сайдлоад вернётся PERMISSION_DENIED — это не баг.
    const { lat, lon } = args.lat && args.lon
      ? args
      : await getCoords();

    const url = `https://api.open-meteo.com/v1/forecast`
      + `?latitude=${lat}&longitude=${lon}`
      + `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m`;

    const res = await fetch(url, { signal: ctx.signal });
    if (!res.ok) throw new Error(`Погода: ${res.status}`);
    const d = await res.json();
    const c = d.current;

    return {
      data: JSON.stringify({
        temp: c.temperature_2m,
        feels: c.apparent_temperature,
        wind: c.wind_speed_10m,
        code: c.weather_code,
      }),
      direct: `${Math.round(c.temperature_2m)}°\nощущается ${Math.round(c.apparent_temperature)}°`,
    };
  },
};

function getCoords(): Promise<{ lat: number; lon: number }> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => reject(new Error('Нет геолокации')),
      { timeout: 8000, enableHighAccuracy: false },
    );
  });
}

export { searchTool, telegramTool, noteAddTool, noteListTool } from './direct.ts';
export { calendarListTool, calendarCreateTool } from './calendar.ts';

import { searchTool, telegramTool, noteAddTool, noteListTool } from './direct.ts';
import { calendarListTool, calendarCreateTool } from './calendar.ts';

/**
 * Каждый инструмент здесь — это входные токены в КАЖДОМ запросе.
 * Список держим коротким: десять штук ≈ 700 токенов, что при кэшировании
 * промпта стоит копейки, но при отключённом кэше уже заметно.
 */
export const defaultTools = [
  timerTool,
  memorySaveTool,
  memoryForgetTool,
  weatherTool,
  noteAddTool,
  noteListTool,
  searchTool,
  telegramTool,
  calendarListTool,
  calendarCreateTool,
];
