import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: ['src/douyin/messageAdapter.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const { MessageAdapter } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

test('fill verification follows a replaced visible Slate editor', async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalTextarea = globalThis.HTMLTextAreaElement;
  const originalInput = globalThis.HTMLInputElement;
  let activeElement = null;
  const dialog = { isConnected: true, contains: (el) => el === oldInput || el === newInput };
  const oldInput = {
    isConnected: true,
    textContent: '',
    focus() { activeElement = this; },
  };
  const newInput = {
    isConnected: true,
    textContent: '你好​，想认识你',
    focus() { activeElement = this; },
  };
  let currentInput = oldInput;
  globalThis.HTMLTextAreaElement = class {};
  globalThis.HTMLInputElement = class {};
  globalThis.window = { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) };
  globalThis.document = {
    get activeElement() { return activeElement; },
    createRange: () => ({ selectNodeContents() {} }),
    execCommand(command) {
      assert.equal(command, 'insertText');
      oldInput.isConnected = false;
      currentInput = newInput;
      return true;
    },
  };
  const adapter = {
    isVisible: (el) => el.isConnected,
    getMessageSurface: () => ({ dialog, input: currentInput, sendButton: null }),
  };
  try {
    const messages = new MessageAdapter(adapter);
    assert.equal(await messages.fillMessage('你好，想认识你'), true);
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.HTMLTextAreaElement = originalTextarea;
    globalThis.HTMLInputElement = originalInput;
  }
});

test('multiline fallback writes into the replacement editor after paste redraw', async () => {
  const saved = Object.fromEntries(['document', 'window', 'HTMLTextAreaElement', 'HTMLInputElement', 'DataTransfer', 'ClipboardEvent']
    .map((key) => [key, globalThis[key]]));
  let activeElement = null;
  const dialog = { isConnected: true, contains: (el) => el === first || el === replacement };
  const first = {
    isConnected: true,
    textContent: '',
    focus() { activeElement = this; },
    dispatchEvent() { this.isConnected = false; current = replacement; },
  };
  const replacement = {
    isConnected: true,
    textContent: '',
    focus() { activeElement = this; },
  };
  let current = first;
  globalThis.HTMLTextAreaElement = class {};
  globalThis.HTMLInputElement = class {};
  globalThis.DataTransfer = class { setData() {} };
  globalThis.ClipboardEvent = class { constructor() {} };
  globalThis.window = { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) };
  globalThis.document = {
    get activeElement() { return activeElement; },
    createRange: () => ({ selectNodeContents() {} }),
    execCommand(command, _showUi, value) {
      assert.equal(current, replacement);
      if (command === 'insertText') replacement.textContent += value;
      else assert.equal(command, 'insertLineBreak');
      return true;
    },
  };
  const adapter = {
    isVisible: (el) => el.isConnected,
    getMessageSurface: () => ({ dialog, input: current, sendButton: null }),
  };
  try {
    const messages = new MessageAdapter(adapter);
    assert.equal(await messages.fillMessage('你好\n明天见'), true);
    assert.equal(replacement.textContent, '你好明天见');
  } finally {
    for (const [key, value] of Object.entries(saved)) globalThis[key] = value;
  }
});
