"use strict";

function selectedUpdateChannel() {
  return state.updates.channel || (/SNAPSHOT/i.test(state.snapshot?.build?.version || '') ? 'preview' : 'stable');
}

function renderUpdateState() {
  setBuildDisplay(state.snapshot?.build);
  for (const render of state.updates.listeners) render();
}

async function checkForUpdates() {
  const updates = state.updates;
  if (updates.phase) return;
  updates.channel = selectedUpdateChannel();
  updates.phase = 'checking'; updates.plan = null; updates.error = '';
  renderUpdateState();
  try {
    if (state.params.demo) throw new Error(t('update.demo'));
    const plan = await fetchJSON('/api/update/check?channel=' + updates.channel, { withModel: false, timeout: 25000 });
    if (plan.error) throw new Error(plan.error);
    updates.plan = plan;
  } catch (error) { updates.error = error.message; }
  finally { updates.phase = null; renderUpdateState(); }
}

async function installCheckedUpdate() {
  const updates = state.updates, plan = updates.plan;
  if (!plan?.available || updates.phase) return;
  updates.phase = 'installing'; updates.error = '';
  renderUpdateState();
  try {
    await fetchJSON('/api/update/install', { method: 'POST', withModel: false, timeout: 150000,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: plan.channel, version: plan.version, commit: plan.commit || '' }) });
    updates.phase = 'restarting'; renderUpdateState();
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      try {
        const health = await fetchJSON('/api/health', { withModel: false, timeout: 1000 });
        if (plan.commit ? health.build?.commit === plan.commit : health.build?.version === plan.version) { location.reload(); return; }
      } catch (_) {}
    }
    throw new Error(t('update.restart_manual'));
  } catch (error) { updates.error = error.message; }
  finally { updates.phase = null; renderUpdateState(); }
}

function openUpdatesModal(options = {}) {
  const updates = state.updates;
  const channel = el('select', { 'aria-label': t('update.channel') }, [
    el('option', { value: 'stable' }, t('update.stable')),
    el('option', { value: 'preview' }, t('update.preview')),
  ]);
  channel.value = selectedUpdateChannel();
  const status = el('div', { role: 'status', class: 'sub' }, '');
  const check = el('button', { onclick: () => void checkForUpdates() }, '↻ ' + t('update.check'));
  const install = el('button', { class: 'primary', hidden: true, onclick: () => void installCheckedUpdate() }, t('update.install'));
  function render() {
    const plan = updates.plan, phase = updates.phase;
    channel.value = selectedUpdateChannel();
    check.disabled = channel.disabled = install.disabled = !!phase;
    install.hidden = !plan?.available;
    status.textContent = phase === 'checking' ? t('common.loading') : phase ? t('update.' + phase)
      : updates.error || (plan ? t('update.latest', { version: plan.version }) + ' · '
        + (plan.available ? t('update.available') : t('update.no_newer')) : t('update.ready'));
    status.classList.toggle('update-result-available', !!plan?.available && !updates.error);
  }
  channel.addEventListener('change', () => {
    updates.channel = channel.value; updates.plan = null; updates.error = '';
    renderUpdateState();
  });
  updates.listeners.add(render);
  showModal({ title: t('update.title'), onClose: () => updates.listeners.delete(render), bodyNode: el('div', { class: 'updates-panel' }, [
    el('p', { class: 'update-current' }, t('update.current', { version: state.snapshot?.build?.version || 'dev' })),
    el('label', null, [t('update.channel'), channel]),
    el('p', { class: 'sub' }, t('update.explain')),
    status, el('div', { class: 'actions' }, [check, install]),
    el('p', { class: 'sub' }, t('update.restart_note')),
  ]) });
  render();
  if (options.check) void checkForUpdates();
  if (options.install) void installCheckedUpdate();
}
