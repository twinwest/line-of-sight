import { readConfig } from '../shared/config.js';
import { composePrompt } from './prompt.js';
import type { Responder, ResponderRequest } from './types.js';

// BYOK fallback (ARCHITECTURE §6): direct Anthropic Messages API, streaming,
// no tools at all — grounding comes from the inline context in the prompt.
// Raw fetch (not the SDK) keeps this file the daemon's single outbound-network
// site, trivially auditable per SPEC §7.
const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-5';

export const apiResponder: Responder = {
  id: 'api',

  available(): Promise<boolean> {
    return Promise.resolve(!!readConfig().apiKey);
  },

  async answer(req: ResponderRequest, onChunk: (s: string) => void, signal: AbortSignal): Promise<string> {
    const { apiKey, responderModel, responderEffort } = readConfig();
    if (!apiKey) throw new Error('no API key configured');
    const res = await fetch(API_URL, {
      method: 'POST',
      signal,
      headers: {
        'x-api-key': apiKey,          // never logged
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: responderModel ?? DEFAULT_MODEL,
        max_tokens: 4096,
        stream: true,
        ...(responderEffort ? { output_config: { effort: responderEffort } } : {}),
        messages: [{ role: 'user', content: composePrompt(req, req.inlineContext()) }],
      }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    let answer = '';
    let buf = '';
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk as Uint8Array, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        try {
          const ev = JSON.parse(line.slice(5)) as
            { type?: string; delta?: { type?: string; text?: string } };
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            const text = ev.delta.text ?? '';
            if (text) { answer += text; onChunk(text); }
          }
        } catch { /* ignore non-JSON data lines */ }
      }
    }
    return answer;
  },
};
