// Прогон серверного агента: подаём ровно то тело, что шлют очки,
// и проверяем форму ответа, авторизацию и поведение при сбое.
import assert from 'node:assert/strict';

const mod = await import(process.env.BUNDLE ? '../worker/agent.bundle.js' : '../worker/agent.ts');
const worker = mod.default;

const env = { AGENT_TOKEN: 'secret', ANTHROPIC_API_KEY: 'sk-ant-test', CITY: 'Алматы' };

const post = (body, token = 'secret') => new Request('https://agent.test/', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
});

// 1. Чужой токен внутрь не пускаем, но объясняем это человеку словами:
// код ошибки очки покажут как безликое «network error».
{
  const res = await worker.fetch(post({ messages: [] }, 'wrong'), env);
  const d = await res.json();
  assert.equal(res.status, 200, 'ответ должен доходить до экрана');
  assert.match(d.choices[0].message.content, /Токен не совпадает/);
}

// 1a. Незаполненные настройки тоже видны на экране, а не молчат.
{
  const res = await worker.fetch(post({ messages: [] }), { AGENT_TOKEN: 'secret' });
  const d = await res.json();
  assert.match(d.choices[0].message.content, /ANTHROPIC_API_KEY/);
}

// 2. Обычный вопрос — ответ в форме OpenAI.
{
  const prev = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ content: [
      { type: 'server_tool_use', name: 'web_search' },
      { type: 'text', text: 'Плов Центр — ул. Регистан 12 — 4.6' },
    ]}),
  });
  try {
    const res = await worker.fetch(post({
      model: 'x',
      messages: [{ role: 'user', content: 'лучшие рестораны с пловом в Самарканде' }],
    }), env);
    const d = await res.json();
    assert.equal(res.status, 200);
    assert.equal(d.object, 'chat.completion');
    assert.match(d.choices[0].message.content, /Плов Центр/);
    assert.ok(
      !d.choices[0].message.content.includes('server_tool_use'),
      'служебные блоки поиска человеку показывать нельзя',
    );
  } finally { globalThis.fetch = prev; }
}

// 3. Сбой модели не должен превращаться в пустой экран.
{
  const prev = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'oops' });
  try {
    const res = await worker.fetch(post({
      messages: [{ role: 'user', content: 'тест' }],
    }), env);
    const d = await res.json();
    assert.equal(res.status, 200, 'ошибку отдаём текстом, иначе очки покажут своё сообщение');
    assert.match(d.choices[0].message.content, /Не получилось/);
  } finally { globalThis.fetch = prev; }
}

// 4. История диалога доходит до модели — иначе уточнения теряют смысл.
{
  const prev = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (_u, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'ок' }] }) };
  };
  try {
    await worker.fetch(post({
      messages: [
        { role: 'user', content: 'столица Японии' },
        { role: 'assistant', content: 'Токио.' },
        { role: 'user', content: 'а население' },
      ],
    }), env);
    assert.equal(sent.messages.length, 3, 'вся история должна уходить в модель');
    assert.match(sent.system, /Сегодня/, 'дата подставляется и на сервере');
    assert.ok(
      sent.tools.some((t) => t.type === 'web_search_20250305'),
      'поиск обязан быть включён',
    );
  } finally { globalThis.fetch = prev; }
}

console.log('✓ серверный агент: авторизация, форма ответа, история, обработка сбоя');
