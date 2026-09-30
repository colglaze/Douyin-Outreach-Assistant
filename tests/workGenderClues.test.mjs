import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/creator/workGenderClues.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
const { inferWorkGender } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

const work = (caption) => [{ url: 'https://www.douyin.com/video/1', caption, coverUrl: '' }];

test('uses explicit first-person self-description in a work caption', () => {
  const result = inferWorkGender(work('今天分享日常，我是女生，喜欢旅行。'), '');
  assert.equal(result.gender, 'FEMALE');
  assert.equal(result.evidence[0].source, 'CAPTION');
});

test('can use a user-supplied spoken transcript', () => {
  const result = inferWorkGender(work('周末分享'), '大家好，我是一名男生。');
  assert.equal(result.gender, 'MALE');
  assert.equal(result.transcriptUsed, true);
});

test('does not classify third-person mentions or visual appearance', () => {
  assert.equal(inferWorkGender(work('一个女生在跳舞，镜头里的男生是我朋友'), '').gender, 'UNKNOWN');
});

test('conflicting self-descriptions remain unknown', () => {
  const result = inferWorkGender(work('我是男生'), '我是女生');
  assert.equal(result.gender, 'UNKNOWN');
  assert.match(result.warning, /矛盾/);
});

test('uses explicit words read from a cover only as a suggestion', () => {
  const result = inferWorkGender(work('今日分享'), '', [{ workIndex: 0, text: '我是女生' }], 1);
  assert.equal(result.gender, 'FEMALE');
  assert.equal(result.evidence[0].source, 'COVER');
  assert.equal(result.coversChecked, 1);
});
