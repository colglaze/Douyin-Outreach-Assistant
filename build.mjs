/**
 * 构建脚本：将 src/main.ts 打包为单文件 Tampermonkey 用户脚本。
 * esbuild 安装在隔离的 managed node workspace 中，通过绝对路径引入。
 */
import { build } from 'file:///C:/Users/tao.chen/.workbuddy/binaries/node/workspace/node_modules/esbuild/lib/main.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Tampermonkey 元信息头（文档 Phase 1：Tampermonkey 用户脚本）
const banner = `// ==UserScript==
// @name         抖音达人商务助手 (Douyin Outreach Assistant)
// @namespace    https://github.com/douyin-outreach
// @version      0.10.1
// @description  商务/交友模式 / 持续连刷 / 多模型 AI / 自由私信与模板 / 联系记录
// @author       douyin-outreach
// @match        https://www.douyin.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      api.openai.com
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==
`;

await build({
  entryPoints: [resolve(__dirname, 'src/main.ts')],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  outfile: resolve(__dirname, 'dist/douyin-outreach.user.js'),
  banner: { js: banner },
  minify: false,
  sourcemap: false,
  logLevel: 'info',
});

console.log('Build OK -> dist/douyin-outreach.user.js');
