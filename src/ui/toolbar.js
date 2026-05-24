// toolbar.js
// Builds the Tiptap formatting toolbar and wires it to an editor instance.
// Returns { element, update, destroy }.

import { TEXT_COLORS, HIGHLIGHT_COLORS } from './color-picker.js';

const ICONS = {
  bold: '<path d="M7 4h6a3.5 3.5 0 0 1 0 7H7zM7 11h7a3.5 3.5 0 0 1 0 7H7z"/>',
  italic: '<path d="M10 4h7M7 18h7M14 4l-4 14" stroke-linecap="round"/>',
  underline: '<path d="M7 4v6a5 5 0 0 0 10 0V4M5 20h14" stroke-linecap="round"/>',
  strike: '<path d="M5 12h14M8 8a4 3 0 0 1 8 0M8 16a4 3 0 0 0 8 0" stroke-linecap="round"/>',
  bullet: '<path d="M9 6h11M9 12h11M9 18h11" stroke-linecap="round"/><circle cx="4.5" cy="6" r="1.4"/><circle cx="4.5" cy="12" r="1.4"/><circle cx="4.5" cy="18" r="1.4"/>',
  ordered: '<path d="M10 6h10M10 12h10M10 18h10" stroke-linecap="round"/><text x="2.5" y="8" font-size="7" stroke="none" fill="currentColor">1</text><text x="2.5" y="14" font-size="7" stroke="none" fill="currentColor">2</text><text x="2.5" y="20" font-size="7" stroke="none" fill="currentColor">3</text>',
  task: '<rect x="3" y="4" width="7" height="7" rx="1.5"/><path d="M4.5 7.5 6 9l2.5-3" stroke-linecap="round" stroke-linejoin="round"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M13 7h8M13 17h8" stroke-linecap="round"/>',
  link: '<path d="M9 13a4 4 0 0 0 5.66 0l2.5-2.5a4 4 0 0 0-5.66-5.66l-1 1M15 11a4 4 0 0 0-5.66 0l-2.5 2.5a4 4 0 1 0 5.66 5.66l1-1" stroke-linecap="round" stroke-linejoin="round"/>',
  textColor: '<path d="M5 18 9.5 6h1L15 18M6.7 14h6.6" stroke-linecap="round" stroke-linejoin="round"/>',
  highlight: '<path d="M4 19h6M15 4l5 5-8 8H8l-1-3z" stroke-linecap="round" stroke-linejoin="round"/>',
  chevron: '<path d="m6 9 4 4 4-4" stroke-linecap="round" stroke-linejoin="round"/>',
};

function svg(name, extra = '') {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${ICONS[name]}${extra}</svg>`;
}

function makeButton({ icon, title, onClick, html }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sc-tbtn';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.innerHTML = html ?? svg(icon);
  btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep selection
  btn.addEventListener('click', onClick);
  return btn;
}

function sep() {
  const s = document.createElement('span');
  s.className = 'sc-tsep';
  s.setAttribute('aria-hidden', 'true');
  return s;
}

export function createToolbar({ editor }) {
  const bar = document.createElement('div');
  bar.className = 'sc-toolbar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Text formatting');

  const trackers = []; // { el, isActive } -> toggles .is-active
  const openPopovers = [];

  const track = (el, isActive) => trackers.push({ el, isActive });

  // --- inline marks ---------------------------------------------------------
  const bold = makeButton({ icon: 'bold', title: 'Bold (Ctrl+B)', onClick: () => editor.chain().focus().toggleBold().run() });
  track(bold, () => editor.isActive('bold'));
  const italic = makeButton({ icon: 'italic', title: 'Italic (Ctrl+I)', onClick: () => editor.chain().focus().toggleItalic().run() });
  track(italic, () => editor.isActive('italic'));
  const underline = makeButton({ icon: 'underline', title: 'Underline (Ctrl+U)', onClick: () => editor.chain().focus().toggleUnderline().run() });
  track(underline, () => editor.isActive('underline'));
  const strike = makeButton({ icon: 'strike', title: 'Strikethrough', onClick: () => editor.chain().focus().toggleStrike().run() });
  track(strike, () => editor.isActive('strike'));
  bar.append(bold, italic, underline, strike, sep());

  // --- headings -------------------------------------------------------------
  for (const level of [1, 2, 3]) {
    const h = makeButton({
      title: `Heading ${level}`,
      html: `<span class="sc-tbtn-text">H${level}</span>`,
      onClick: () => editor.chain().focus().toggleHeading({ level }).run(),
    });
    track(h, () => editor.isActive('heading', { level }));
    bar.append(h);
  }
  bar.append(sep());

  // --- lists ----------------------------------------------------------------
  const bullet = makeButton({ icon: 'bullet', title: 'Bullet list', onClick: () => editor.chain().focus().toggleBulletList().run() });
  track(bullet, () => editor.isActive('bulletList'));
  const ordered = makeButton({ icon: 'ordered', title: 'Ordered list', onClick: () => editor.chain().focus().toggleOrderedList().run() });
  track(ordered, () => editor.isActive('orderedList'));
  const task = makeButton({ icon: 'task', title: 'Task list', onClick: () => editor.chain().focus().toggleTaskList().run() });
  track(task, () => editor.isActive('taskList'));
  bar.append(bullet, ordered, task, sep());

  // --- link -----------------------------------------------------------------
  const link = makeButton({
    icon: 'link',
    title: 'Link',
    onClick: () => {
      if (editor.isActive('link')) {
        editor.chain().focus().unsetLink().run();
        return;
      }
      const prev = editor.getAttributes('link').href || 'https://';
      const url = window.prompt('Link URL', prev);
      if (url === null) return;
      if (url.trim() === '') {
        editor.chain().focus().unsetLink().run();
        return;
      }
      editor.chain().focus().extendMarkRange('link').setLink({ href: url.trim() }).run();
    },
  });
  track(link, () => editor.isActive('link'));
  bar.append(link, sep());

  // --- text color + highlight popovers -------------------------------------
  const textColor = makeColorPicker({
    title: 'Text color',
    triggerHtml: svg('textColor') + colorBar() + svg('chevron'),
    colors: TEXT_COLORS,
    swatchKind: 'fg',
    onPick: (value) => {
      if (value === null) editor.chain().focus().unsetColor().run();
      else editor.chain().focus().setColor(value).run();
    },
    register: openPopovers,
  });
  bar.append(textColor.element);

  const highlight = makeColorPicker({
    title: 'Highlight',
    triggerHtml: svg('highlight') + svg('chevron'),
    colors: HIGHLIGHT_COLORS,
    swatchKind: 'bg',
    onPick: (value) => {
      if (value === null) editor.chain().focus().unsetHighlight().run();
      else editor.chain().focus().toggleHighlight({ color: value }).run();
    },
    register: openPopovers,
  });
  track(highlight.trigger, () => editor.isActive('highlight'));
  bar.append(highlight.element);

  // --- active-state sync ----------------------------------------------------
  function update() {
    for (const { el, isActive } of trackers) {
      el.classList.toggle('is-active', !!isActive());
    }
  }

  function onDocClick(e) {
    for (const pop of openPopovers) {
      if (!pop.root.contains(e.target)) pop.close();
    }
  }
  document.addEventListener('click', onDocClick);

  function destroy() {
    document.removeEventListener('click', onDocClick);
  }

  update();
  return { element: bar, update, destroy };
}

function colorBar() {
  return '<span class="sc-tbtn-colorbar"></span>';
}

// A trigger button + dropdown grid of swatches.
function makeColorPicker({ title, triggerHtml, colors, swatchKind, onPick, register }) {
  const root = document.createElement('div');
  root.className = 'sc-colormenu';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'sc-tbtn sc-tbtn--menu';
  trigger.title = title;
  trigger.setAttribute('aria-label', title);
  trigger.setAttribute('aria-haspopup', 'true');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.innerHTML = triggerHtml;
  trigger.addEventListener('mousedown', (e) => e.preventDefault());

  const pop = document.createElement('div');
  pop.className = 'sc-colorpop';
  pop.hidden = true;

  for (const c of colors) {
    const s = document.createElement('button');
    s.type = 'button';
    s.className = 'sc-popswatch';
    s.title = c.label;
    s.setAttribute('aria-label', c.label);
    if (c.value === null) {
      s.classList.add('sc-popswatch--none');
      s.textContent = '✕';
    } else if (swatchKind === 'fg') {
      s.style.color = c.value;
      s.textContent = 'A';
    } else {
      s.style.background = c.value;
    }
    s.addEventListener('mousedown', (e) => e.preventDefault());
    s.addEventListener('click', () => {
      onPick(c.value);
      close();
    });
    pop.appendChild(s);
  }

  function open() {
    for (const p of register) if (p.close) p.close();
    pop.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
  }
  function close() {
    pop.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  }
  trigger.addEventListener('click', () => (pop.hidden ? open() : close()));

  root.append(trigger, pop);
  register.push({ root, close });
  return { element: root, trigger, close };
}
