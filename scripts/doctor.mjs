import { readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 自检：入口为什么没出现
 *
 * 这个脚本只回答一个问题：**问题在插件包这边，还是在宿主/安装那边**。
 * 它不连接 DSH，也不需要宿主在跑；查完再按输出的提示去宿主机上验。
 */

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const notes = [];

const ok = (label, detail) => console.log(`  ✓ ${label}${detail ? `　${detail}` : ''}`);
const bad = (label, detail) => {
  console.log(`  ✗ ${label}${detail ? `　${detail}` : ''}`);
  problems.push(`${label}${detail ? `：${detail}` : ''}`);
};

console.log('\n先手协议控制台 · 入口自检\n');

// 1. 包声明
console.log('[1/5] 包声明');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const clientExport = pkg.exports && pkg.exports['./client'];
if (clientExport) ok('exports["./client"]', clientExport);
else bad('缺少 exports["./client"]', '宿主找不到浏览器半边');

const clientPlatform = pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform;
if (clientPlatform === 'web') ok('dsh.client.platform', 'web');
else bad('dsh.client.platform 不是 "web"', `当前 ${JSON.stringify(clientPlatform)}`);

if (Array.isArray(pkg.files) && pkg.files.includes('client')) ok('files 包含 client/');
else bad('files 未包含 client/', '打包后会漏掉浏览器半边');

if (pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch) ok('dsh.bundle.patch', pkg.dsh.bundle.patch);
else bad('缺少 dsh.bundle.patch', 'dsh plugin add 时不知道要插入哪一行');

// 2. 客户端文件
console.log('\n[2/5] 客户端文件');
const clientPath = join(root, String(clientExport || './client/client.js').replace(/^\.\//, ''));
if (existsSync(clientPath)) {
  ok('文件存在', `${clientPath.replace(root, '.')}（${(statSync(clientPath).size / 1024).toFixed(1)} KB）`);
} else {
  bad('客户端文件不存在', clientPath);
}
if (clientPath.endsWith('client.js')) ok('文件名是 client.js', '宿主按这个固定名提供 /plugins/<id>/client.js');
else bad('文件名不是 client.js', '多数宿主按固定名取文件，改名的风险是 404');

const nestedPkg = join(dirname(clientPath), 'package.json');
if (existsSync(nestedPkg)) {
  const type = JSON.parse(readFileSync(nestedPkg, 'utf8')).type;
  if (type === 'commonjs') ok('client/package.json 声明 CommonJS', '根包是 ESM，客户端半边必须是 CJS');
  else bad('client/package.json 的 type 不是 commonjs', `当前 ${type}`);
} else {
  bad('缺少 client/package.json', '根包 type=module 时，.js 会被当成 ESM，require 会失败');
}

// 3. 能否作为 CJS 加载
console.log('\n[3/5] 模块形态');
let client = null;
try {
  client = require(clientPath);
  ok('可 require', `导出 ${Object.keys(client).join(', ')}`);
} catch (error) {
  bad('require 失败', String(error.message));
}
if (client) {
  if (typeof client.apply === 'function') ok('导出 apply(ctx)');
  else bad('缺少 apply 导出');
  if (Array.isArray(client.inject) && client.inject.includes('slots')) {
    ok('声明 inject = [slots]', '实测：不声明时宿主不会为该上下文准备 slots，注册会全部落空');
  } else {
    bad(
      'inject 未包含 slots',
      `inject = ${JSON.stringify(client.inject)}；不声明 slots 时 ctx.slots 与 ctx.get('slots') 都拿不到，`
      + '表现为"装了插件但界面没有入口"（详见 docs/UI-INTEGRATION.md §12）',
    );
  }
}

// 4. 槽位注册试跑
console.log('\n[4/5] 槽位注册试跑（模拟宿主 ctx）');
if (client && typeof client.apply === 'function') {
  const registrations = [];
  const ctx = {
    slots: {
      inject(_slot, factory) {
        factory();
        return () => {};
      },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };
  try {
    client.apply(ctx);
    for (const item of registrations) {
      const { name, id, key, order, label } = item.options;
      const text = label ? (typeof label === 'function' ? label() : label) : '';
      ok(`注册 ${name}`, [id && `id=${id}`, key && `key=${key}`, order !== undefined && `order=${order}`, text]
        .filter(Boolean)
        .join(' '));
    }
    const entry = registrations.find((r) => r.options.name === 'sidebar.panellist');
    const panel = registrations.find((r) => r.options.name === 'main');
    if (entry && panel && entry.options.id === panel.options.key) ok('入口 id 与面板 key 一致');
    else bad('入口 id 与面板 key 不一致', '点击入口将找不到面板，表现为"点了没反应"');
    if (registrations.length === 0) bad('没有注册任何槽位', '可能是权限配置为 hidden');
  } catch (error) {
    bad('apply 抛错', String(error.message));
  }
}

// 5. 宿主侧提示
console.log('\n[5/5] 宿主侧还要确认（本脚本无法代劳）');
console.log('  · 装完必须重启 `dsh web`：客户端包名单在启动时编译，刷新浏览器不会加载新插件');
console.log('  · 只装 web profile：headless / sdk profile 没有客户端半边');
console.log('  · 宿主版本 ≥ 0.2.1-rc.1：更早的版本没有 slots / sidebar.panellist 槽位');

console.log('');
if (problems.length === 0) {
  console.log('结论：插件包本身没问题。入口若仍不出现，请在宿主机上按 docs/UI-INTEGRATION.md §11 的顺序排查。');
  console.log('\n宿主机上三条命令：');
  console.log('  dsh plugin --profile web list | grep xianshou');
  console.log('  dsh --profile web --dump-config | grep -i xianshou');
  console.log('  curl -s -o /dev/null -w "%{http_code}\\n" http://127.0.0.1:3080/plugins/xianshou/client.js');
  process.exit(0);
} else {
  console.log(`结论：插件包有 ${problems.length} 处问题，先修这些：`);
  problems.forEach((p, index) => console.log(`  ${index + 1}. ${p}`));
  process.exit(1);
}
