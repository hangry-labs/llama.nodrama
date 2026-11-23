"use strict";

function openUpdatesModal() {
  let plan = null, busy = false;
  const channel = el('select', { 'aria-label': t('update.channel') }, [
    el('option', { value: 'stable' }, t('update.stable')),
    el('option', { value: 'preview' }, t('update.preview')),
  ]);
  channel.value = /SNAPSHOT/i.test(state.snapshot?.build?.version || '') ? 'preview' : 'stable';
  const status = el('div', { role: 'status', class: 'sub' }, '');
  const check = el('button', { onclick: () => void load() }, t('update.check'));
  const install = el('button', { class: 'primary', disabled: true, onclick: async () => {
    if (!plan || busy) return;
    busy = true; check.disabled = install.disabled = channel.disabled = true;
    status.textContent = t('update.installing');
    try {
      await fetchJSON('/api/update/install', { method: 'POST', withModel: false, timeout: 150000,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: plan.channel, version: plan.version, commit: plan.commit || '' }) });
      status.textContent = t('update.restarting');
      for (let i = 0; i < 30; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        try {
          const health = await fetchJSON('/api/health', { withModel: false, timeout: 1000 });
          if (plan.commit ? health.build?.commit === plan.commit : health.build?.version === plan.version) { location.reload(); return; }
        } catch (_) {}
      }
      throw new Error(t('update.restart_manual'));
    } catch (error) { status.textContent = error.message; }
    finally { busy = false; check.disabled = channel.disabled = false; }
  } }, t('update.install'));
  async function load() {
    if (busy) return;
    busy = true; check.disabled = install.disabled = channel.disabled = true;
    status.textContent = t('common.loading'); plan = null;
    try {
      if (state.params.demo) throw new Error(t('update.demo'));
      plan = await fetchJSON('/api/update/check?channel=' + channel.value, { withModel: false, timeout: 25000 });
      if (plan.error) throw new Error(plan.error);
      status.textContent = plan.version + (plan.commit ? ' · ' + plan.commit.slice(0, 8) : '') + ' · '
        + (plan.available ? t('update.available') : t('update.no_newer'));
      install.disabled = !plan.available;
    } catch (error) { status.textContent = error.message; }
    finally { busy = false; check.disabled = channel.disabled = false; }
  }
  channel.addEventListener('change', () => void load());
  showModal({ title: t('update.title'), bodyNode: el('div', { class: 'updates-panel' }, [
    el('label', null, [t('update.channel'), channel]),
    el('p', { class: 'sub' }, t('update.explain')),
    status, el('div', { class: 'actions' }, [check, install]),
    el('p', { class: 'sub' }, t('update.restart_note')),
  ]) });
  void load();
}
