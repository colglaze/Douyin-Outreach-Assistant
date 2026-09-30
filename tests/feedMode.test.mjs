import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

async function bundled(entryPoint) {
  const compiled = await build({ entryPoints: [entryPoint], bundle: true, format: 'esm', platform: 'node', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
}

const { effectiveSendLimit, reachedSendLimit, reachedDatingProfileLimit, shouldContinueSearching } = await bundled('src/feed/feedMode.ts');
const { FeedAutomation } = await bundled('src/feed/feedAutomation.ts');

test('continuous mode passes the old send and dating visit cutoffs', () => {
  assert.equal(effectiveSendLimit('LIMITED', 10), 10);
  assert.equal(effectiveSendLimit('CONTINUOUS', 10), null);
  assert.equal(reachedSendLimit('LIMITED', 10, 10), true);
  assert.equal(reachedSendLimit('CONTINUOUS', 1000, 10), false);
  assert.equal(reachedDatingProfileLimit('LIMITED', 50, 50), true);
  assert.equal(reachedDatingProfileLimit('CONTINUOUS', 500, 50), false);
  assert.equal(shouldContinueSearching('LIMITED', 8, 8), false);
  assert.equal(shouldContinueSearching('CONTINUOUS', 800, 8), true);
});

test('continuous session restores its mode and cumulative visits with bounded URL history', () => {
  const rows = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => rows.get(key) ?? null,
    setItem: (key, value) => rows.set(key, value),
    removeItem: (key) => rows.delete(key),
  };
  const deps = { onChange: () => {} };
  const run = new FeedAutomation(deps);
  run.state = 'RUNNING';
  run.mode = 'CONTINUOUS';
  for (let i = 0; i < 1200; i++) run.rememberVisit(`https://www.douyin.com/user/${i}`);
  run.saveSession();
  assert.equal(run.visited.size, 1000);
  const restored = new FeedAutomation(deps);
  assert.equal(restored.snapshot().mode, 'CONTINUOUS');
  assert.equal(restored.snapshot().limit, null);
  assert.equal(restored.snapshot().visited, 1200);
});

test('manual stop during dialog opening prevents filling or sending', async () => {
  const rows = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => rows.get(key) ?? null,
    setItem: (key, value) => rows.set(key, value),
    removeItem: (key) => rows.delete(key),
  };
  let resolveOpen;
  let filled = 0;
  let sent = 0;
  let closed = 0;
  const deps = {
    onChange: () => {},
    messageAdapter: {
      openMessageDialog: () => new Promise((resolve) => { resolveOpen = resolve; }),
      fillMessage: () => { filled++; return true; },
      sendMessage: () => { sent++; return true; },
      closeMessageDialog: () => { closed++; },
    },
  };
  const run = new FeedAutomation(deps);
  run.state = 'RUNNING';
  run.mode = 'CONTINUOUS';
  const pending = run.outreachOnce({}, { nickname: '达人' }, null);
  run.stop();
  resolveOpen(true);
  assert.equal(await pending, false);
  assert.equal(filled, 0);
  assert.equal(sent, 0);
  assert.equal(closed, 1);
});
