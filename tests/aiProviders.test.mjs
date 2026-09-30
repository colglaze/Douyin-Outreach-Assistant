import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/ai/providerPresets.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
const { AI_PROVIDER_PRESETS, getAiPresetConfig, getAiProviderPresetId, getAiRequestOptions, isKnownTextOnlyModel } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

test('recognizes official DeepSeek and LongCat presets', () => {
  const deepseek = AI_PROVIDER_PRESETS.find((preset) => preset.id === 'deepseek');
  const longcat = AI_PROVIDER_PRESETS.find((preset) => preset.id === 'longcat');
  assert.equal(getAiProviderPresetId(deepseek.endpoint, deepseek.model), 'deepseek');
  assert.equal(getAiProviderPresetId(longcat.endpoint, longcat.model), 'longcat');
  assert.equal(getAiProviderPresetId('https://example.com/chat/completions', 'model'), 'custom');
  assert.deepEqual(getAiPresetConfig('deepseek'), {
    aiEndpoint: deepseek.endpoint, aiModel: deepseek.model, aiApiKey: '',
  });
});

test('skips image requests for the documented text-only LongCat model', () => {
  const longcat = AI_PROVIDER_PRESETS.find((preset) => preset.id === 'longcat');
  const deepseek = AI_PROVIDER_PRESETS.find((preset) => preset.id === 'deepseek');
  assert.equal(isKnownTextOnlyModel(longcat.endpoint, longcat.model), true);
  assert.equal(isKnownTextOnlyModel(deepseek.endpoint, deepseek.model), false);
  assert.equal(isKnownTextOnlyModel(longcat.endpoint, 'LongCat-2.5-Preview'), false);
  assert.deepEqual(getAiRequestOptions(deepseek.endpoint, deepseek.model), { thinking: { type: 'disabled' } });
  assert.deepEqual(getAiRequestOptions(longcat.endpoint, longcat.model), { thinking: { type: 'disabled' } });
  assert.deepEqual(getAiRequestOptions('https://example.com/chat/completions', 'model'), {});
});
