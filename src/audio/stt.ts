/**
 * Распознавание речи через Deepgram Nova-3 (русский).
 *
 * Браузерный WebSocket не умеет ставить произвольные заголовки —
 * Authorization передать нельзя. Deepgram для этого случая официально
 * поддерживает передачу ключа через Sec-WebSocket-Protocol: второй
 * аргумент конструктора WebSocket, массив ['token', apiKey].
 * https://developers.deepgram.com/docs/using-the-sec-websocket-protocol
 */

const DEEPGRAM_WS = 'wss://api.deepgram.com/v1/listen';

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
      const url = new URL(DEEPGRAM_WS);
      url.searchParams.set('encoding', 'linear16');
      url.searchParams.set('sample_rate', '16000');
      url.searchParams.set('channels', '1');
      url.searchParams.set('language', 'ru');
      url.searchParams.set('model', 'nova-3');
      url.searchParams.set('punctuate', 'true');
      url.searchParams.set('smart_format', 'true');
      url.searchParams.set('interim_results', 'true');
      // Свой таймер тишины ниже подстраховывает, но пусть Deepgram
      // тоже сигналит конец фразы через VAD.
      url.searchParams.set('vad_events', 'true');
      url.searchParams.set('utterance_end_ms', String(this.opts.silenceMs ?? 1200));
      // Подсказки распознавания: имена, термины.
      for (const kw of this.opts.hints ?? []) url.searchParams.append('keyterm', kw);

      const ws = new WebSocket(url.toString(), ['token', this.opts.apiKey]);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      const failFast = setTimeout(() => {
        reject(new Error('STT: соединение не открылось за 5 с'));
        ws.close();
      }, 5000);

      ws.onopen = () => { clearTimeout(failFast); resolve(); };

      ws.onmessage = (ev) => this.handle(ev.data);
      ws.onerror = () => {
        clearTimeout(failFast);
        const err = new Error('STT: ошибка соединения (проверьте ключ Deepgram)');
        this.opts.onError(err);
        reject(err);
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

    if (msg.type === 'Error' || msg.error) {
      this.opts.onError(new Error(`STT: ${msg.description ?? msg.message ?? 'ошибка Deepgram'}`));
      return;
    }

    if (msg.type === 'UtteranceEnd') { this.flush(); return; }

    if (msg.type === 'Results') {
      const alt = msg.channel?.alternatives?.[0];
      const text = alt?.transcript ?? '';
      if (!text) return;

      if (msg.is_final) {
        this.finalText += (this.finalText ? ' ' : '') + text;
        this.partialText = '';
      } else {
        this.partialText = text;
      }

      const combined = (this.finalText + ' ' + this.partialText).trim();
      if (combined) this.opts.onPartial?.(combined);

      if (msg.speech_final) { this.flush(); return; }

      // Подстраховка своим таймером — на случай сбоя VAD у провайдера.
      clearTimeout(this.silenceTimer);
      this.silenceTimer = setTimeout(() => this.flush(), (this.opts.silenceMs ?? 1200) + 500);
    }
  }

  /**
   * Штатное завершение по команде пользователя: отдаёт всё, что успели
   * распознать, через onFinal.
   *
   * Раньше для этого звали close(), и это молча теряло весь текст:
   * close() ставит closed = true, а flush() начинается с проверки
   * `if (this.closed) return`. В итоге onFinal не вызывался никогда,
   * автомат оставался в LISTENING до 20-секундного таймаута и уходил
   * в ошибку — при том что человек всё сказал правильно.
   */
  finish() {
    this.flush();
  }

  private flush() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.silenceTimer);
    const text = (this.finalText + ' ' + this.partialText).trim();
    this.closeSocket();
    if (text) this.opts.onFinal(text);
    else this.opts.onError(new Error('Ничего не расслышал'));
  }

  /** Рвёт соединение, не трогая накопленный текст. */
  private closeSocket() {
    clearTimeout(this.silenceTimer);
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) this.ws.close();
    this.ws = undefined;
  }

  /** Аварийный обрыв: закрываем сокет и НЕ отдаём текст. */
  close() {
    this.closed = true;
    this.closeSocket();
  }
}
