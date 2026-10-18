// 一次性脚本：把候选头像渲染成一张对比图，用完即可删。
// 直接从 @tabler/icons-vue 里读图标路径，保证和组件里渲染出来的完全一致。
import { readFileSync, writeFileSync } from 'node:fs'

const DIR = 'node_modules/@tabler/icons-vue/dist/esm/icons'
const CANDIDATES = [
  ['IconRobot', 'robot', '机器人'],
  ['IconRobotFace', 'robot-face', '机器人脸'],
  ['IconMessageChatbot', 'message-chatbot', '对话机器人'],
  ['IconMessageChatbotFilled', 'message-chatbot-filled', '对话机器人（实心）'],
  ['IconSparkle', 'sparkle', '单星芒'],
  ['IconSparkles', 'sparkles', '三星芒（当前）'],
  ['IconSparklesFilled', 'sparkles-filled', '三星芒（实心）'],
  ['IconSparkles2', 'sparkles-2', '星芒 2'],
  ['IconSparkles2Filled', 'sparkles-2-filled', '星芒 2（实心）'],
  ['IconWand', 'wand', '魔杖']
]

// 应用自己的品牌记号（src/assets/logo.svg 里的墨滴），不是 Tabler 图标，单独写死
const CUSTOM = [
  ['inkase-drop', 'Inkase 墨滴（品牌）',
    '<svg viewBox="0 0 256 256" fill="currentColor"><path d="M128 58 C 128 58, 82 116, 82 150 a 46 46 0 0 0 92 0 C 174 116, 128 58, 128 58 Z"/></svg>']
]

function loadIcon(file) {
  const source = readFileSync(`${DIR}/${file}.mjs`, 'utf8')
  const match = source.match(/createVueComponent\(\s*"(\w+)",\s*"[\w-]+",\s*"[\w-]+",\s*(\[[\s\S]*?\])\s*\);/)
  if (!match) throw new Error(`cannot parse ${file}`)
  const [, variant, body] = match
  return { variant, nodes: JSON.parse(body) }
}

function toSvg({ variant, nodes }) {
  const base = variant === 'filled'
    ? 'fill="currentColor" stroke="none"'
    : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
  const inner = nodes
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .filter(([k]) => k !== 'key')
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ')
      return `<${tag} ${a}/>`
    })
    .join('')
  return `<svg viewBox="0 0 24 24" ${base}>${inner}</svg>`
}

const icons = [
  ...CANDIDATES.map(([file, id, label]) => ({ id, label, svg: toSvg(loadIcon(file)) })),
  ...CUSTOM.map(([id, label, svg]) => ({ id, label, svg }))
]
const userIcon = toSvg(loadIcon('IconUserFilled'))

const cells = icons
  .map(
    (icon) => `
      <div class="cell">
        <div class="pair">
          <span class="avatar ai" data-icon="${icon.id}">${icon.svg}</span>
          <span class="avatar user">${userIcon}</span>
        </div>
        <div class="big">
          <span class="avatar ai" data-icon="${icon.id}">${icon.svg}</span>
        </div>
        <code>${icon.id}</code>
        <small>${icon.label}</small>
      </div>`
  )
  .join('')

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>AI 头像候选</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 28px; background: #f9fafb; color: #1f2937;
         font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  h1 { margin: 0 0 4px; font-size: 18px; }
  p.lead { margin: 0 0 22px; color: #6b7280; }
  h2 { margin: 30px 0 12px; font-size: 13px; letter-spacing: .08em; color: #6b7280; }
  .grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(158px, 1fr)); }
  .cell { padding: 14px; border: 1px solid #e5e7eb; border-radius: 10px; background: #fff; text-align: center; }
  .pair { display: flex; align-items: center; justify-content: center; gap: 6px; }
  .big { margin-top: 12px; }
  .big .avatar { width: 46px; height: 46px; }
  .big .avatar svg { width: 26px; height: 26px; }
  code { display: block; margin-top: 10px; color: #6b7280; font-size: 11px; }
  small { display: block; margin-top: 2px; color: #9ca3af; font-size: 11px; }
  /* 和 AiMessageItem.vue 里的实际样式保持一致 */
  .avatar { display: grid; place-items: center; width: 26px; height: 26px;
            border-radius: 50%; background: #6b7280; color: #fff; }
  .avatar svg { width: 15px; height: 15px; }
  .avatar.ai { background: linear-gradient(135deg, #3b82f6, #2563eb); }
  .dark { margin-top: 34px; padding: 22px; border-radius: 12px; background: #1f2937; color: #e5e7eb; }
  .dark h2 { color: #9ca3af; }
  .dark .cell { border-color: #374151; background: #1f2937; }
  .dark code { color: #9ca3af; }
  .dark small { color: #6b7280; }
  .dark .avatar { background: #9ca3af; color: #1f2937; }
  .dark .avatar.ai { background: linear-gradient(135deg, #60a5fa, #3b82f6); }
</style>
</head>
<body>
  <h1>AI 头像候选</h1>
  <p class="lead">左边是 AI 头像，右边是用户头像（当前用的是人形剪影），可以看两者的搭配是否分得开。每一格下方是放大版。</p>
  <h2>浅色主题</h2>
  <div class="grid">${cells}</div>

  <div class="dark">
    <h2>深色主题</h2>
    <div class="grid">${cells}</div>
  </div>
</body>
</html>`

writeFileSync('avatar-options.html', html)
console.log(`wrote avatar-options.html with ${icons.length} candidates`)
