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

  /* ── 启动 ───────────────────────────────────────────────────────────── */
  function boot() {
    initReveal();
    initTheme();
    initAnatomy();
    initDemo();
    initSaveAs();
    initVersionNote();
    initPanels();
    initDrawer();
    initTracking();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
