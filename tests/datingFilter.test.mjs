import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: ['src/creator/datingFilter.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const { evaluateDatingMatch } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

const settings = {
  outreachMode: 'DATING', targetGender: 'FEMALE', minFollowers: 100, maxFollowers: 1000,
};
const info = { gender: 'FEMALE', followers: 500, followersKnown: true };

test('matches a confirmed gender inside the follower range', () => {
  assert.equal(evaluateDatingMatch(info, settings).matches, true);
  assert.equal(evaluateDatingMatch({ ...info, gender: 'UNKNOWN' }, settings, 'FEMALE').matches, false);
  assert.equal(evaluateDatingMatch({ ...info, gender: 'MALE' }, settings, 'FEMALE', true).matches, true);
});

test('skips an unknown or different gender when targeting one gender', () => {
  assert.equal(evaluateDatingMatch({ ...info, gender: 'UNKNOWN' }, settings).matches, false);
  assert.equal(evaluateDatingMatch({ ...info, gender: 'MALE' }, settings).matches, false);
});

test('accepts unknown gender only when gender is unrestricted', () => {
  assert.equal(evaluateDatingMatch({ ...info, gender: 'UNKNOWN' }, { ...settings, targetGender: 'ANY' }).matches, true);
});

test('skips missing or out-of-range follower counts', () => {
  assert.equal(evaluateDatingMatch({ ...info, followersKnown: false, followers: 0 }, settings).matches, false);
  assert.equal(evaluateDatingMatch({ ...info, followers: 99 }, settings).matches, false);
  assert.equal(evaluateDatingMatch({ ...info, followers: 1001 }, settings).matches, false);
});

test('business mode does not apply the dating filter', () => {
  assert.equal(evaluateDatingMatch({ ...info, gender: 'UNKNOWN', followersKnown: false }, { ...settings, outreachMode: 'BUSINESS' }).matches, true);
});
