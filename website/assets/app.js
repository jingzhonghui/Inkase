/* ==========================================================================
   Inkase 官网 · 沉浸式版 — 交互
   外框（大纲 / 状态栏）读取的是页面的真实数据，不是写死的假数字。
   ========================================================================== */
/* global MD */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };

  var reduceMotion = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false };

  // initTheme 里定义的换肤函数，提到这里供壳层的「视图 › 主题」复用。
  var applyTheme = null;

  // initTabs 里定义的「AI 标签」开关，提到这里供壳层开关面板时复用。
  var setAiTab = null;

  /* ── 文案 ────────────────────────────────────────────────────────────────
     中英两版共用这一份脚本，靠 <html lang> 选词。页面上看得见的文字全部走这里，
     不散落在各处，加一门语言只要补一张表。 */
  var LANG = /^en/i.test(document.documentElement.lang || '') ? 'en' : 'zh';
  var LOCALE = LANG === 'en' ? 'en-US' : 'zh-CN';

  var T = {
    zh: {
      isLatest:    '已是最新版本 ',
      toDark:      '切换到深色主题',
      toLight:     '切换到浅色主题',
      saveDownload:'保存并下载 ',
      allowed:     '已允许 · 执行完毕',
      denied:      '已拒绝 · 未执行',
      keepLocal:   '已保留本地改动',
      keepRemote:  '已保留远程改动',
      mergeLines:  '已进入逐行处理',
      show:        '显示',
      hide:        '隐藏',
      modes: {
        ir:     ['即时渲染', '段落开头常显 <code>#</code>、<code>-</code>、<code>&gt;</code> 这些标记，光标所在行展开 <code>**</code> 等行内符号。结构看得见，同时又是所见即所得。'],
        source: ['源码编辑', 'CodeMirror 6 提供的纯源码体验：语法高亮、行号、自动补全、查找替换。'],
        split:  ['分屏预览', '左边写 Markdown，右边实时渲染。滚动同步，分栏比例可拖。']
      },
      // 导图演示：主题文字与结构写在 HTML 里（换语言只改页面），
      // 这里只放「点开某个主题才看得到」的富内容。
      mind: {
        none: '—',
        collapse: '折叠「%s」',
        expand: '展开「%s」',
        nodes: {
          root:      { id: 'n_root', note: 'v0.4 的收尾清单，细节见附件。', tags: ['P1'], icons: [['⭐', '星标']], files: [{ name: '范围说明.pdf', size: '128 KB' }] },
          design:    { id: 'n_4a1c', note: '先定信息架构，再出视觉稿。', tags: [], icons: [], files: [] },
          'design-a': { id: 'n_4a1d', note: '', tags: ['P2'], icons: [], files: [] },
          'design-b': { id: 'n_4a1e', note: '深色优先，浅色跟随系统。', tags: ['P2'], icons: [['❗', '重点']], files: [] },
          dev:       { id: 'n_7b20', note: '', tags: [], icons: [], files: [{ name: '接口草案.md', size: '12 KB' }] },
          'dev-a':   { id: 'n_7b21', note: '快捷键与 XMind 保持一致。', tags: ['P1'], icons: [['⭐', '星标']], files: [] },
          'dev-a1':  { id: 'n_7b22', note: 'Tab / Enter / F2 / Delete。', tags: [], icons: [], files: [] },
          'dev-b':   { id: 'n_7b23', note: 'PNG 出 2 倍图，SVG 出矢量。', tags: [], icons: [['✅', '已完成']], files: [] },
          rel:       { id: 'n_9c30', note: '', tags: [], icons: [], files: [] },
          'rel-a':   { id: 'n_9c31', note: '', tags: [], icons: [], files: [] },
          'rel-b':   { id: 'n_9c32', note: '发布当天再推一次更新。', tags: [], icons: [], files: [] }
        }
      },
      // 壳层：菜单点开的反应、面板里的动作、预设的 AI 回答
      shell: {
        demo:         '演示界面：「%s」不会真的执行',
        themed:       '外观已切换（演示，只改本站）',
        pulled:       '已拉取最新改动（演示）',
        pushed:       '已推送 3 个提交（演示）',
        disabled:     '已停用同步（演示，配置没动）',
        saved:        '设置已保存（演示，不写盘）',
        newChat:      '已新建会话（演示）',
        sample:       '把这个文档转成思维导图',
        welcomeTitle: '从文稿开始',
        welcomeBody:  '提问、改写，或添加材料作为参考。',
        thinking:     '正在调用工具…',
        done:         '已完成',
        tools:        ['read_document', 'extract_headings', 'create_mindmap'],
        answer:       '已按标题层级生成 发布计划.inkmind，共 11 个主题。原文档没有改动。',
        you:          '你',
        ai:           'AI 助手',
        aiClose:      '关闭 AI 面板，回到文稿'
      }
    },
    en: {
      isLatest:    'Up to date · ',
      toDark:      'Switch to dark theme',
      toLight:     'Switch to light theme',
      saveDownload:'Save and download ',
      allowed:     'Allowed · Finished',
      denied:      'Denied · Not run',
      keepLocal:   'Kept local changes',
      keepRemote:  'Kept remote changes',
      mergeLines:  'Resolving line by line',
      show:        'Show',
      hide:        'Hide',
      modes: {
        ir:     ['Live rendering', 'Block markers like <code>#</code>, <code>-</code> and <code>&gt;</code> stay visible at the start of every line, while inline markers such as <code>**</code> expand on the line your cursor is on. The structure stays visible, and the result is still what you see is what you get.'],
        source: ['Source', 'A plain CodeMirror 6 experience: syntax highlighting, line numbers, autocomplete, find and replace.'],
        split:  ['Split preview', 'Write Markdown on the left, watch it render live on the right. Scrolling stays in sync and the divider can be dragged.']
      },
      mind: {
        none: '—',
        collapse: 'Collapse "%s"',
        expand: 'Expand "%s"',
        nodes: {
          root:      { id: 'n_root', note: 'Release checklist for v0.4 — details in the attachment.', tags: ['P1'], icons: [['⭐', 'Star']], files: [{ name: 'scope.pdf', size: '128 KB' }] },
          design:    { id: 'n_4a1c', note: 'Structure first, visuals second.', tags: [], icons: [], files: [] },
          'design-a': { id: 'n_4a1d', note: '', tags: ['P2'], icons: [], files: [] },
          'design-b': { id: 'n_4a1e', note: 'Dark first, light follows the system.', tags: ['P2'], icons: [['❗', 'Important']], files: [] },
          dev:       { id: 'n_7b20', note: '', tags: [], icons: [], files: [{ name: 'api-draft.md', size: '12 KB' }] },
          'dev-a':   { id: 'n_7b21', note: 'Shortcuts follow XMind.', tags: ['P1'], icons: [['⭐', 'Star']], files: [] },
          'dev-a1':  { id: 'n_7b22', note: 'Tab / Enter / F2 / Delete.', tags: [], icons: [], files: [] },
          'dev-b':   { id: 'n_7b23', note: 'PNG at 2×, SVG as vectors.', tags: [], icons: [['✅', 'Done']], files: [] },
          rel:       { id: 'n_9c30', note: '', tags: [], icons: [], files: [] },
          'rel-a':   { id: 'n_9c31', note: '', tags: [], icons: [], files: [] },
          'rel-b':   { id: 'n_9c32', note: 'Push one more update on release day.', tags: [], icons: [], files: [] }
        }
      },
      shell: {
        demo:         'Demo UI — "%s" is not actually run',
        themed:       'Appearance switched (demo: this site only)',
        pulled:       'Pulled the latest changes (demo)',
        pushed:       'Pushed 3 commits (demo)',
        disabled:     'Sync disabled (demo: config untouched)',
        saved:        'Settings saved (demo: nothing written)',
        newChat:      'Started a new chat (demo)',
        sample:       'Turn this document into a mind map',
        welcomeTitle: 'Start from the document',
        welcomeBody:  'Ask, rewrite, or add material as reference.',
        thinking:     'Calling tools…',
        done:         'Completed',
        tools:        ['read_document', 'extract_headings', 'create_mindmap'],
        answer:       'Created Release plan.inkmind from the heading structure — 11 topics. The document is untouched.',
        you:          'You',
        ai:           'AI assistant',
        aiClose:      'Close the AI panel and go back to the document'
      }
    }
  }[LANG];

  /* ── 进场 ───────────────────────────────────────────────────────────── */
  function initReveal() {
    var els = $$('[data-reveal]');
    if (!els.length) return;

    if (reduceMotion.matches || !('IntersectionObserver' in window)) {
      els.forEach(function (el) { el.classList.add('is-in'); });
      return;
    }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.06 });

    els.forEach(function (el) { io.observe(el); });
  }

  /* ── 通用标签页（WAI-ARIA tabs 模式） ───────────────────────────────── */
  function setupTabs(tabs, onSelect) {
    var index = 0;

    function select(next, moveFocus) {
      index = (next + tabs.length) % tabs.length;

      tabs.forEach(function (tab, i) {
        var on = i === index;
        tab.classList.toggle('is-active', on);
        tab.setAttribute('aria-selected', on ? 'true' : 'false');
        tab.tabIndex = on ? 0 : -1;
        var pane = document.getElementById(tab.getAttribute('aria-controls'));
        if (pane) pane.hidden = !on;
      });

      if (moveFocus) tabs[index].focus();
      if (onSelect) onSelect(tabs[index], index);
    }

    tabs.forEach(function (tab, i) {
      tab.addEventListener('click', function () { select(i, false); });
      tab.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); select(i + 1, true); }
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); select(i - 1, true); }
        else if (e.key === 'Home') { e.preventDefault(); select(0, true); }
        else if (e.key === 'End') { e.preventDefault(); select(tabs.length - 1, true); }
      });
    });

    select(0, false);
    return { select: select, current: function () { return index; } };
  }

  /* ── §2 结构浏览器 ──────────────────────────────────────────────────── */
  function initAnatomy() {
    var tabs = $$('.anatomy__tree .tree-row');
    if (tabs.length) setupTabs(tabs);
  }

  /* ── §3 三种编辑模式 ────────────────────────────────────────────────── */
  var MODE_COPY = T.modes;

  function initDemo() {
    var root = $('.editor');
    if (!root || !window.MD) return;

    var irView = $('#ir-view');
    var srcView = $('#src-view');
    var splitSrc = $('#split-src');
    var splitPrev = $('#split-prev');
    var caption = $('#mode-caption');
    var pill = $('#stat-mode');

    // 三种视图全部由同一份源码派生
    irView.innerHTML = MD.renderIR(MD.SAMPLE, 1);
    srcView.innerHTML = MD.renderSource(MD.SAMPLE);
    splitSrc.innerHTML = MD.renderSource(MD.SAMPLE);
    splitPrev.innerHTML = MD.render(MD.SAMPLE);

    var tabs = $$('.mtab', root);
    var controller = setupTabs(tabs, function (tab) {
      var mode = tab.getAttribute('data-mode');
      var copy = MODE_COPY[mode];
      if (!copy) return;

      root.setAttribute('data-mode', mode);
      caption.setAttribute('data-mode', mode);
      caption.innerHTML = '<b>' + copy[0] + '</b> — ' + copy[1];

      // 状态栏的模式胶囊跟着一起变
      if (pill) {
        pill.textContent = copy[0];
        pill.setAttribute('data-mode', mode);
      }
    });

    // Ctrl+/ 循环切换：焦点在演示区内时才生效，不劫持整页快捷键
    root.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        controller.select(controller.current() + 1, false);
      }
    });
  }

  /* ── §4 思维导图 ────────────────────────────────────────────────────── */
  /** 只用于拼内部常量表里的文本，避免任何一处少转义就变成注入点 */
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function initMindMap() {
    var stage = $('#mind-stage');
    var wires = $('#mind-wires');
    var ctl = $('#mind-collapse');
    if (!stage || !wires) return;

    var nodes = $$('.mnode', stage);
    var byId = {};
    nodes.forEach(function (el) { byId[el.getAttribute('data-node')] = el; });

    // 折叠按钮作用于「开发」那一支；文案里的分支名从节点本身读，换语言不用改脚本
    var BRANCH = 'dev';
    var branch = byId[BRANCH];
    if (!branch) return;

    var META = T.mind.nodes;

    function textOf(el) {
      var inner = el.querySelector('.mnode__text');
      return ((inner || el).textContent || '').trim();
    }

    function visible(el) {
      return Boolean(el) && el.offsetParent !== null;
    }

    /* 连线由节点的实际位置算出来：换语言、改节点宽度都不用动一个坐标。
       父节点右边缘 → 子节点左边缘，两端各留 1px，用两条控制点画成平滑的 S 形。 */
    function drawWires() {
      var out = [];

      nodes.forEach(function (el) {
        var parentId = el.getAttribute('data-parent');
        if (!parentId) return;

        var parent = byId[parentId];
        if (!parent || !visible(el) || !visible(parent)) return;

        var x1 = parent.offsetLeft + parent.offsetWidth + 1;
        var y1 = parent.offsetTop + parent.offsetHeight / 2;
        var x2 = el.offsetLeft - 1;
        var y2 = el.offsetTop + el.offsetHeight / 2;
        var bend = Math.max(14, (x2 - x1) * 0.55);

        out.push(
          '<path class="mwire mwire--' + (el.getAttribute('data-branch') || '0') + '" d="M' +
          x1 + ' ' + y1 +
          'C' + (x1 + bend) + ' ' + y1 + ',' + (x2 - bend) + ' ' + y2 +
          ',' + x2 + ' ' + y2 + '"/>'
        );
      });

      wires.innerHTML = out.join('');
    }

    function fill(el, html) {
      if (!el) return;
      el.innerHTML = html;
      el.classList.toggle('is-empty', html === '' || html === T.mind.none);
    }

    /* 属性栏还原的是真实 Inspector：主题、备注、标签、图标、附件 */
    function renderInspector(id) {
      var el = byId[id];
      if (!el) return;

      var meta = META[id] || {};
      var text = $('#mi-text');
      var idEl = $('#mi-id');

      if (idEl) idEl.textContent = el.getAttribute('data-id') || '';
      if (text) text.textContent = textOf(el);

      fill($('#mi-note'), meta.note ? esc(meta.note) : T.mind.none);

      fill($('#mi-tags'), (meta.tags || []).map(function (p) {
        return '<span class="mtag" data-p="' + esc(p) + '">' + esc(p) + '</span>';
      }).join(''));

      fill($('#mi-icons'), (meta.icons || []).map(function (pair) {
        return '<span class="micon"><b>' + esc(pair[0]) + '</b>' + esc(pair[1]) + '</span>';
      }).join(''));

      fill($('#mi-files'), (meta.files || []).map(function (file) {
        return '<span class="mfile"><svg aria-hidden="true"><use href="#i-clip"/></svg>' +
               '<span>' + esc(file.name) + '</span><em>' + esc(file.size) + '</em></span>';
      }).join(''));
    }

    function select(id) {
      nodes.forEach(function (el) {
        var on = el.getAttribute('data-node') === id;
        el.classList.toggle('is-selected', on);
        el.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      renderInspector(id);
    }

    /* 递归求某个主题下的全部后代——折叠时要整支一起收起来 */
    function descendantsOf(id) {
      var found = {};
      var queue = [id];

      while (queue.length) {
        var current = queue.shift();
        nodes.forEach(function (el) {
          if (el.getAttribute('data-parent') !== current) return;
          var childId = el.getAttribute('data-node');
          if (found[childId]) return;
          found[childId] = true;
          queue.push(childId);
        });
      }

      return found;
    }

    var collapsed = false;

    function applyCollapse(next) {
      var doomed = descendantsOf(BRANCH);
      var current = stage.querySelector('.mnode.is-selected');
      var selectedId = current ? current.getAttribute('data-node') : null;

      nodes.forEach(function (el) {
        var hide = next && doomed[el.getAttribute('data-node')];
        el.classList.toggle('is-hidden', Boolean(hide));
        if (hide) el.setAttribute('aria-hidden', 'true');
        else el.removeAttribute('aria-hidden');
        // 藏起来的节点不能再被 Tab 命中，否则焦点会跳进不可见的地方
        el.tabIndex = hide ? -1 : 0;
      });

      branch.classList.toggle('is-collapsed', next);

      if (ctl) {
        var copy = next ? T.mind.expand : T.mind.collapse;
        ctl.textContent = copy.replace('%s', textOf(branch));
        ctl.setAttribute('aria-pressed', next ? 'true' : 'false');
      }

      drawWires();

      // 正被选中的主题如果被折叠藏起来了，把选中挪回分支主题上
      if (next && selectedId && doomed[selectedId]) select(BRANCH);
    }

    stage.addEventListener('click', function (e) {
      var target = e.target instanceof Element ? e.target.closest('.mnode') : null;
      if (!target) return;
      select(target.getAttribute('data-node'));
    });

    if (ctl) {
      ctl.textContent = T.mind.collapse.replace('%s', textOf(branch));
      ctl.addEventListener('click', function () {
        collapsed = !collapsed;
        applyCollapse(collapsed);
      });
    }

    select('root');
    drawWires();

    // 字体晚到会改变文字的排版宽度，连线要再算一次
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(drawWires);
    window.addEventListener('load', drawWires);
  }

  /* ── §5 图表 ────────────────────────────────────────────────────────── */
  function initDiagram() {
    var tabs = $$('.dgm__tab');
    if (tabs.length) setupTabs(tabs);

    var stage = $('.dgm__stage');
    if (!stage) return;

    // 点图形高亮，模拟 drawio 的选中；再点一次取消
    stage.addEventListener('click', function (e) {
      var target = e.target instanceof Element ? e.target.closest('.dgm-shape') : null;
      if (!target) return;

      var wasOn = target.classList.contains('is-selected');
      $$('.dgm-shape', stage).forEach(function (shape) {
        shape.classList.remove('is-selected');
      });
      if (!wasOn) target.classList.add('is-selected');
    });
  }

  /* ── §5 另存为 ──────────────────────────────────────────────────────── */
  var REPO = 'jingzhonghui/Inkase';
  var RELEASES = 'https://github.com/' + REPO + '/releases';
  // 页面内置的版本。它只是"没有网络时也能读"的兜底，真实版本由 initVersion 从 GitHub 取。
  var VERSION = '0.3.6';

  function initSaveAs() {
    var pkgs = $$('.pkg:not(.pkg--soon)');
    var nameInput = $('#saveName');
    var typeInput = $('#saveType');
    var saveBtn = $('#saveBtn');
    if (!pkgs.length) return null;

    var selected = pkgs[0];

    function apply() {
      var file = selected.getAttribute('data-file');
      nameInput.value = file;
      typeInput.value = selected.getAttribute('data-type');
      saveBtn.setAttribute('aria-label', T.saveDownload + file);
      // 一律走 releases/latest：GitHub 会重定向到最新 release，
      // 所以即使站点部署之后又发了新版本，这个链接也不会指向旧产物。
      saveBtn.href = RELEASES + '/latest';
    }

    function pick(target) {
      selected = target;
      pkgs.forEach(function (pkg) {
        var on = pkg === target;
        pkg.classList.toggle('is-selected', on);
        pkg.setAttribute('aria-checked', on ? 'true' : 'false');
      });
      apply();
    }

    pkgs.forEach(function (pkg, i) {
      pkg.addEventListener('click', function () { pick(pkg); });
      pkg.addEventListener('keydown', function (e) {
        var step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1
                 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        var next = pkgs[(i + step + pkgs.length) % pkgs.length];
        pick(next);
        next.focus();
      });
    });

    apply();
  }

  /* ── 版本提示 ────────────────────────────────────────────────────────── */
  // 版本号由 scripts/stamp-site-version.mjs 在部署前写死进静态文件，这里只负责显示。
  // 以前这里会去 api.github.com 取最新 release 再改写页面上的产物名，但匿名配额只有
  // 60 次/小时/每个 IP、部分网络下还连不上，而且失败是静默的 —— 结果是页面长期显示
  // 写死的旧版本号，看起来还挺"权威"。现在这件事挪到部署前的 CI 里做，访客侧不再
  // 依赖任何第三方接口。
  function initVersionNote() {
    var note = $('#verNote');
    if (note) note.innerHTML = T.isLatest + '<b>v' + VERSION + '</b>';
  }

  /* ── 主题：深色 / 浅色 ──────────────────────────────────────────────── */
  function initTheme() {
    var btn = $('#themeBtn');
    var root = document.documentElement;
    if (!btn) return;

    var label = $('#themeLabel');
    var meta = $('#themeColor');
    var COLORS = { dark: '#08090c', light: '#e9ebef' };

    function render(theme) {
      var light = theme === 'light';
      root.setAttribute('data-theme', theme);
      btn.setAttribute('aria-pressed', light ? 'true' : 'false');
      if (label) label.textContent = light ? T.toDark : T.toLight;
      if (meta) meta.setAttribute('content', COLORS[theme]);
    }

    render(root.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
    applyTheme = render;

    btn.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      render(next);
      try { localStorage.setItem('inkase-theme', next); } catch { /* 隐私模式下写不进去就算了，本次切换照常生效 */ }
    });

    // 刻意不跟随系统偏好：官网默认就是深色，只有访客自己按过按钮才改变。
    // （页面里"浅色、深色、跟随系统"那句说的是应用本身的能力，不是本站的行为。）
  }

  /* ── 移动端大纲抽屉 ─────────────────────────────────────────────────── */
  function initDrawer() {
    var btn = $('#outlineBtn');
    var sidebar = $('#sidebar');
    var scrim = $('#scrim');
    if (!btn || !sidebar || !scrim) return;

    function setOpen(open) {
      sidebar.classList.toggle('is-open', open);
      scrim.classList.toggle('is-open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    btn.addEventListener('click', function () {
      setOpen(!sidebar.classList.contains('is-open'));
    });
    scrim.addEventListener('click', function () { setOpen(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') setOpen(false);
    });
    $$('.outline__item').forEach(function (link) {
      link.addEventListener('click', function () { setOpen(false); });
    });
  }

  /* ── 大纲高亮 + 状态栏读数 ──────────────────────────────────────────── */
  function initTracking() {
    var links = $$('.outline__item');
    var doc = $('#doc');
    var lineEl = $('#stat-line');
    var wordsEl = $('#stat-words');
    var sizeEl = $('#stat-size');

    var sections = links.map(function (link) {
      return document.getElementById(link.getAttribute('href').slice(1));
    });

    // 字数与文件大小：量的是这个页面的真实正文
    if (doc && wordsEl && sizeEl) {
      var raw = doc.innerText || doc.textContent || '';
      var chars = raw.replace(/\s+/g, '').length;
      var bytes = new Blob([raw]).size;

      wordsEl.textContent = chars.toLocaleString(LOCALE);
      sizeEl.textContent = bytes < 1024 ? bytes + ' B'
        : bytes < 1048576 ? (bytes / 1024).toFixed(1) + ' KB'
        : (bytes / 1048576).toFixed(1) + ' MB';
    }

    // 行号：按 28px 行高换算这份文档有多少行，再映射滚动进度
    var totalLines = 1;
    function measure() {
      totalLines = Math.max(1, Math.round(document.documentElement.scrollHeight / 28));
    }

    var current = -1;

    function update() {
      var scrollY = window.scrollY || window.pageYOffset;
      var viewport = window.innerHeight;
      var probe = scrollY + viewport * 0.3;

      var index = 0;
      for (var i = 0; i < sections.length; i++) {
        var el = sections[i];
        if (el && el.getBoundingClientRect().top + scrollY <= probe) index = i;
      }
      // 只有页面真的能滚动时，触底才等于"最后一段"
      var max = document.documentElement.scrollHeight - viewport;
      if (max > 8 && scrollY >= max - 4) index = sections.length - 1;

      if (index !== current) {
        current = index;
        links.forEach(function (link, i) {
          var on = i === index;
          link.classList.toggle('is-current', on);
          if (on) link.setAttribute('aria-current', 'true');
          else link.removeAttribute('aria-current');
        });
      }

      if (lineEl) {
        var p = max > 0 ? Math.min(1, Math.max(0, scrollY / max)) : 0;
        lineEl.textContent = (1 + Math.round(p * (totalLines - 1))).toLocaleString(LOCALE);
      }
    }

    // rAF 节流。这里刻意不记录"rafId 是否为真"再据此判断 rAF 有没有回调：
    // 无头环境或后台标签里 requestAnimationFrame 可能既不回调、返回值也不可靠，
    // 那样就会把之后所有滚动都吞掉。改用一次性的 done 闩，两条腿谁先到谁生效。
    var pending = false;

    function onScroll() {
      if (pending) return;
      pending = true;

      var done = false;
      function run() {
        if (done) return;
        done = true;
        pending = false;
        update();
      }

      window.requestAnimationFrame(run);
      window.setTimeout(run, 120);
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', function () { measure(); update(); });

    measure();
    update();
    // 字体加载完成后重新量一次，行数才准
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { measure(); update(); });
    }
    window.addEventListener('load', function () { measure(); update(); });
  }

  /* ── §4–§6 三块面板：PDF 反色 / AI 审批 / 同步 ─────────────────────── */
  function initPanels() {
    // PDF：深色反色开关，用的就是应用里真实的那条 filter
    var pdf = $('.pdf');
    var invert = $('#pdf-invert');
    if (pdf && invert) {
      invert.addEventListener('click', function () {
        var on = pdf.classList.toggle('is-inverted');
        invert.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }

    // AI：工具调用审批——点允许或拒绝，卡片给出结果
    var tool = $('#ai-tool');
    var toolState = $('#ai-tool-state');
    if (tool && toolState) {
      $$('.tool__btn', tool).forEach(function (btn) {
        btn.addEventListener('click', function () {
          var allow = btn.getAttribute('data-verdict') === 'allow';
          tool.classList.toggle('is-allowed', allow);
          tool.classList.toggle('is-denied', !allow);
          toolState.textContent = allow ? T.allowed : T.denied;
        });
      });
    }

    // 同步：Git / WebDAV 后端切换
    var ptabs = $$('.sync__ptab');
    if (ptabs.length) setupTabs(ptabs);

    // 冲突裁决
    var conflict = $('#conflict');
    var conflictState = $('#conflict-state');
    if (conflict && conflictState) {
      var VERDICT = { local: T.keepLocal, remote: T.keepRemote, merge: T.mergeLines };
      $$('[data-resolve]', conflict).forEach(function (btn) {
        btn.addEventListener('click', function () {
          conflict.classList.add('is-resolved');
          conflictState.textContent = VERDICT[btn.getAttribute('data-resolve')] || '';
        });
      });
    }

    // WebDAV 口令显隐
    var eye = $('#dav-eye');
    var pw = $('#dav-pw');
    if (eye && pw) {
      var masked = pw.textContent;
      eye.addEventListener('click', function () {
        var shown = eye.getAttribute('aria-pressed') !== 'true';
        eye.setAttribute('aria-pressed', shown ? 'true' : 'false');
        eye.textContent = shown ? T.hide : T.show;
        pw.textContent = shown ? 'app-token-8f3a2c' : masked;
      });
    }
  }

  /* ── 壳层：让这个「软件窗口」真的能点 ──────────────────────────────────
     原则是「所有操作都有可见的界面反应，但都不产生数据」：菜单能展开、面板能弹出、
     对话框能打开、AI 会假装调用工具，但一个文件都不会被创建或修改。 */
  function initShell() {
    var menubar = $('#menubar');
    var layer = $('#menuLayer');
    var toastEl = $('#toast');
    var dialogLayers = $$('.dlg-layer');
    if (!menubar || !layer) return;

    var openId = null;
    var openSub = null;
    var openPanel = null;
    var openDialog = null;
    var surfaceFocus = null;
    var toastTimer = 0;

    function fmt(tpl, value) { return tpl.replace('%s', value); }

    function toast(msg) {
      if (!toastEl) return;
      toastEl.textContent = msg;
      toastEl.classList.add('is-show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { toastEl.classList.remove('is-show'); }, 2400);
    }

    function menuOf(id) { return $('#menu-' + id, layer); }
    function itemsOf(menu) {
      return $$('.menu__item', menu).filter(function (el) { return el.parentNode === menu; });
    }

    /* — 菜单 — */
    function closeSub() {
      if (!openSub) return;
      var host = $('[data-sub="' + openSub.id + '"]', layer);
      openSub.hidden = true;
      if (host) host.setAttribute('aria-expanded', 'false');
      openSub = null;
    }

    function showSub(item) {
      var sub = $('#' + item.getAttribute('data-sub'), layer);
      if (!sub || sub === openSub) return;
      closeSub();
      sub.hidden = false;
      sub.style.top = '';
      sub.style.left = '';
      sub.style.right = '';
      sub.style.marginLeft = '2px';
      sub.style.marginRight = '0';

      // 右边界：放不下就翻到左侧
      if (item.getBoundingClientRect().right + sub.offsetWidth + 8 > window.innerWidth) {
        sub.style.left = 'auto';
        sub.style.right = '100%';
        sub.style.marginLeft = '0';
        sub.style.marginRight = '2px';
      }
      // 下边界：溢出就把整张子菜单往上提
      var over = sub.getBoundingClientRect().bottom - (window.innerHeight - 8);
      if (over > 0) sub.style.top = (item.offsetTop - 5 - over) + 'px';

      item.setAttribute('aria-expanded', 'true');
      openSub = sub;
    }

    function closeMenu(back) {
      if (openId === null) return;
      closeSub();
      $$('.menu', layer).forEach(function (m) { m.hidden = true; });
      $$('.menubar__item', menubar).forEach(function (b) { b.setAttribute('aria-expanded', 'false'); });
      layer.hidden = true;
      openId = null;
      if (back && surfaceFocus) surfaceFocus.focus();
    }

    function openMenu(btn) {
      var id = btn.getAttribute('data-menu');
      var menu = menuOf(id);
      if (!menu) return;
      closeSub();
      $$('.menu', layer).forEach(function (m) { if (m !== menu) m.hidden = true; });
      $$('.menubar__item', menubar).forEach(function (b) {
        b.setAttribute('aria-expanded', b === btn ? 'true' : 'false');
      });
      layer.hidden = false;
      menu.hidden = false;

      var lr = layer.getBoundingClientRect();
      var br = btn.getBoundingClientRect();
      var w = menu.offsetWidth;
      var left = br.left - lr.left;
      if (left + w > lr.width - 8) left = Math.max(8, lr.width - w - 8);
      menu.style.left = left + 'px';
      menu.style.top = (br.bottom - lr.top + 2) + 'px';

      openId = id;
      surfaceFocus = btn;
    }

    $$('.menubar__item', menubar).forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (openId === btn.getAttribute('data-menu')) closeMenu(true);
        else openMenu(btn);
      });
      // 已经开着一层菜单时，鼠标横向划过就跟着换
      btn.addEventListener('mouseenter', function () {
        if (openId !== null && openId !== btn.getAttribute('data-menu')) openMenu(btn);
      });
      btn.addEventListener('keydown', function (e) {
        var rail = $$('.menubar__item', menubar);
        var i = rail.indexOf(btn);
        var target = null;
        if (e.key === 'ArrowRight') target = rail[(i + 1) % rail.length];
        else if (e.key === 'ArrowLeft') target = rail[(i - 1 + rail.length) % rail.length];
        if (target) {
          e.preventDefault();
          target.focus();
          if (openId !== null) openMenu(target);
          return;
        }
        if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openMenu(btn);
          var items = itemsOf(menuOf(btn.getAttribute('data-menu')));
          if (items.length) items[0].focus();
        }
      });
    });

    layer.addEventListener('mouseover', function (e) {
      var item = e.target.closest ? e.target.closest('.menu__item') : null;
      if (!item) return;
      if (item.getAttribute('data-sub')) showSub(item);
      else if (openSub && item.parentNode !== openSub) closeSub();
    });

    layer.addEventListener('keydown', function (e) {
      var item = e.target.closest ? e.target.closest('.menu__item') : null;
      if (!item) return;
      var menu = item.parentNode;
      var items = itemsOf(menu);
      var i = items.indexOf(item);
      var isSub = menu.classList.contains('menu--sub');

      if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
      else if (e.key === 'ArrowRight' && item.getAttribute('data-sub')) {
        e.preventDefault();
        showSub(item);
        if (openSub && itemsOf(openSub).length) itemsOf(openSub)[0].focus();
      } else if (e.key === 'ArrowLeft' && isSub) {
        e.preventDefault();
        var host = $('[data-sub="' + menu.id + '"]', layer);
        closeSub();
        if (host) host.focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        if (isSub) {
          var back = $('[data-sub="' + menu.id + '"]', layer);
          closeSub();
          if (back) back.focus();
        } else {
          closeMenu(true);
        }
      } else if (e.key === 'Tab') {
        closeMenu(false);
      }
    });

    document.addEventListener('click', function (e) {
      if (openId === null) return;
      if (layer.contains(e.target) || menubar.contains(e.target)) return;
      closeMenu(false);
    });

    /* — 主题菜单项 — */
    var themeItems = $$('[data-theme-set]', layer);
    function markTheme(name) {
      themeItems.forEach(function (b) {
        b.setAttribute('aria-checked', b.getAttribute('data-theme-set') === name ? 'true' : 'false');
      });
    }
    function pickTheme(name) {
      var next = name;
      if (next === 'system') {
        next = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches)
          ? 'light' : 'dark';
      }
      if (applyTheme) applyTheme(next);
      try { localStorage.setItem('inkase-theme', next); } catch (err) { /* 隐私模式忽略 */ }
      markTheme(name);
      toast(T.shell.themed);
    }

    /* — 同步浮层 / AI 面板（结构对齐真实组件：同步是标题栏下的 320px 浮层，
         AI 是占满工作区的整块面板，两者都不是遮罩式抽屉） — */
    function closeSurface() {
      var back = surfaceFocus;
      var wasAi = !!(openPanel && openPanel.id === 'aiPanel');
      if (openPanel) {
        openPanel.hidden = true;
        openPanel = null;
      }
      if (openDialog) {
        openDialog.hidden = true;
        openDialog = null;
      }
      surfaceFocus = null;
      if (wasAi && setAiTab) setAiTab(false);
      if (back && typeof back.focus === 'function') back.focus();
    }

    function openSurface(name) {
      if (name === 'sync' || name === 'ai') {
        var panel = $(name === 'ai' ? '#aiPanel' : '#syncPanel');
        if (!panel) return;
        closeSurface();
        surfaceFocus = document.activeElement;
        panel.hidden = false;
        openPanel = panel;
        if (name === 'ai') {
          if (setAiTab) setAiTab(true);
          var input = $('#aiInput');
          if (input) input.focus();
        } else {
          var firstBtn = $('.sp-btn', panel);
          if (firstBtn) firstBtn.focus();
        }
        return;
      }
      var dlg = $('#dlg-' + name);
      if (!dlg) return;
      closeSurface();
      surfaceFocus = document.activeElement;
      dlg.hidden = false;
      openDialog = dlg;
      var firstTab = $('.dlg__tab[aria-selected="true"]', dlg) || $('button', dlg);
      if (firstTab) firstTab.focus();
    }

    document.addEventListener('click', function (e) {
      var item = e.target.closest ? e.target.closest('.menu__item') : null;
      if (item && !item.disabled) {
        if (item.getAttribute('data-sub')) {
          showSub(item);
          return;
        }
        var surface = item.getAttribute('data-surface');
        var theme = item.getAttribute('data-theme-set');
        var labelEl = item.querySelector('span');
        var label = labelEl ? labelEl.textContent.trim() : '';
        closeMenu(true);
        if (surface) openSurface(surface);
        else if (theme) pickTheme(theme);
        else toast(fmt(T.shell.demo, label));
        return;
      }

      var closer = e.target.closest ? e.target.closest('[data-close]') : null;
      if (closer) { closeSurface(); return; }

      // 标题栏的同步 / AI 图标，以及菜单项之外任何带 data-surface 的入口
      var surf = e.target.closest ? e.target.closest('[data-surface]') : null;
      if (surf && !surf.closest('.menu')) {
        openSurface(surf.getAttribute('data-surface'));
        return;
      }

      var act = e.target.closest ? e.target.closest('[data-surface-act]') : null;
      if (act) {
        var what = act.getAttribute('data-surface-act');
        if (what === 'pull') toast(T.shell.pulled);
        else if (what === 'push') toast(T.shell.pushed);
        else if (what === 'disable') toast(T.shell.disabled);
        else if (what === 'new-chat') { resetChat(); toast(T.shell.newChat); }
        else if (what === 'settings-save') { closeSurface(); toast(T.shell.saved); }
      }
    });

    // 标签栏：点 AI 标签的 × 或点任意文稿标签，都回到正文
    var tabbar = $('.tabbar');
    if (tabbar) {
      tabbar.addEventListener('click', function (e) {
        var tab = e.target.closest ? e.target.closest('.tab') : null;
        if (!tab) return;
        var x = e.target.closest('[data-close]');
        if (x) { e.preventDefault(); closeSurface(); return; }
        if (tab.classList.contains('tab--ai')) { e.preventDefault(); return; }
        if (openPanel && openPanel.id === 'aiPanel') closeSurface();
      });
    }

    dialogLayers.forEach(function (dl) {
      dl.addEventListener('click', function (e) { if (e.target === dl) closeSurface(); });
    });

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (openPanel || openDialog) { closeSurface(); return; }
      if (openSub) { closeSub(); return; }
      if (openId !== null) closeMenu(true);
    });

    window.addEventListener('resize', function () {
      if (openId !== null) closeMenu(false);
    });

    /* — 设置对话框内部：分页、开关、分段、下拉、滑杆 — */
    $$('.dlg__tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        var box = tab.closest('.dlg');
        if (!box) return;
        $$('.dlg__tab', box).forEach(function (t) {
          t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
        });
        var pane = tab.getAttribute('aria-controls');
        $$('.dlg__pane', box).forEach(function (p) { p.hidden = p.id !== pane; });
      });
    });

    $$('.switch').forEach(function (sw) {
      sw.addEventListener('click', function () {
        sw.setAttribute('aria-checked', sw.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
      });
    });

    $$('.seg').forEach(function (seg) {
      var opts = $$('.seg__opt', seg);
      opts.forEach(function (opt) {
        opt.addEventListener('click', function () {
          opts.forEach(function (o) { o.setAttribute('aria-pressed', o === opt ? 'true' : 'false'); });
        });
      });
    });

    $$('.range').forEach(function (range) {
      var out = $('#' + range.getAttribute('data-out'));
      if (!out) return;
      var paint = function () { out.textContent = range.value + (range.getAttribute('data-unit') || ''); };
      range.addEventListener('input', paint);
      paint();
    });

    /* — AI 助手：假装调用工具，然后给一段预设回答（结构与 AiMessageItem 一致） — */
    var busy = false;

    function chatThread() {
      var list = $('#aiLog');
      if (!list) return null;
      var thread = $('.ai-thread', list);
      if (!thread) {
        list.innerHTML = '';
        thread = document.createElement('div');
        thread.className = 'ai-thread';
        list.appendChild(thread);
      }
      return thread;
    }

    function messageEl(role, avatarText, avatarLabel) {
      var article = document.createElement('article');
      article.className = 'ai-msg ai-msg--' + role;
      var avatar = document.createElement('span');
      avatar.className = 'ai-avatar' + (role === 'assistant' ? ' ai-avatar--bot' : '');
      avatar.setAttribute('role', 'img');
      avatar.setAttribute('aria-label', avatarLabel);
      avatar.textContent = avatarText;
      var content = document.createElement('div');
      content.className = 'ai-msg__content';
      var bubble = document.createElement('div');
      bubble.className = 'ai-bubble ai-bubble--' + role;
      content.appendChild(bubble);
      article.appendChild(avatar);
      article.appendChild(content);
      return { article: article, bubble: bubble };
    }

    function resetChat() {
      var list = $('#aiLog');
      if (!list) return;
      list.innerHTML = '';
      var welcome = document.createElement('div');
      welcome.className = 'ai-welcome';
      var strong = document.createElement('strong');
      strong.textContent = T.shell.welcomeTitle;
      var span = document.createElement('span');
      span.textContent = T.shell.welcomeBody;
      welcome.appendChild(strong);
      welcome.appendChild(span);
      list.appendChild(welcome);
    }

    function send() {
      var input = $('#aiInput');
      var list = $('#aiLog');
      var sendBtn = $('#aiSend');
      if (!input || !list || busy) return;

      var text = input.value.trim() || T.shell.sample;
      input.value = '';
      busy = true;
      input.disabled = true;
      if (sendBtn) sendBtn.disabled = true;

      var welcome = $('.ai-welcome', list);
      if (welcome) welcome.parentNode.removeChild(welcome);

      var thread = chatThread();
      if (!thread) return;

      var me = messageEl('user', '👤', T.shell.you);
      var meBody = document.createElement('div');
      meBody.className = 'ai-body';
      meBody.textContent = text;
      me.bubble.appendChild(meBody);
      thread.appendChild(me.article);

      var bot = messageEl('assistant', '✦', T.shell.ai);
      var pending = document.createElement('div');
      pending.className = 'ai-pending';
      pending.innerHTML = '<i></i><i></i><i></i>';
      var pendingText = document.createElement('span');
      pendingText.textContent = T.shell.thinking;
      pending.appendChild(pendingText);
      bot.bubble.appendChild(pending);
      thread.appendChild(bot.article);
      list.scrollTop = list.scrollHeight;

      setTimeout(function () {
        if (pending.parentNode) pending.parentNode.removeChild(pending);
        T.shell.tools.forEach(function (name) {
          var card = document.createElement('details');
          card.className = 'tool-card';
          card.innerHTML = '<summary><span class="tool-label"><span class="tool-icon">⚙</span>' +
            '<span class="tool-name"></span></span><span class="tool-badge running"></span>' +
            '<span class="chevron">▾</span></summary>';
          $('.tool-name', card).textContent = name;
          $('.tool-badge', card).textContent = T.shell.thinking;
          bot.bubble.appendChild(card);
        });
        var answer = document.createElement('div');
        answer.className = 'ai-body';
        answer.textContent = T.shell.answer;
        bot.bubble.appendChild(answer);

        // 工具卡从「运行中」翻成「已完成」，像真的跑完一样
        $$('.tool-badge.running', bot.bubble).forEach(function (badge) {
          badge.classList.remove('running');
          badge.classList.add('completed');
          badge.textContent = T.shell.done;
        });

        list.scrollTop = list.scrollHeight;
        busy = false;
        input.disabled = false;
        if (sendBtn) sendBtn.disabled = false;
        input.focus();
      }, reduceMotion.matches ? 80 : 1100);
    }

    var sendBtn = $('#aiSend');
    var aiInput = $('#aiInput');
    var aiForm = $('#aiForm');
    if (aiForm) {
      aiForm.addEventListener('submit', function (e) {
        e.preventDefault();
        send();
      });
    }
    if (sendBtn) sendBtn.addEventListener('click', send);
    if (aiInput) {
      aiInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          send();
        }
      });
    }
  }

  /* ── 标签栏：点标签跳到章节，滚动时反过来同步高亮 ────────────────────── */
  function initTabs() {
    var tabs = $$('.tabbar .tab');
    if (!tabs.length) return;

    var pairs = [];
    tabs.forEach(function (a) {
      var sec = document.getElementById(a.getAttribute('data-tab'));
      if (sec) pairs.push({ tab: a, sec: sec });
    });
    if (!pairs.length) return;

    var active = -1;
    var aiActive = false;
    var aiTab = null;

    function paint(i) {
      if (aiActive) return;
      if (i === active) return;
      active = i;
      pairs.forEach(function (p, k) {
        p.tab.classList.toggle('tab--active', k === i);
        if (k === i) p.tab.setAttribute('aria-current', 'true');
        else p.tab.removeAttribute('aria-current');
      });
    }

    function offset() {
      var cs = getComputedStyle(document.documentElement);
      var head = parseInt(cs.getPropertyValue('--h-title'), 10) || 34;
      var bar = parseInt(cs.getPropertyValue('--h-tab'), 10) || 36;
      return head + bar + 24;
    }

    function sync() {
      var line = offset();
      var pick = 0;
      pairs.forEach(function (p, k) {
        if (p.sec.getBoundingClientRect().top <= line) pick = k;
      });
      var atEnd = window.innerHeight + window.pageYOffset >=
        document.documentElement.scrollHeight - 4;
      paint(atEnd ? pairs.length - 1 : pick);
    }

    // AI 面板在真实软件里就是占住编辑区的一个标签：打开时往标签栏插一个 AI 标签，
    // 关掉就移除、高亮回到原来那篇文稿。这样「点进去」之后永远有路回来。
    setAiTab = function (on) {
      var bar = $('.tabbar');
      if (!bar) return;
      if (on) {
        if (!aiTab) {
          aiTab = document.createElement('a');
          aiTab.className = 'tab tab--ai tab--active';
          aiTab.href = '#aiPanel';
          aiTab.setAttribute('data-tab-ai', '');
          aiTab.innerHTML = '<svg class="tab__ico" aria-hidden="true"><use href="#i-chat"/></svg>' +
            T.shell.ai +
            '<span class="tab__x" role="button" tabindex="-1" aria-label="' + T.shell.aiClose +
            '" data-close><svg aria-hidden="true"><use href="#i-close"/></svg></span>';
          var outline = $('.tabbar__outline-btn', bar);
          bar.insertBefore(aiTab, outline || null);
        }
        aiActive = true;
        aiTab.classList.add('tab--active');
        pairs.forEach(function (p) {
          p.tab.classList.remove('tab--active');
          p.tab.removeAttribute('aria-current');
        });
        active = -1;
      } else {
        aiActive = false;
        if (aiTab && aiTab.parentNode) aiTab.parentNode.removeChild(aiTab);
        aiTab = null;
        active = -1;
        sync();
      }
    };

    // 只有三个章节，滚动时直接量一次位置比等 rAF 更省事，也不会漏掉最后一次
    window.addEventListener('scroll', sync, { passive: true });
    window.addEventListener('resize', sync);

    sync();
  }

  /* ── 启动 ───────────────────────────────────────────────────────────── */
  function boot() {
    initReveal();
    initTheme();
    initAnatomy();
    initDemo();
    initMindMap();
    initDiagram();
    initSaveAs();
    initVersionNote();
    initPanels();
    initDrawer();
    initShell();
    initTabs();
    initTracking();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
