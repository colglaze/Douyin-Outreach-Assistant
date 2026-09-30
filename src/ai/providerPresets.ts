/** Verified OpenAI-compatible Chat Completions endpoints. No API keys are bundled. */
export const AI_PROVIDER_PRESETS = [
  {
    id: 'openai', name: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini',
  },
  {
    id: 'deepseek', name: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-flash',
  },
  {
    id: 'longcat', name: 'LongCat（文字）',
    endpoint: 'https://api.longcat.chat/openai/v1/chat/completions', model: 'LongCat-2.0',
  },
] as const;

export type AiProviderPresetId = typeof AI_PROVIDER_PRESETS[number]['id'];

export function getAiPresetConfig(id: string): { aiEndpoint: string; aiModel: string; aiApiKey: '' } | null {
  const preset = AI_PROVIDER_PRESETS.find((item) => item.id === id);
  return preset ? { aiEndpoint: preset.endpoint, aiModel: preset.model, aiApiKey: '' } : null;
}

export function getAiProviderPresetId(endpoint: string, model: string): AiProviderPresetId | 'custom' {
  return AI_PROVIDER_PRESETS.find((preset) => preset.endpoint === endpoint.trim() && preset.model === model.trim())?.id || 'custom';
}

/** LongCat-2.0 Chat Completions accepts text only. Other custom models remain caller-controlled. */
export function isKnownTextOnlyModel(endpoint: string, model: string): boolean {
  return endpoint.trim() === 'https://api.longcat.chat/openai/v1/chat/completions' && model.trim() === 'LongCat-2.0';
}

/** Short rewriting/OCR requests need a direct final answer, not reasoning tokens. */
export function getAiRequestOptions(endpoint: string, model: string): { thinking?: { type: 'disabled' } } {
  const preset = getAiProviderPresetId(endpoint, model);
  return preset === 'deepseek' || preset === 'longcat' ? { thinking: { type: 'disabled' } } : {};
}
