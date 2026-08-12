// Дымовой прогон настоящей страницы настроек в эмуляции браузера:
// проверяем, что скрипт не падает, поля заполняются и сохранение
// действительно записывает то, что ввели.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const html = readFileSync('./dist/settings.html', 'utf8');
const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test/' });
const { window } = dom;

// Мока нативного моста нет — значит код обязан уйти в localStorage.
globalThis.window = window;
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
// SDK создаёт события глобальными конструкторами — отдаём ему классы окна.
globalThis.Event = window.Event;
globalThis.CustomEvent = window.CustomEvent;
globalThis.HTMLElement = window.HTMLElement;

const store = {};
window.localStorage.setItem('cfg', JSON.stringify({
  sttKey: 'dg-key', llmKey: 'sk-ant-old', city: 'Алматы',
}));

await import('../src/settings/settings.ts');
await new Promise((r) => setTimeout(r, 50));

const $ = (id) => window.document.getElementById(id);
assert.equal($('status').textContent, 'готово к работе');
assert.equal($('llmKey').value, 'sk-ant-old', 'сохранённый ключ должен подставиться');
assert.equal($('city').value, 'Алматы');
assert.equal($('wakeWord').value, 'сергей', 'слово-обращение по умолчанию');

// Вводим не тот ключ — предупреждение обязано появиться сразу.
$('llmKey').value = 'dg-key';
$('llmKey').dispatchEvent(new window.Event('input'));
assert.match($('status').textContent, /совпада/i,
  'одинаковые ключи должны ловиться сразу при вводе');

// Правим на корректный и сохраняем.
$('llmKey').value = 'sk-ant-new';
$('llmKey').dispatchEvent(new window.Event('input'));
$('city').value = 'Самарканд';
$('wakeEnabled').checked = true;
$('save').dispatchEvent(new window.Event('click'));
await new Promise((r) => setTimeout(r, 50));

const saved = JSON.parse(window.localStorage.getItem('cfg'));
assert.equal(saved.llmKey, 'sk-ant-new', 'новый ключ должен записаться');
assert.equal(saved.city, 'Самарканд');
assert.equal(saved.wakeEnabled, true);
assert.match($('saved').textContent, /Сохранено/);
console.log('✓ настройки: загрузка, проверка ключей, сохранение');
