// Progressive native-select enhancement. No markup parsing, network, or global
// prototype changes; the original select remains the form/value authority.
const controls = new WeakMap();
const openControls = new WeakMap();
let sequence = 0;
const watchedAttributes = ['disabled', 'required', 'multiple', 'size', 'hidden', 'label', 'value', 'selected', 'name', 'form', 'title', 'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-invalid', 'aria-errormessage', 'data-select-native', 'data-select-variant', 'data-setup-focus', 'data-focus-key'];
const eligible = select => select?.tagName === 'SELECT' && !select.multiple && select.size <= 1 && !select.hasAttribute('data-select-native');
const optionDisabled = option => option.disabled || (option.parentElement?.tagName === 'OPTGROUP' && option.parentElement.disabled);
const optionHidden = option => option.hidden || (option.parentElement?.tagName === 'OPTGROUP' && option.parentElement.hidden);

function element(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function mark(doc, kind) {
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
  const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', kind === 'check' ? 'm5 12 4 4L19 6' : 'm8 10 4 4 4-4'); svg.append(path); return svg;
}
function labelText(node) {
  if (node.nodeType === 3) return node.textContent;
  if (node.nodeType !== 1 || node.matches('select, button, input, textarea, .ds-select, [aria-hidden="true"], [hidden]')) return '';
  return Array.from(node.childNodes).map(labelText).join(' ').replace(/\s+/g, ' ').trim();
}
function forwardProperty(target, name, changed) {
  const own = Object.getOwnPropertyDescriptor(target, name);
  if (own && !own.configurable) throw new Error('Native property cannot be enhanced');
  let owner = target, descriptor = own;
  while (!descriptor && (owner = Object.getPrototypeOf(owner))) descriptor = Object.getOwnPropertyDescriptor(owner, name);
  if (!descriptor?.get || !descriptor?.set) throw new Error('Native property cannot be enhanced');
  Object.defineProperty(target, name, { configurable: true, enumerable: descriptor.enumerable,
    get() { return descriptor.get.call(this); },
    set(value) { descriptor.set.call(this, value); changed(); },
  });
  return () => { if (own) Object.defineProperty(target, name, own); else delete target[name]; };
}

/** Viewport geometry only; also used by the component's focused placement tests. */
export function selectPopupPosition(anchor, viewport, requestedHeight) {
  const gutter = 8, gap = 6, width = Math.min(Math.max(anchor.width, 220), Math.max(0, viewport.width - gutter * 2));
  const left = Math.max(viewport.left + gutter, Math.min(anchor.left, viewport.left + viewport.width - gutter - width));
  const below = Math.max(0, viewport.top + viewport.height - gutter - anchor.bottom - gap);
  const above = Math.max(0, anchor.top - viewport.top - gutter - gap);
  const side = below < Math.min(requestedHeight, 320) && above > below ? 'above' : 'below';
  const maxHeight = Math.min(320, Math.max(0, viewport.height - gutter * 2), side === 'above' ? above : below);
  const height = Math.min(requestedHeight, maxHeight);
  const top = Math.max(viewport.top + gutter, Math.min(side === 'above' ? anchor.top - gap - height : anchor.bottom + gap, viewport.top + viewport.height - gutter - height));
  return { left, top, width, maxHeight, side };
}

export function enhanceSelect(native, { observe = true } = {}) {
  if (controls.has(native)) return controls.get(native);
  const doc = native?.ownerDocument, view = doc?.defaultView;
  if (!eligible(native) || !native.parentNode || !view?.MutationObserver || native.getAttribute('aria-hidden') === 'true') return null;
  const id = `ds-select-${++sequence}`;
  const originalTabIndex = native.getAttribute('tabindex'), originalHidden = native.getAttribute('aria-hidden');
  const wasFocused = doc.activeElement === native;
  const wrapper = element(doc, 'span', 'ds-select');
  const trigger = element(doc, 'button', 'ds-select-trigger'); trigger.type = 'button'; trigger.id = `${id}-trigger`;
  trigger.setAttribute('role', 'combobox'); trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-controls', `${id}-listbox`);
  const value = element(doc, 'span', 'ds-select-value'), indicator = element(doc, 'span', 'ds-select-indicator'); indicator.append(mark(doc, 'chevron'));
  trigger.append(value, indicator);
  const popup = element(doc, 'div', 'ds-select-popup'); popup.id = `${id}-listbox`; popup.hidden = true;
  popup.setAttribute('role', 'listbox'); popup.setAttribute('aria-labelledby', trigger.id);
  const error = element(doc, 'span', 'ds-field-error ds-select-error'); error.id = `${id}-error`; error.hidden = true;
  let disposed = false, opened = false, updating = false, active = -1, invalid = false, form = null, query = '', queriedAt = 0;
  let items = [], signature = '', topLayer = typeof popup.showPopover === 'function';
  const optionRestorers = new Map(), propertyRestorers = [], removers = [];
  const listen = (target, name, callback, options) => { target.addEventListener(name, callback, options); removers.push(() => target.removeEventListener(name, callback, options)); };
  const selected = () => native.selectedIndex;
  const disabled = () => native.disabled || native.matches(':disabled');
  const copyAttribute = (name, text) => { if (text !== null && text !== undefined && text !== '') trigger.setAttribute(name, String(text)); else trigger.removeAttribute(name); };
  const updateSelection = () => {
    for (const item of items) {
      item.element.setAttribute('aria-selected', String(item.index === selected()));
      item.element.toggleAttribute('data-active', opened && item.index === active);
    }
    copyAttribute('aria-activedescendant', opened ? items.find(item => item.index === active)?.element.id : null);
  };
  const highlight = index => {
    active = index; updateSelection();
    const option = items.find(item => item.index === active)?.element;
    if (option && opened) {
      if (option.offsetTop < popup.scrollTop) popup.scrollTop = option.offsetTop;
      else if (option.offsetTop + option.offsetHeight > popup.scrollTop + popup.clientHeight) popup.scrollTop = option.offsetTop + option.offsetHeight - popup.clientHeight;
    }
  };
  const enabled = () => items.filter(item => !item.disabled);
  const initial = () => enabled().find(item => item.index === selected())?.index ?? enabled()[0]?.index ?? -1;
  const move = key => {
    const choices = enabled(); if (!choices.length) return;
    const index = choices.findIndex(item => item.index === active);
    highlight(choices[key === 'Home' ? 0 : key === 'End' ? choices.length - 1 : key === 'ArrowUp' ? Math.max(0, index < 0 ? choices.length - 1 : index - 1) : Math.min(choices.length - 1, index + 1)].index);
  };
  const viewport = () => ({ left: view.visualViewport?.offsetLeft || 0, top: view.visualViewport?.offsetTop || 0, width: view.visualViewport?.width || view.innerWidth, height: view.visualViewport?.height || view.innerHeight });
  const position = () => {
    if (!opened) return;
    if (!native.isConnected || disabled() || native.hidden) { close(false); return; }
    const anchor = trigger.getBoundingClientRect(), screen = viewport();
    if (anchor.bottom <= screen.top || anchor.top >= screen.top + screen.height || anchor.right <= screen.left || anchor.left >= screen.left + screen.width) { close(false); return; }
    const width = selectPopupPosition(anchor, screen, 320).width;
    popup.style.width = `${width}px`;
    const placement = selectPopupPosition(anchor, screen, popup.scrollHeight + 2);
    let left = placement.left, top = placement.top;
    if (!topLayer) {
      const host = popup.parentElement;
      if (host?.tagName === 'DIALOG') { const bounds = host.getBoundingClientRect(); left -= bounds.left - host.scrollLeft; top -= bounds.top - host.scrollTop; }
      else { left += view.scrollX; top += view.scrollY; }
    }
    popup.style.position = topLayer ? 'fixed' : 'absolute'; popup.style.left = `${left}px`; popup.style.top = `${top}px`; popup.style.maxHeight = `${placement.maxHeight}px`;
    popup.setAttribute('data-side', placement.side);
  };
  const outside = event => { if (!wrapper.contains(event.target) && !popup.contains(event.target)) close(false); };
  const scroll = event => { if (!popup.contains(event.target)) position(); };
  const focusOutside = event => { if (!wrapper.contains(event.target) && !popup.contains(event.target)) close(false); };
  const openListeners = add => {
    const operation = add ? 'addEventListener' : 'removeEventListener';
    doc[operation]('pointerdown', outside, true); doc[operation]('focusin', focusOutside); doc[operation]('scroll', scroll, true);
    view[operation]('resize', position); view.visualViewport?.[operation]('resize', position); view.visualViewport?.[operation]('scroll', position);
  };
  function close(restore = false) {
    if (!opened) return;
    opened = false; query = ''; openListeners(false);
    if (openControls.get(doc) === api) openControls.delete(doc);
    if (topLayer) { try { popup.hidePopover(); } catch {} }
    popup.hidden = true; trigger.setAttribute('aria-expanded', 'false'); updateSelection();
    if (restore && native.isConnected && !disabled()) trigger.focus({ preventScroll: true });
  }
  function open() {
    update(); if (disposed || disabled() || native.hidden || !native.isConnected) return;
    const previous = openControls.get(doc); if (previous && previous !== api) previous.close(false);
    if (opened) return;
    opened = true; active = initial(); query = '';
    const host = native.closest('dialog') || doc.body; if (popup.parentElement !== host) host.append(popup);
    popup.hidden = false;
    if (topLayer) { popup.setAttribute('popover', 'manual'); try { popup.showPopover(); } catch { topLayer = false; popup.removeAttribute('popover'); } }
    openControls.set(doc, api); trigger.setAttribute('aria-expanded', 'true'); position(); updateSelection(); highlight(active); openListeners(true);
  }
  function commit(index, restore = true) {
    const item = items.find(item => item.index === index);
    if (!item || item.disabled || disabled() || native.options[index] !== item.option) { update(); return; }
    const changed = native.selectedIndex !== index;
    close(restore); invalid = false; error.hidden = true; native.selectedIndex = index; update();
    if (!changed) return;
    // Settle DOM/focus first: existing change handlers may synchronously unmount.
    native.dispatchEvent(new view.Event('input', { bubbles: true }));
    native.dispatchEvent(new view.Event('change', { bubbles: true }));
  }
  const typeahead = key => {
    const now = view.performance?.now?.() ?? Date.now();
    query = now - queriedAt < 700 ? query + key : key; queriedAt = now;
    const normalized = text => text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
    const repeated = [...query].every(character => character === query[0]);
    const search = normalized(repeated ? query[0] : query), choices = enabled();
    const start = Math.max(0, choices.findIndex(item => item.index === active) + (repeated ? 1 : 0));
    const ordered = [...choices.slice(start), ...choices.slice(0, start)];
    const match = ordered.find(item => normalized(item.label).startsWith(search)); if (match) highlight(match.index);
  };
  const keydown = event => {
    if (disabled() || event.isComposing) return;
    if (event.key === 'Tab') { if (opened && active >= 0) commit(active, false); else close(false); return; }
    if (event.key === 'Escape') { if (opened) { event.preventDefault(); event.stopPropagation(); close(true); } return; }
    if (event.altKey && event.key === 'ArrowUp') { event.preventDefault(); close(true); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const wasOpen = opened; open(); if (wasOpen || ['Home', 'End'].includes(event.key)) move(event.key); return; }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (opened) commit(active); else open(); return; }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); open(); typeahead(event.key); }
  };
  const changed = () => { invalid = false; error.hidden = true; update(); };
  const reset = () => { close(false); invalid = false; error.hidden = true; queueMicrotask(() => { if (!disposed) update(); }); };
  function update() {
    if (disposed || updating) return;
    if (!eligible(native)) { dispose(); return; }
    updating = true;
    try {
      if (invalid && native.validity?.valid) { invalid = false; error.hidden = true; }
      if (native.form !== form) { form?.removeEventListener('reset', reset); form = native.form; form?.addEventListener('reset', reset); }
      const previousOption = items.find(item => item.index === active)?.option;
      const options = Array.from(native.options);
      for (const [option, restore] of optionRestorers) if (!options.includes(option)) { restore(); optionRestorers.delete(option); }
      for (const option of options) if (!optionRestorers.has(option)) optionRestorers.set(option, forwardProperty(option, 'selected', update));
      const next = options.map((option, index) => ({ option, index, label: option.label || option.text || '', disabled: optionDisabled(option), hidden: optionHidden(option), group: option.parentElement?.tagName === 'OPTGROUP' ? option.parentElement : null }));
      const visibleNext = next.filter(item => !item.hidden);
      const nextSignature = JSON.stringify(visibleNext.map(item => [item.index, item.label, item.disabled, item.group?.label || '', item.group?.disabled || false]));
      if (nextSignature !== signature || visibleNext.length !== items.length || visibleNext.some((item, index) => item.option !== items[index]?.option)) {
        signature = nextSignature; popup.replaceChildren(); items = []; let previousGroup = null, groupContainer = popup;
        for (const item of visibleNext) {
          if (item.group !== previousGroup) {
            previousGroup = item.group; groupContainer = popup;
            if (item.group) { groupContainer = element(doc, 'div', 'ds-select-group'); groupContainer.setAttribute('role', 'group'); groupContainer.setAttribute('aria-label', item.group.label); const label = element(doc, 'div', 'ds-select-group-label', item.group.label); label.setAttribute('aria-hidden', 'true'); groupContainer.append(label); popup.append(groupContainer); }
          }
          const row = element(doc, 'div', 'ds-select-option'); row.id = `${id}-option-${item.index}`;
          row.setAttribute('role', 'option'); row.setAttribute('data-select-index', String(item.index)); row.setAttribute('aria-disabled', String(item.disabled));
          row.append(element(doc, 'span', 'ds-select-option-label', item.label), mark(doc, 'check')); groupContainer.append(row); items.push({ ...item, element: row });
        }
        if (!items.length) popup.append(element(doc, 'p', 'ds-select-empty', 'No options available.'));
      }
      wrapper.hidden = native.hidden; wrapper.setAttribute('data-select-variant', native.getAttribute('data-select-variant') || 'default');
      trigger.disabled = disabled(); trigger.tabIndex = originalTabIndex === null ? 0 : Number(originalTabIndex);
      value.textContent = options[selected()]?.label || options[selected()]?.text || (options.length ? 'Choose an option' : 'No options available');
      trigger.title = native.title;
      if (native.getAttribute('aria-labelledby')) { copyAttribute('aria-labelledby', native.getAttribute('aria-labelledby')); trigger.removeAttribute('aria-label'); }
      else { trigger.removeAttribute('aria-labelledby'); copyAttribute('aria-label', native.getAttribute('aria-label') || Array.from(native.labels || []).map(labelText).filter(Boolean).join(' ') || native.title || 'Choose an option'); }
      copyAttribute('aria-describedby', [native.getAttribute('aria-describedby'), invalid ? error.id : ''].filter(Boolean).join(' '));
      copyAttribute('aria-errormessage', invalid ? error.id : native.getAttribute('aria-errormessage'));
      copyAttribute('aria-invalid', invalid ? 'true' : native.getAttribute('aria-invalid'));
      copyAttribute('aria-required', native.required ? 'true' : null);
      for (const name of ['data-setup-focus', 'data-focus-key']) copyAttribute(name, native.getAttribute(name));
      active = opened ? items.find(item => item.option === previousOption && !item.disabled)?.index ?? initial() : initial();
      updateSelection();
      if (opened) { if (disabled() || native.hidden) close(false); else position(); }
    } finally { updating = false; }
  }
  const mutation = observe ? new view.MutationObserver(() => { if (!native.isConnected) dispose(); else update(); }) : null;
  function dispose() {
    if (disposed) return;
    close(false); disposed = true; mutation?.disconnect(); form?.removeEventListener('reset', reset);
    for (const remove of removers) remove(); for (const restore of [...optionRestorers.values(), ...propertyRestorers].reverse()) restore();
    native.classList.remove('ds-select-native');
    if (originalTabIndex === null) native.removeAttribute('tabindex'); else native.setAttribute('tabindex', originalTabIndex);
    if (originalHidden === null) native.removeAttribute('aria-hidden'); else native.setAttribute('aria-hidden', originalHidden);
    popup.remove();
    if (native.parentNode === wrapper) { if (wrapper.parentNode) wrapper.parentNode.insertBefore(native, wrapper); else native.remove(); }
    wrapper.remove();
    controls.delete(native);
  }
  const api = { native, trigger, popup, wrapper, update, dispose, close };
  try {
    for (const name of ['value', 'selectedIndex', 'disabled', 'required']) propertyRestorers.push(forwardProperty(native, name, update));
    native.parentNode.insertBefore(wrapper, native); wrapper.append(native, trigger, error);
    native.classList.add('ds-select-native'); native.setAttribute('tabindex', '-1'); native.setAttribute('aria-hidden', 'true');
    listen(trigger, 'click', () => { if (opened) close(false); else open(); }); listen(trigger, 'keydown', keydown);
    listen(native, 'focus', () => { if (!disposed && !disabled()) trigger.focus({ preventScroll: true }); });
    listen(native, 'input', changed); listen(native, 'change', changed);
    listen(native, 'invalid', event => { event.preventDefault(); invalid = true; error.textContent = native.validationMessage || 'Choose an option.'; error.hidden = false; update(); trigger.focus({ preventScroll: false }); });
    listen(popup, 'pointerdown', event => { if (event.pointerType === 'mouse') event.preventDefault(); });
    listen(popup, 'pointermove', event => { const option = event.target.closest('[data-select-index]'); if (option && option.getAttribute('aria-disabled') !== 'true') highlight(Number(option.getAttribute('data-select-index'))); });
    listen(popup, 'click', event => { const option = event.target.closest('[data-select-index]'); if (option) commit(Number(option.getAttribute('data-select-index'))); });
    controls.set(native, api); update(); mutation?.observe(native, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: watchedAttributes });
    if (wasFocused && native.isConnected && !disabled()) trigger.focus({ preventScroll: true });
    return api;
  } catch { dispose(); if (wasFocused && native.isConnected) native.focus({ preventScroll: true }); return null; }
}

/** One subtree observer owns all dynamic selects; surface teardown is explicit. */
export function observeSelects(root = document) {
  const doc = root.ownerDocument || root, view = doc.defaultView;
  if (!root?.querySelectorAll || !view?.MutationObserver) return { update() {}, dispose() {} };
  const mounted = new Map(); let disposed = false;
  const update = () => {
    if (disposed) return;
    const found = new Set(root.querySelectorAll('select')); if (root.tagName === 'SELECT') found.add(root);
    for (const [native, control] of mounted) if (!found.has(native) || !native.isConnected || !eligible(native) || controls.get(native) !== control || native.parentNode !== control.wrapper) { control.dispose(); mounted.delete(native); }
    for (const native of found) if (native.isConnected && eligible(native)) {
      if (!mounted.has(native)) { const control = enhanceSelect(native, { observe: false }); if (control) mounted.set(native, control); }
      else mounted.get(native).update();
    }
  };
  const relevant = node => node?.nodeType === 1 && (node.tagName === 'SELECT' || node.closest?.('select') || node.querySelector?.('select'));
  const observer = new view.MutationObserver(records => {
    if (records.some(record => record.type === 'attributes' ? relevant(record.target) && !record.target.classList.contains('ds-select') : record.type === 'characterData' ? relevant(record.target.parentElement) : relevant(record.target) && record.target.tagName === 'SELECT' || [...record.addedNodes, ...record.removedNodes].some(relevant))) update();
  });
  update(); observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true, attributeFilter: watchedAttributes });
  return { update, dispose() { if (disposed) return; disposed = true; observer.disconnect(); for (const control of mounted.values()) control.dispose(); mounted.clear(); } };
}
