// Thin wrapper around OpenRouter's chat-completions endpoint.
//
// OpenRouter speaks the OpenAI wire format, so image input is an
// `image_url` content part — a data: URL works, no upload step needed.
// Node 18+ ships global fetch, so there is no HTTP dependency to add.

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Free, vision-capable models (verified against openrouter.ai/api/v1/models).
// Gemma 4 31B leads: strongest general multimodal reader of the free tier,
// 256K context. The rest are the fallback chain — free models are rate-limited
// per account, so a single slug will intermittently 429.
const DEFAULT_MODEL = 'google/gemma-4-31b-it:free';
const DEFAULT_FALLBACKS = [
  'google/gemma-4-26b-a4b-it:free',      // MoE sibling, faster, same family
  'nvidia/nemotron-nano-12b-v2-vl:free', // purpose-built for document intelligence
];

class OpenRouterError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'OpenRouterError';
    this.status = status;
  }
}

// Open-weight models are looser than paid ones about output shape: they wrap
// JSON in ```json fences, and reasoning-capable ones can leak a <think> block
// even with reasoning disabled. Strip both, then fall back to the outermost
// {...} span before giving up.
function parseJsonLoose(text) {
  const cleaned = String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end <= start) {
      throw new OpenRouterError('Model did not return JSON', 502);
    }
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

function modelChain() {
  const primary = process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
  const fallbacks = process.env.OPENROUTER_FALLBACK_MODELS
    ? process.env.OPENROUTER_FALLBACK_MODELS.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_FALLBACKS;
  // Dedupe so an overridden primary that also appears in the fallback list
  // isn't retried against itself.
  return [...new Set([primary, ...fallbacks])];
}

// One request against one model. Throws OpenRouterError on any failure.
async function attempt({ model, apiKey, dataUrl, system, prompt, maxTokens }) {
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      // Optional attribution headers OpenRouter shows on its dashboard.
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:5173',
      'X-Title': process.env.OPENROUTER_APP_NAME || 'Dawa-Find',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      // We want a transcription, not an essay — thinking tokens are wasted
      // here and reasoning traces pollute the JSON we have to parse.
      reasoning: { enabled: false },
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: dataUrl } },
            { type: 'text', text: prompt },
          ],
        },
      ],
    }),
  });

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    // OpenRouter puts the useful part in body.error.message — surface it so a
    // bad slug, an exhausted free-tier quota, or a 429 is obvious from the UI.
    const detail = body?.error?.message || `HTTP ${res.status}`;
    throw new OpenRouterError(detail, res.status === 401 ? 500 : res.status);
  }

  const msg = body?.choices?.[0]?.message || {};
  // Free models sometimes return empty content with the real answer parked in
  // `reasoning` (they ignore reasoning.enabled). Fall back to it before failing.
  const text = msg.content || msg.reasoning;
  if (!text) throw new OpenRouterError('Empty response', 502);

  const parsed = parseJsonLoose(text);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.medicines)) {
    // Wrong shape is as useless as no reply — let the next model try.
    if (parsed?.isPrescription !== false) throw new OpenRouterError('Malformed JSON shape', 502);
  }
  parsed._model = body.model || model;
  return parsed;
}

// Sends one image + one instruction and returns the parsed JSON reply.
//
// Free models are individually unreliable — they rate-limit, return empty
// content, or emit non-JSON. So we walk the chain ourselves and validate each
// reply, rather than relying on OpenRouter's routing, which only re-routes on
// provider-side errors and not on a 200 carrying junk.
async function visionJson({ dataUrl, system, prompt, maxTokens = 4000 }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new OpenRouterError('OPENROUTER_API_KEY is not set', 500);

  const models = modelChain();
  const failures = [];

  for (const model of models) {
    try {
      return await attempt({ model, apiKey, dataUrl, system, prompt, maxTokens });
    } catch (err) {
      if (!(err instanceof OpenRouterError)) throw err;
      if (err.status === 500) throw err; // config problem — retrying won't help
      failures.push(`${model}: ${err.message}`);
    }
  }

  const allRateLimited = failures.every((f) => /429|rate|quota|limit/i.test(f));
  throw new OpenRouterError(
    allRateLimited
      ? 'All free models are rate-limited right now. Wait a minute and try again.'
      : `Could not read the prescription — every model failed (${failures.join('; ')})`,
    allRateLimited ? 429 : 502
  );
}

module.exports = { visionJson, OpenRouterError, DEFAULT_MODEL, DEFAULT_FALLBACKS };
