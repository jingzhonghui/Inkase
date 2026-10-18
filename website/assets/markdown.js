/* ==========================================================================
   Inkase 官网 · 沉浸式版 — 迷你 Markdown 渲染器
   演示区的三种视图都由同一份 Markdown 源码派生，保证三者内容永远一致。
   仅覆盖演示所需的语法子集，不追求完整实现。
   ========================================================================== */
(function (global) {
  'use strict';

  /* 演示文档。中英两版共用这一份渲染器，按 <html lang> 选样例。 */
  var SAMPLE_ZH = [
    '# 项目规划',
    '',
    '把整篇文档打包成**一个文件**，分享时不再丢图。',
    '',
    '- 自包含 .mdx 格式',
    '- 图片自动收入文档',
    '- 三种编辑模式',
    '',
    '> 拷走一个文件，就是带走整篇文档。',
    '',
    '## 下一步',
    '',
    '- [x] 完成核心编辑器',
    '- [ ] 发布 v0.4.0',
    '',
    '![架构图](assets/images/架构图.png)'
  ].join('\n');

  var SAMPLE_EN = [
    '# Project plan',
    '',
    'Pack the whole document into **a single file**, so nothing goes missing when you share it.',
    '',
    '- Self-contained .mdx format',
    '- Images collected into the document',
    '- Three editing modes',
    '',
    '> Take one file away, and you take the whole document with it.',
    '',
    '## Next up',
    '',
    '- [x] Finish the core editor',
    '- [ ] Ship v0.4.0',
    '',
    '![Architecture](assets/images/architecture.png)'
  ].join('\n');

  var SAMPLE = /^en/i.test(document.documentElement.lang || '') ? SAMPLE_EN : SAMPLE_ZH;

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /* ── 行内：**粗体**、*斜体*、`代码`、[链接](url) ── */
  function inline(s) {
    var codes = [];
    var out = esc(s);
    out = out.replace(/`([^`]+)`/g, function (_, c) {
      codes.push(c);
      return '\u0001' + (codes.length - 1) + '\u0001';
    });
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" rel="noopener">$1</a>');
    // \u0001 是上面行内代码占位用的哨兵字符，正文里不可能出现，这里是有意为之
    // eslint-disable-next-line no-control-regex
    out = out.replace(/\u0001(\d+)\u0001/g, function (_, i) {
      return '<code>' + codes[+i] + '</code>';
    });
    return out;
  }

  /* 光标所在行：行内标记原样展开，不做渲染 */
  function inlineMarked(s) {
    return esc(s).replace(/(\*\*)/g, '<span class="ir-inline">$1</span>');
  }

  /* ── 块级解析 ── */
  var RE_H = /^(#{1,6})\s+(.*)$/;
  var RE_UL = /^\s*[-*]\s+/;
  var RE_OL = /^\s*\d+\.\s+/;
  var RE_QUOTE = /^>\s?/;
  var RE_FENCE = /^\s*```/;
  var RE_HR = /^(-{3,}|\*{3,})\s*$/;
  var RE_IMG = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/;
  var RE_TASK = /^\[([ xX])\]\s+(.*)$/;

  function isBlockStart(line) {
    return RE_H.test(line) || RE_UL.test(line) || RE_OL.test(line) ||
           RE_QUOTE.test(line) || RE_FENCE.test(line) || RE_HR.test(line.trim());
  }

  function parse(md) {
    var lines = String(md).split('\n');
    var out = [];
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      if (!line.trim()) { i++; continue; }

      if (RE_FENCE.test(line)) {
        var lang = line.trim().slice(3).trim();
        var buf = [];
        i++;
        while (i < lines.length && !RE_FENCE.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        out.push({ type: 'code', lang: lang, text: buf.join('\n') });
        continue;
      }

      if (RE_HR.test(line.trim())) { out.push({ type: 'hr' }); i++; continue; }

      var h = RE_H.exec(line);
      if (h) { out.push({ type: 'h', level: h[1].length, text: h[2] }); i++; continue; }

      if (RE_QUOTE.test(line)) {
        var q = [];
        while (i < lines.length && RE_QUOTE.test(lines[i])) {
          q.push(lines[i].replace(RE_QUOTE, ''));
          i++;
        }
        out.push({ type: 'quote', text: q.join('\n') });
        continue;
      }

      if (RE_UL.test(line)) {
        var items = [];
        while (i < lines.length && RE_UL.test(lines[i])) {
          var raw = lines[i].replace(RE_UL, '');
          var t = RE_TASK.exec(raw);
          if (t) items.push({ task: true, done: t[1].toLowerCase() === 'x', text: t[2] });
          else items.push({ task: false, text: raw });
          i++;
        }
        out.push({ type: 'ul', items: items });
        continue;
      }

      if (RE_OL.test(line)) {
        var oitems = [];
        while (i < lines.length && RE_OL.test(lines[i])) {
          oitems.push(lines[i].replace(RE_OL, ''));
          i++;
        }
        out.push({ type: 'ol', items: oitems });
        continue;
      }

      var img = RE_IMG.exec(line.trim());
      if (img) { out.push({ type: 'img', alt: img[1], src: img[2] }); i++; continue; }

      var p = [];
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
        p.push(lines[i]);
        i++;
      }
      out.push({ type: 'p', text: p.join('\n') });
    }
    return out;
  }

  var ICON_IMAGE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><rect x="2.2" y="3.2" width="11.6" height="9.6" rx="1.6"/><circle cx="6" cy="6.6" r="1.1"/><path d="m3.2 11.4 3.4-3 2.6 2.3 1.8-1.6 2.2 2"/></svg>';

  /* ── 渲染：预览视图（无标记） ── */
  function render(md) {
    return parse(md).map(function (b) {
      switch (b.type) {
        case 'h':
          return '<h' + b.level + '>' + inline(b.text) + '</h' + b.level + '>';
        case 'p':
          return '<p>' + inline(b.text) + '</p>';
        case 'quote':
          return '<blockquote>' + inline(b.text) + '</blockquote>';
        case 'hr':
          return '<hr>';
        case 'code':
          return '<pre><code>' + esc(b.text) + '</code></pre>';
        case 'img':
          return '<span class="ph">' + ICON_IMAGE + esc(b.alt) + '</span>';
        case 'ul':
          return '<ul>' + b.items.map(function (it) {
            if (it.task) {
              return '<li class="task' + (it.done ? ' is-done' : '') + '">' + inline(it.text) + '</li>';
            }
            return '<li>' + inline(it.text) + '</li>';
          }).join('') + '</ul>';
        case 'ol':
          return '<ol>' + b.items.map(function (it) {
            return '<li>' + inline(it.text) + '</li>';
          }).join('') + '</ol>';
        default:
          return '';
      }
    }).join('');
  }

  /* ── 渲染：即时渲染视图（块级标记常显） ──
     focusIndex 指定"光标所在行"，该行展开行内标记。 */
  function renderIR(md, focusIndex) {
    var blocks = parse(md);
    var n = -1;

    return blocks.map(function (b) {
      n++;
      var focused = n === focusIndex;
      var mark = function (m) { return '<span class="ir-mark">' + esc(m) + '</span>'; };
      var body = focused ? inlineMarked : inline;

      switch (b.type) {
        case 'h':
          return '<div class="ir-block ir-h' + b.level + '">' + mark(new Array(b.level + 1).join('#')) +
                 body(b.text) + '</div>';

        case 'p':
          return '<div class="ir-block ir-p' + (focused ? ' is-focused' : '') + '">' + body(b.text) + '</div>';

        case 'quote':
          return '<div class="ir-block ir-quote">' + mark('&gt;') + body(b.text) + '</div>';

        case 'code':
          return '<div class="ir-block"><span class="ir-mark">```</span>' +
                 '<div class="ir-code">' + esc(b.text) + '</div></div>';

        case 'img':
          return '<div class="ir-block ir-img"><span class="ir-mark">![]</span>' +
                 '<div class="ir-img__box">' + ICON_IMAGE + esc(b.src) + '</div></div>';

        case 'ul':
          return b.items.map(function (it) {
            if (it.task) {
              return '<div class="ir-block ir-task' + (it.done ? ' is-done' : '') + '">' +
                     mark('- [' + (it.done ? 'x' : ' ') + ']') +
                     '<span class="ir-task__text">' + body(it.text) + '</span></div>';
            }
            return '<div class="ir-block ir-li">' + mark('-') + body(it.text) + '</div>';
          }).join('');

        case 'ol':
          return b.items.map(function (it, k) {
            return '<div class="ir-block ir-li">' + mark((k + 1) + '.') + body(it) + '</div>';
          }).join('');

        case 'hr':
          return '<div class="ir-block"><span class="ir-mark">---</span></div>';

        default:
          return '';
      }
    }).join('');
  }

  /* ── 渲染：源码视图（行号 + 标记着色） ── */
  function boldMarks(s) {
    return s.replace(/(\*\*)/g, '<span class="t-mark">$1</span>');
  }

  function hlLine(line) {
    var s = esc(line);
    var m;

    if (RE_FENCE.test(line) || RE_HR.test(line.trim())) {
      return '<span class="t-mark">' + s + '</span>';
    }

    m = /^(\s*)(#{1,6}\s+)([\s\S]*)$/.exec(s);
    if (m) return m[1] + '<span class="t-mark">' + m[2] + '</span>' + boldMarks(m[3]);

    m = /^(\s*)(&gt;\s?)([\s\S]*)$/.exec(s);
    if (m) return m[1] + '<span class="t-mark">' + m[2] + '</span>' + boldMarks(m[3]);

    m = /^(\s*)([-*]\s+)(\[[ xX]\]\s+)?([\s\S]*)$/.exec(s);
    if (m) return m[1] + '<span class="t-mark">' + m[2] + (m[3] || '') + '</span>' + boldMarks(m[4]);

    m = /^(\s*)(!\[)([^\]]*)(\]\()([^)]*)(\))\s*$/.exec(s);
    if (m) {
      return m[1] + '<span class="t-mark">' + m[2] + '</span>' + m[3] +
             '<span class="t-mark">' + m[4] + '</span>' + '<span class="t-dim">' + m[5] + '</span>' +
             '<span class="t-mark">' + m[6] + '</span>';
    }

    return boldMarks(s);
  }

  function renderSource(md) {
    return String(md).split('\n').map(function (line, i) {
      return '<div class="src-row"><span class="src-num">' + (i + 1) + '</span>' +
             '<span class="src-txt">' + (line ? hlLine(line) : '') + '</span></div>';
    }).join('');
  }

  global.MD = {
    SAMPLE: SAMPLE,
    render: render,
    renderIR: renderIR,
    renderSource: renderSource
  };
})(window);
