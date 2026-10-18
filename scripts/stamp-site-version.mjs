#!/usr/bin/env node
/**
 * 把版本号写进官网的静态文件。
 *
 * 用法：
 *   node scripts/stamp-site-version.mjs 0.3.7     # 写入指定版本
 *   node scripts/stamp-site-version.mjs           # 版本取 package.json
 *   node scripts/stamp-site-version.mjs --check   # 只检查是否需要更新，不写文件
 *
 * 为什么需要它：
 *   官网是纯静态页面，版本号写在 HTML 里。以前靠访客浏览器去 api.github.com
 *   拉最新 release 来"自动更新"，但匿名 API 配额只有 60 次/小时/每个 IP，
 *   部分网络下还连不上，而且失败时是静默的 —— 结果页面长期显示写死的旧版本号。
 *   现在改成部署前由 CI（带 GITHUB_TOKEN，配额 5000/小时）调用本脚本写死进去，
 *   访客侧不再有任何第三方运行时依赖，断网、被墙、禁用 JS 都显示正确版本。
 *
 * 设计要点：
 *   - 幂等：同一版本跑多少次结果都一样。
 *   - 保编码：以 UTF-8 读写、不写 BOM、不动 CRLF/LF。
 *   - 不误伤：只匹配产物名的固定形状，因此「v0.3.5 新增 WebDAV」这类
 *     记录功能引入版本的历史徽章不会被改掉。
 *   - 失败要响：任一规则匹配数低于预期就报错退出（非 0），宁可让部署失败，
 *     也不要静默地把旧版本号发上线。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^\d+\.\d+\.\d+$/;

/** 中英两站的页面结构一致，规则共用。 */
const PAGES = ['website/index.html', 'website/en/index.html'];

/**
 * 每条规则：pattern 的整体匹配会被 render(version) 替换。
 * min 是当前页面里应有的最少出现次数；低于它就说明页面结构变了，
 * 脚本必须报错而不是默默少改几处。
 */
const RULES = [
  ...PAGES.flatMap((file) => [
    {
      file,
      label: 'JSON-LD softwareVersion',
      pattern: /"softwareVersion":\s*"\d+\.\d+\.\d+"/g,
      min: 1,
      render: (v) => `"softwareVersion": "${v}"`,
    },
    {
      file,
      label: '.js-ver 版本徽标',
      pattern: /<span class="js-ver">v\d+\.\d+\.\d+<\/span>/g,
      min: 2,
      render: (v) => `<span class="js-ver">v${v}</span>`,
    },
    {
      file,
      label: 'Windows 安装包名',
      pattern: /Inkase-x64-\d+\.\d+\.\d+-Setup\.exe/g,
      min: 3,
      render: (v) => `Inkase-x64-${v}-Setup.exe`,
    },
    {
      file,
      label: 'Windows 便携版名',
      pattern: /Inkase-x64-\d+\.\d+\.\d+\.zip/g,
      min: 2,
      render: (v) => `Inkase-x64-${v}.zip`,
    },
    {
      file,
      label: 'Linux AppImage 名',
      pattern: /Inkase-linux-\d+\.\d+\.\d+\.AppImage/g,
      min: 2,
      render: (v) => `Inkase-linux-${v}.AppImage`,
    },
    {
      file,
      label: 'Linux deb 名',
      pattern: /Inkase-linux-\d+\.\d+\.\d+\.deb/g,
      min: 2,
      render: (v) => `Inkase-linux-${v}.deb`,
    },
    {
      file,
      label: 'macOS dmg 名',
      pattern: /Inkase-\d+\.\d+\.\d+\.dmg/g,
      min: 1,
      render: (v) => `Inkase-${v}.dmg`,
    },
  ]),
  {
    file: 'website/assets/app.js',
    label: 'app.js VERSION 常量',
    pattern: /var VERSION = '\d+\.\d+\.\d+'/g,
    min: 1,
    render: (v) => `var VERSION = '${v}'`,
  },
];

function readPackageVersion() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  return String(pkg.version || '').trim();
}

function parseArgs(argv) {
  const check = argv.includes('--check');
  const positional = argv.filter((a) => !a.startsWith('--'));
  if (positional.length > 1) {
    throw new Error(`多余的参数：${positional.slice(1).join(' ')}`);
  }
  return { check, version: (positional[0] || '').trim() };
}

function main() {
  const { check, version: explicit } = parseArgs(process.argv.slice(2));
  const version = explicit || readPackageVersion();
  const source = explicit ? '命令行参数' : 'package.json';

  if (!SEMVER.test(version)) {
    console.error(`✗ 版本号格式不对：${JSON.stringify(version)}（期望 x.y.z）`);
    process.exit(1);
  }

  // 按文件分组，每个文件只读一次、只写一次
  const byFile = new Map();
  for (const rule of RULES) {
    if (!byFile.has(rule.file)) byFile.set(rule.file, []);
    byFile.get(rule.file).push(rule);
  }

  const problems = [];
  let touched = 0;

  console.log(`目标版本 v${version}（来源：${source}）${check ? ' · 仅检查' : ''}`);

  for (const [file, rules] of byFile) {
    const path = join(ROOT, file);
    const before = readFileSync(path, 'utf8');
    let after = before;

    for (const rule of rules) {
      let hits = 0;
      after = after.replace(rule.pattern, () => {
        hits += 1;
        return rule.render(version);
      });

      if (hits < rule.min) {
        problems.push(
          `${file} · ${rule.label}：只匹配到 ${hits} 处，预期至少 ${rule.min} 处。` +
            ' 页面结构可能变了，请更新 scripts/stamp-site-version.mjs 里的规则。',
        );
      }
      console.log(`  ${hits >= rule.min ? '✓' : '✗'} ${file} · ${rule.label} ×${hits}`);
    }

    if (problems.length) continue;

    if (after === before) {
      console.log(`  = ${file} 已是 v${version}，无需改动`);
    } else if (check) {
      touched += 1;
      console.log(`  ! ${file} 需要更新到 v${version}`);
    } else {
      writeFileSync(path, after, 'utf8');
      touched += 1;
      console.log(`  → ${file} 已写入 v${version}`);
    }
  }

  if (problems.length) {
    console.error('\n✗ 版本写入失败：');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  if (check && touched) {
    console.error(`\n✗ 有 ${touched} 个文件不是 v${version}，请运行：node scripts/stamp-site-version.mjs ${version}`);
    process.exit(1);
  }

  console.log(
    check
      ? `\n✓ 全部文件都已是 v${version}`
      : `\n✓ 完成，${touched} 个文件有改动`,
  );
}

main();
