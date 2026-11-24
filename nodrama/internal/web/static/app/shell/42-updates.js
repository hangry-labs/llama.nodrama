"use strict";

function renderUpdateState() {
  setBuildDisplay(state.snapshot?.build);
  for (const render of state.updates.listeners) render();
}

async function checkForUpdates() {
  const updates = state.updates;
  if (updates.phase) return;
  updates.phase = 'checking'; updates.plan = null; updates.token = null; updates.error = '';
  renderUpdateState();
  try {
    if (state.params.demo) throw new Error(t('update.demo'));
    const plan = await fetchJSON('/api/update/check', { withModel: false, timeout: 25000 });
    if (plan.error) throw new Error(plan.error);
    updates.plan = plan;
  } catch (error) { updates.error = error.message; }
  finally { updates.phase = null; renderUpdateState(); }
}

async function installCheckedUpdate() {
  const updates = state.updates, plan = updates.plan;
  if (!plan?.available || !updates.token || updates.phase) return;
  openInstallScreen();
  updates.phase = 'installing'; updates.error = '';
  renderUpdateState();
  try {
    let response;
    try { response = await fetch('/api/update/install', { method: 'POST', signal: AbortSignal.timeout(150000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: plan.version, token: updates.token }) });
    } catch (error) { if (!(error instanceof TypeError) && error.name !== 'TimeoutError' && error.name !== 'AbortError') throw error; }
    if (response && !response.ok) {
      if (response.status === 409) updates.token = null;
      throw new Error(await response.text());
    }
    await response?.body?.cancel();
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

async function downloadCheckedUpdate() {
  const updates = state.updates, plan = updates.plan;
  if (!plan?.available || updates.phase) return;
  updates.phase = 'downloading'; updates.token = null; updates.error = ''; updates.received = 0; updates.total = plan.asset?.bytes || 0;
  renderUpdateState();
  let reader;
  try {
    const response = await fetch('/api/update/download', { method: 'POST', signal: AbortSignal.timeout(150000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({version: plan.version}) });
    if (!response.ok) throw new Error(await response.text());
    reader = response.body.getReader();
    const decoder = new TextDecoder(); let pending = '', ready = false;
    const consume = line => {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (event.error) throw new Error(event.error);
      if (event.status === 'downloading') { updates.received = event.received; updates.total = event.total; }
      if (event.status === 'ready') {
        if (event.version !== plan.version || !event.token) throw new Error(t('update.incomplete'));
        updates.token = event.token; ready = true;
      }
      renderUpdateState();
    };
    while (true) {
      const {value, done} = await reader.read();
      pending += decoder.decode(value, {stream: !done});
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) { consume(pending.slice(0, newline)); pending = pending.slice(newline + 1); }
      if (done) { if (pending.trim()) consume(pending); break; }
    }
    if (!ready) throw new Error(t('update.incomplete'));
  } catch (error) { updates.token = null; updates.error = error.message; }
  finally { await reader?.cancel().catch(() => {}); updates.phase = null; renderUpdateState(); }
}

function openInstallScreen() {
  const updates = state.updates;
  const previous = document.activeElement;
  const status = el('p', {role:'status'}, t('update.installing'));
  const close = el('button', {hidden:true, onclick: () => {
    updates.listeners.delete(render); screen.remove(); previous?.focus();
  }}, t('common.close'));
  const activity = el('progress', {'aria-label':t('update.installing')});
  const screen = el('div', {class:'update-install-screen', role:'dialog', 'aria-modal':'true', 'aria-label':t('update.install_version',{version:updates.plan.version}), tabindex:'-1'}, [
    el('div', {class:'update-install-card'}, [el('h2',null,t('update.install_version',{version:updates.plan.version})), activity, status, el('p',{class:'sub'},t('update.restart_note')),close])
  ]);
  function render() {
    status.textContent = updates.error || t(updates.phase === 'restarting' ? 'update.restarting' : 'update.installing');
    close.hidden = !!updates.phase; activity.hidden = !!updates.error;
  }
  screen.addEventListener('keydown',event=>{
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!updates.phase) close.click(); }
    if (event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); (close.hidden ? screen : close).focus(); }
  });
  updates.listeners.add(render); document.body.appendChild(screen); screen.focus();
}

function openUpdatesModal() {
  const updates = state.updates;
  const status = el('div', { role: 'status', class: 'sub' }, '');
  const check = el('button', { onclick: () => void checkForUpdates() }, '↻ ' + t('update.check'));
  const install = el('button', { class: 'primary', hidden: true, onclick: () => void (updates.token ? installCheckedUpdate() : downloadCheckedUpdate()) });
  const progress = el('progress', {max:100,value:0,hidden:true,'aria-label':t('update.downloading')});
  function render() {
    const plan = updates.plan, phase = updates.phase;
    check.disabled = install.disabled = !!phase;
    install.hidden = !plan?.available;
    install.textContent = t(updates.token ? 'update.install_version' : 'update.download_version', {version:plan?.version || ''});
    progress.hidden = phase !== 'downloading'; progress.value = updates.total ? updates.received / updates.total * 100 : 0;
    status.textContent = phase === 'checking' ? t('common.loading') : phase ? t('update.' + phase)
      : updates.error || (plan ? t('update.latest', { version: plan.version }) + ' · '
        + (plan.available ? t('update.available') : t('update.no_newer')) : t('update.ready'));
    status.classList.toggle('update-result-available', !!plan?.available && !updates.error);
  }
  updates.listeners.add(render);
  showModal({ title: t('update.title'), onClose: () => updates.listeners.delete(render), bodyNode: el('div', { class: 'updates-panel' }, [
    el('p', { class: 'update-current' }, t('update.current', { version: state.snapshot?.build?.version || 'dev' })),
    el('p', { class: 'sub' }, t('update.explain')),
    status, progress, el('div', { class: 'actions' }, [check, install]),
    el('p', { class: 'sub' }, t('update.restart_note')),
  ]) });
  render();
}
