#!/usr/bin/env node
/**
 * 构建期混淆。
 *
 * 把 server/*.js 与 public/js/*.js 转成难以阅读的形式，只在构建镜像时执行
 * （见 Dockerfile），仓库里保存的始终是可读源码。
 *
 * 用法：
 *   node scripts/obfuscate.js              原地覆盖（Dockerfile 里用）
 *   node scripts/obfuscate.js --out .obf   输出到指定目录，方便本地比对
 *
 * 注意：public/vendor/ 下的四个库已经是压缩产物，不参与混淆——再处理一遍
 * 既浪费时间又可能破坏 pdf.js / epub.js 的运行时。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MODULE = process.env.OBFUSCATOR_MODULE || 'javascript-obfuscator';
const JavaScriptObfuscator = require(MODULE);

const outIndex = process.argv.indexOf('--out');
const OUT = outIndex > -1 ? path.resolve(process.argv[outIndex + 1]) : null;

const BASE = {
  compact: true,
  // 只改局部变量名；全局函数名保留，public/js 下几个脚本之间互相调用的符号才不会断
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  renameProperties: false,
  stringArray: true,
  stringArrayThreshold: 0.75,
  stringArrayEncoding: ['base64'],
  stringArrayRotate: true,
  stringArrayShuffle: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  selfDefending: false,
  debugProtection: false,
  disableConsoleOutput: false,
  simplify: true,
  splitStrings: false
};

const GROUPS = [
  { dir: 'server', target: 'node' },
  { dir: 'public/js', target: 'browser' }
];

function listJs(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs)
    .filter(name => name.endsWith('.js'))
    .map(name => path.join(dir, name));
}

let totalIn = 0;
let totalOut = 0;
let count = 0;

for (const group of GROUPS) {
  for (const rel of listJs(group.dir)) {
    const src = path.join(ROOT, rel);
    const code = fs.readFileSync(src, 'utf8');
    const result = JavaScriptObfuscator.obfuscate(code, Object.assign({}, BASE, { target: group.target }))
      .getObfuscatedCode();
    const dest = OUT ? path.join(OUT, rel) : src;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, result);
    totalIn += Buffer.byteLength(code);
    totalOut += Buffer.byteLength(result);
    count += 1;
  }
}

const kb = n => (n / 1024).toFixed(0) + ' KB';
console.log(`obfuscated ${count} files: ${kb(totalIn)} -> ${kb(totalOut)}` +
  (OUT ? ` (${path.relative(ROOT, OUT)}/)` : ' (in place)'));
