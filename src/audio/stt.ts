/**
 * Распознавание речи через Soniox Realtime.
 *
 * PCM с очков приходит уже в нужном виде — 16 kHz mono 16-bit —
 * поэтому ресемплинг не нужен, но формат в конфиге стрима задаём явно.
 *
 * ⚠️ Точные имена полей конфига сверить с текущей докой Soniox:
 *    https://soniox.com/docs — API у них тоже меняется.
 */

const SONIOX_WS = 'wss://stt-rt.soniox.com/transcribe-websocket';

export interface SttOptions {
  apiKey: string;
  /** Слова, которые модель путает: имена, термины, названия. */
  hints?: string[];
  onPartial?: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (e: Error) => void;
  /** Тишина, после которой считаем фразу законченной. */
  silenceMs?: number;
}

export class SttSession {
  private ws?: WebSocket;
  private finalText = '';
  private partialText = '';
  private silenceTimer?: ReturnType<typeof setTimeout>;
  private closed = false;

  private opts: SttOptions;

  constructor(opts: SttOptions) { this.opts = opts; }

  async open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(SONIOX_WS);
      this.ws = ws;

      const failFast = setTimeout(() => {
        reject(new Error('STT: соединение не открылось за 5 с'));
        ws.close();
      }, 5000);

      ws.onopen = () => {
        clearTimeout(failFast);
        ws.send(JSON.stringify({
          api_key: this.opts.apiKey,
          model: 'stt-rt-preview',
          audio_format: 'pcm_s16le',
          sample_rate: 16000,
          num_channels: 1,
          language_hints: ['ru', 'en'],
          enable_endpoint_detection: true,
          context: this.opts.hints?.join(', '),
        }));
        resolve();
      };

      ws.onmessage = (ev) => this.handle(ev.data);
      ws.onerror = () => {
        clearTimeout(failFast);
        this.opts.onError(new Error('STT: ошибка соединения'));
      };
      ws.onclose = () => { if (!this.closed) this.flush(); };
    });
  }

  /** Дозапись куска PCM. Вызывается из onPcm моста. */
  push(chunk: Uint8Array) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(chunk);
  }

  private handle(raw: string) {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.error_code) {
      this.opts.onError(new Error(`STT: ${msg.error_message ?? msg.error_code}`));
      return;
    }

    let partial = '';
    for (const token of msg.tokens ?? []) {
      if (token.is_final) this.finalText += token.text;
      else partial += token.text;
    }
    this.partialText = partial;

    const combined = (this.finalText + partial).trim();
    if (combined) this.opts.onPartial?.(combined);

    // Endpointing: провайдер сам сигналит конец фразы...
    if (msg.finished || msg.is_endpoint) { this.flush(); return; }

    // ...но подстраховываемся своим таймером тишины.
    clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => this.flush(), this.opts.silenceMs ?? 1200);
  }

  private flush() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.silenceTimer);
    const text = (this.finalText + this.partialText).trim();
    this.close();
    if (text) this.opts.onFinal(text);
    else this.opts.onError(new Error('Ничего не расслышал'));
  }

  close() {
    clearTimeout(this.silenceTimer);
    this.closed = true;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) this.ws.close();
    this.ws = undefined;
  }
}
