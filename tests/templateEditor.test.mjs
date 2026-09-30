import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/message/templateEngine.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
const { saveCustomTemplate, deleteCustomTemplate, getTemplateById, resolveBatchMessageSource, render } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const settingsCompiled = await build({ entryPoints: ['src/storage/settings.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
const { normalizeSettings } = await import(`data:text/javascript;base64,${Buffer.from(settingsCompiled.outputFiles[0].text).toString('base64')}`);

test('keeps legacy batch text as the selected source when loading old settings', () => {
  const oldCustom = normalizeSettings({ customMessage: '旧商务文案' });
  assert.equal(oldCustom.businessMessageMode, 'CUSTOM');
  assert.equal(resolveBatchMessageSource(oldCustom), '旧商务文案');
  const oldTemplate = normalizeSettings({ customMessage: '' });
  assert.equal(oldTemplate.businessMessageMode, 'TEMPLATE');
  assert.match(resolveBatchMessageSource(oldTemplate), /{{nickname}}/);
});

test('creates, edits and deletes a local template without modifying a built-in', () => {
  const created = saveCustomTemplate([], '朋友问候', '你好 {{nickname}}');
  assert.match(created.template.id, /^custom_/);
  assert.equal(getTemplateById(created.template.id, created.templates)?.content, '你好 {{nickname}}');
  const updated = saveCustomTemplate(created.templates, '新问候', '你好呀 {{nickname}}', created.template.id);
  assert.equal(updated.templates.length, 1);
  assert.equal(updated.templates[0].name, '新问候');
  assert.throws(() => saveCustomTemplate(updated.templates, '改内置', '内容', 'dating_001'));
  const patch = deleteCustomTemplate({ customTemplates: updated.templates, defaultTemplateId: created.template.id, datingTemplateId: created.template.id }, created.template.id);
  assert.deepEqual(patch.customTemplates, []);
  assert.equal(patch.defaultTemplateId, 'business_001');
  assert.equal(patch.datingTemplateId, 'dating_001');
});

test('uses the selected free text or template for each outreach mode', () => {
  const { templates, template } = saveCustomTemplate([], '问候', '模板 {{nickname}}');
  const settings = {
    outreachMode: 'DATING', datingMessageMode: 'CUSTOM', datingMessage: '自写 {{nickname}}',
    datingTemplateId: template.id, businessMessageMode: 'TEMPLATE',
    customMessage: '商务自由 {{nickname}}', defaultTemplateId: 'business_001', customTemplates: templates,
  };
  assert.equal(render(resolveBatchMessageSource(settings), { nickname: '小李' }), '自写 小李');
  settings.datingMessageMode = 'TEMPLATE';
  assert.equal(render(resolveBatchMessageSource(settings), { nickname: '小李' }), '模板 小李');
  settings.outreachMode = 'BUSINESS';
  settings.businessMessageMode = 'CUSTOM';
  assert.equal(render(resolveBatchMessageSource(settings), { nickname: '小李' }), '商务自由 小李');
  settings.businessMessageMode = 'TEMPLATE';
  settings.defaultTemplateId = template.id;
  assert.equal(render(resolveBatchMessageSource(settings), { nickname: '小李' }), '模板 小李');
  settings.defaultTemplateId = 'missing';
  assert.equal(resolveBatchMessageSource(settings), '');
  assert.equal(render('手写 {{nickname}} {{not_a_variable}}', { nickname: '小李' }), '手写 小李 {{not_a_variable}}');
});
