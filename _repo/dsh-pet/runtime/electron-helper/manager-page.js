'use strict';
(() => {
  const api = window.desktopManager,
    get = (id) => document.getElementById(id);
  const cards = new Map(),
    list = get('pets'),
    feedback = get('feedback');
  let state,
    busy = 0,
    feedbackTimer;
  const labels = {
    visible: '桌面显示中',
    disabled: '已关闭',
    fullscreen: '全屏避让中',
    'hidden-all': '暂时收起',
    loading: '正在加载',
  };
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
  }
  function message(text, failed = false) {
    clearTimeout(feedbackTimer);
    feedback.textContent = text;
    feedback.dataset.error = String(failed);
    if (!failed)
      feedbackTimer = setTimeout(() => {
        feedback.textContent = '设置已保存在本机';
      }, 4000);
  }
  async function perform(action, container) {
    busy++;
    const controls = [...container.querySelectorAll('input,button')];
    if (container.matches('button,input')) controls.push(container);
    for (const input of controls) input.disabled = true;
    message('正在保存…');
    try {
      render(await action());
      message('已保存');
    } catch (e) {
      if (state) render(state, true);
      message(e.message || '保存失败，请重试。', true);
    } finally {
      busy--;
      for (const input of controls) input.disabled = false;
      if (state) render(state);
    }
  }
  function makeCard(pet, index) {
    const card = el('article', 'pet-card'),
      preview = el('div', 'pet-preview'),
      video = el('video');
    const placeholder = el('span', 'preview-placeholder', pet.preview ? '正在加载预览' : '暂无预览素材');
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'metadata';
    if (pet.preview) video.src = pet.preview;
    video.addEventListener('loadeddata', () => {
      placeholder.hidden = true;
    });
    video.addEventListener('error', () => {
      placeholder.hidden = false;
      placeholder.textContent = '预览暂不可用';
    });
    const badge = el('span', 'state-badge');
    preview.append(video, placeholder, el('span', 'pet-number', String(index + 1).padStart(2, '0')), badge);
    const body = el('div', 'pet-controls'),
      heading = el('div', 'pet-heading'),
      identity = el('div');
    const title = el('h3', 'pet-name', pet.name),
      caption = el('p', 'pet-caption');
    identity.append(title, caption);
    const toggle = el('input', 'switch');
    toggle.type = 'checkbox';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-label', pet.name + ' 的桌面显示');
    toggle.addEventListener('change', () => void perform(() => api.update(pet.id, { enabled: toggle.checked }), body));
    heading.append(identity, toggle);
    const sizeLine = el('div', 'size-line'),
      label = el('label', '', '显示大小'),
      output = el('output');
    const range = el('input');
    range.type = 'range';
    range.min = '120';
    range.max = '900';
    range.step = '1';
    range.id = 'size-' + index;
    range.setAttribute('aria-label', pet.name + ' 的大小');
    label.htmlFor = range.id;
    output.htmlFor = range.id;
    range.addEventListener('input', () => {
      output.textContent = range.value + ' px';
    });
    range.addEventListener('change', () => void perform(() => api.update(pet.id, { size: Number(range.value) }), body));
    sizeLine.append(label, output);
    const actions = el('div', 'pet-actions'),
      recover = el('button', 'text-button', '↗ 找回位置'),
      reset = el('button', 'text-button', '恢复默认大小');
    recover.type = reset.type = 'button';
    recover.setAttribute('aria-label', '找回 ' + pet.name + ' 的位置');
    reset.setAttribute('aria-label', '恢复 ' + pet.name + ' 的默认大小');
    recover.addEventListener('click', () => void perform(() => api.recover(pet.id), body));
    reset.addEventListener('click', () => void perform(() => api.update(pet.id, { size: 420 }), body));
    actions.append(recover, reset);
    body.append(heading, sizeLine, range, actions);
    card.append(preview, body);
    list.append(card);
    const result = { card, video, title, caption, toggle, range, output, recover, badge };
    cards.set(pet.id, result);
    return result;
  }
  function render(next, force = false) {
    state = next;
    if ([...cards.keys()].join('\0') !== next.pets.map((p) => p.id).join('\0')) {
      for (const c of cards.values()) c.video.pause();
      cards.clear();
      list.replaceChildren();
    }
    if (!next.pets.length && !list.querySelector('.empty'))
      list.append(el('p', 'empty', '还没有桌宠。添加角色配置后，点击刷新即可发现。'));
    next.pets.forEach((pet, index) => {
      const c = cards.get(pet.id) || makeCard(pet, index);
      c.card.dataset.enabled = String(pet.enabled);
      c.title.textContent = pet.name;
      c.toggle.checked = pet.enabled;
      c.toggle.setAttribute('aria-label', pet.name + ' 的桌面显示');
      c.range.setAttribute('aria-label', pet.name + ' 的大小');
      c.caption.textContent = pet.enabled ? '留在桌面，陪你片刻' : '需要时，随时叫它回来';
      c.badge.textContent = !pet.enabled ? '已关闭' : next.hiddenAll ? '暂时收起' : labels[pet.state] || '桌面显示中';
      if (force || document.activeElement !== c.range) {
        c.range.value = String(pet.size);
        c.output.textContent = pet.size + ' px';
      }
      c.recover.disabled = !pet.enabled || busy > 0;
      c.recover.title = pet.enabled ? '回到主屏安全位置' : '请先开启这只桌宠';
      if (pet.preview && c.video.getAttribute('src') !== pet.preview) c.video.src = pet.preview;
      if (pet.enabled && !document.hidden && !next.hiddenAll) c.video.play().catch(() => {});
      else c.video.pause();
    });
    list.setAttribute('aria-busy', 'false');
    get('pet-count').textContent = next.pets.filter((p) => p.enabled).length + ' / ' + next.pets.length;
    get('hide-all').disabled = false;
    get('hide-all').textContent = next.hiddenAll ? '恢复显示' : '全部隐藏';
    get('hide-all').setAttribute('aria-pressed', String(next.hiddenAll));
    for (const radio of document.querySelectorAll('input[name=mode]')) radio.checked = radio.value === next.mode;
    get('hotkey').checked = next.hotkey;
    get('hotkey-label').textContent = next.hotkeyLabel;
    const descriptions = {
      ready: '全屏自动避让已就绪',
      starting: '全屏检测启动中…',
      unsupported: '此系统暂不支持自动检测',
      error: '检测不可用 · 已退回普通窗口层',
    };
    get('probe-state').textContent =
      next.mode === 'smart'
        ? descriptions[next.probe.status] || ''
        : next.mode === 'normal'
          ? '其它窗口可以遮挡桌宠'
          : '全屏时也保持显示';
    const errors = [next.error, next.hotkeyError, next.mode === 'smart' && next.probe.error].filter(Boolean);
    get('service-error').textContent = errors.join(' ');
    get('service-error').hidden = !errors.length;
  }
  get('hide-all').addEventListener('click', () => void perform(() => api.hide(), get('hide-all')));
  get('refresh').addEventListener('click', () => void perform(() => api.refresh(), get('refresh')));
  for (const radio of document.querySelectorAll('input[name=mode]'))
    radio.addEventListener(
      'change',
      () => void perform(() => api.preferences({ mode: radio.value }), get('display-modes')),
    );
  get('hotkey').addEventListener(
    'change',
    () => void perform(() => api.preferences({ hotkey: get('hotkey').checked }), get('hotkey')),
  );
  document.addEventListener('visibilitychange', () => {
    if (state) render(state);
  });
  async function poll() {
    if (!busy && !document.hidden) {
      try {
        render(await api.get());
        if (feedback.textContent === '正在加载设置…') message('设置已保存在本机');
      } catch (e) {
        message('无法读取设置：' + e.message, true);
      }
    }
  }
  if (!api) {
    message('请从桌宠托盘或右键菜单打开设置。', true);
    return;
  }
  void poll();
  setInterval(() => void poll(), 1000);
})();
