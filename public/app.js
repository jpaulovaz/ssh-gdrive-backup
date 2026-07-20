'use strict';

const state = {
    csrfToken: '',
    username: '',
    settings: null,
    editingServerId: null,
    pollTimer: null,
    toastTimer: null
};

const days = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const backupAccessModeLabels = {
    standard: 'Normal',
    'ignore-unreadable': 'Ignorar sem permissão',
    sudo: 'sudo sem senha'
};
const byId = id => document.getElementById(id);
const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function setVisible(id, visible) {
    byId(id).classList.toggle('hidden', !visible);
}

function showError(id, message) {
    const element = byId(id);
    element.textContent = message || '';
    element.classList.toggle('hidden', !message);
}

function showToast(message, type = 'success') {
    const toast = byId('toast');
    toast.textContent = message;
    toast.classList.toggle('error', type === 'error');
    toast.classList.remove('hidden');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => toast.classList.add('hidden'), 4000);
}

async function api(url, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const headers = new Headers(options.headers || {});
    headers.set('Accept', 'application/json');
    if (unsafeMethods.has(method) && state.csrfToken) headers.set('X-CSRF-Token', state.csrfToken);

    let body = options.body;
    if (body && typeof body !== 'string' && !(body instanceof FormData)) {
        headers.set('Content-Type', 'application/json');
        body = JSON.stringify(body);
    }

    const response = await fetch(url, { ...options, method, headers, body, credentials: 'same-origin' });
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : null;
    if (!response.ok) {
        if (response.status === 401 && !['/api/login', '/api/bootstrap/setup'].includes(url)) {
            showLogin();
        }
        const error = new Error(payload?.error || `Falha HTTP ${response.status}`);
        error.status = response.status;
        throw error;
    }
    return payload;
}

function showSetup() {
    stopPolling();
    setVisible('setupView', true);
    setVisible('loginView', false);
    setVisible('appView', false);
}

function showLogin() {
    stopPolling();
    const dialog = byId('serverDialog');
    if (dialog?.open) dialog.close();
    state.csrfToken = '';
    state.username = '';
    setVisible('setupView', false);
    setVisible('loginView', true);
    setVisible('appView', false);
    byId('loginPassword').value = '';
}

async function showApplication(session) {
    state.csrfToken = session.csrfToken;
    state.username = session.username;
    byId('currentUsername').textContent = session.username;
    setVisible('setupView', false);
    setVisible('loginView', false);
    setVisible('appView', true);
    await loadSettings();
    await refreshDashboard();
    startPolling();
}

async function bootstrap() {
    try {
        const bootstrapStatus = await api('/api/bootstrap/status');
        if (bootstrapStatus.needsSetup) return showSetup();
        const session = await api('/api/session');
        if (!session.authenticated) return showLogin();
        await showApplication(session);
    } catch (error) {
        showToast(error.message, 'error');
        showLogin();
    }
}

async function loadSettings() {
    state.settings = await api('/api/settings');
    fillSettingsForm();
    renderServersList();
}

async function refreshDashboard(forceGoogle = false) {
    if (!state.csrfToken) return;
    try {
        const [status, history, googleStatus] = await Promise.all([
            api('/api/status'),
            api('/api/history'),
            api(`/api/google/status${forceGoogle ? '?refresh=1' : ''}`)
        ]);
        renderDashboard(status, history);
        renderGoogleStatus(googleStatus);
    } catch (error) {
        if (error.status !== 401) showToast(error.message, 'error');
    }
}

function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(() => {
        if (!document.hidden && !byId('appView').classList.contains('hidden')) refreshDashboard();
    }, 5000);
}

function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
}

function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}

function formatDate(value) {
    if (!value) return 'Sem backup';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Data inválida' : date.toLocaleString('pt-BR');
}

function formatBytes(value) {
    const size = Number(value || 0);
    if (!size) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
    return `${(size / (1024 ** index)).toFixed(index ? 2 : 0)} ${units[index]}`;
}

function renderGoogleStatus(status) {
    const main = byId('googleStatus');
    const detail = byId('googleStatusDetail');
    const badge = byId('googleConnectionBadge');
    let label = 'Não configurado';
    let level = 'bad';

    if (status.configured && !status.connected) {
        label = 'Falha de conexão';
        level = 'warn';
    } else if (status.connected && status.baseFolderStatus === 'validated') {
        label = 'Conectado e validado';
        level = 'good';
    } else if (status.connected) {
        label = status.baseFolderStatus === 'invalid' ? 'Conectado; pasta inválida' : 'Google conectado';
        level = 'warn';
    }

    const detailParts = [];
    if (status.connected && status.emailAddress) detailParts.push(status.emailAddress);
    if (status.baseFolderStatus !== 'validated' && (status.baseFolderMessage || status.message)) {
        detailParts.push(status.baseFolderMessage || status.message);
    } else if (!status.connected && status.message) {
        detailParts.push(status.message);
    }

    main.textContent = label;
    main.className = `status ${level}`;
    detail.textContent = detailParts.join(' · ');
    badge.textContent = label;
    badge.className = `badge ${level}`;
    byId('googleDisconnectButton').disabled = !status.configured;
}

function renderDashboard(status, history) {
    byId('statServers').textContent = String(status.servers.length);
    byId('statFolders').textContent = String(status.servers.reduce((total, server) => total + server.folders.length, 0));
    byId('statNext').textContent = status.nextBackup ? formatDate(status.nextBackup) : 'Desativado';

    const container = byId('dashboardServers');
    container.replaceChildren();
    if (!status.servers.length) {
        container.append(createElement('div', 'empty', 'Nenhum servidor cadastrado.'));
    }

    for (const server of status.servers) {
        const card = createElement('article', 'server-card');
        const header = createElement('div', 'server-card-header');
        const titleBlock = createElement('div');
        titleBlock.append(createElement('h2', '', server.id), createElement('p', '', server.host));
        header.append(titleBlock);
        card.append(header);
        const list = createElement('div', 'backup-list');

        for (const folder of server.folders) {
            const backupCard = createElement('div', 'backup-card');
            const details = createElement('div');
            details.append(
                createElement('h3', '', folder.name),
                createElement('p', '', `Último backup: ${formatDate(folder.lastBackup)}`),
                createElement('p', 'progress', folder.status.status || 'Aguardando')
            );
            if (folder.status.warning || folder.lastWarning) {
                details.append(createElement('p', 'warning', folder.status.warning || folder.lastWarning));
            }
            const button = createElement('button', 'button primary compact', folder.status.running ? 'Executando' : 'Executar');
            button.type = 'button';
            button.disabled = Boolean(folder.status.running);
            button.addEventListener('click', () => triggerBackup(server.id, folder.name));
            backupCard.append(details, button);
            list.append(backupCard);
        }
        card.append(list);
        container.append(card);
    }

    const historyList = byId('historyList');
    historyList.replaceChildren();
    if (!history.length) {
        historyList.append(createElement('div', 'empty', 'Nenhuma atividade registrada.'));
        return;
    }
    for (const entry of history) {
        const level = !entry.success ? 'bad' : entry.warning ? 'warn' : 'good';
        const item = createElement('article', `history-entry ${level}`);
        item.append(
            createElement('strong', '', entry.success ? entry.warning ? 'SUCESSO COM ALERTA' : 'SUCESSO' : 'FALHA'),
            createElement('span', '', `${entry.server} > ${entry.folder}`),
            createElement('small', '', `${formatDate(entry.timestamp)}${entry.size ? ` · ${formatBytes(entry.size)}` : ''}`)
        );
        if (entry.warning) item.append(createElement('small', 'warning', entry.warning));
        if (entry.error) item.append(createElement('small', 'error', entry.error));
        historyList.append(item);
    }
}

function renderServersList() {
    const container = byId('serversList');
    container.replaceChildren();
    const servers = state.settings?.servers || [];
    if (!servers.length) {
        container.append(createElement('div', 'empty', 'Nenhum servidor cadastrado.'));
        return;
    }

    for (const server of servers) {
        const card = createElement('article', 'server-card');
        const header = createElement('div', 'server-card-header');
        const titleBlock = createElement('div');
        titleBlock.append(
            createElement('h2', '', server.id),
            createElement('p', '', `${server.username}@${server.host}:${server.port || 22}`)
        );
        const actions = createElement('div', 'button-row');
        const edit = createElement('button', 'button ghost compact', 'Editar');
        edit.type = 'button';
        edit.addEventListener('click', () => openServerDialog(server.id));
        const remove = createElement('button', 'button danger-outline compact', 'Excluir');
        remove.type = 'button';
        remove.addEventListener('click', () => deleteServer(server.id));
        actions.append(edit, remove);
        header.append(titleBlock, actions);
        card.append(header);
        const tags = createElement('div', 'tags');
        for (const backup of server.backups) {
            const mode = backup.accessMode || 'standard';
            const suffix = mode === 'standard' ? '' : ` · ${backupAccessModeLabels[mode] || mode}`;
            tags.append(createElement('span', 'tag', `${backup.name}${suffix}`));
        }
        card.append(tags);
        container.append(card);
    }
}

function fillSettingsForm() {
    const settings = state.settings;
    byId('setGoogleClientId').value = settings.google.clientId || '';
    byId('setGoogleClientSecret').value = '';
    byId('setGoogleClientSecret').placeholder = settings.google.hasClientSecret ? 'Configurado; deixe em branco para preservar' : 'Informe o Client Secret';
    byId('setGoogleFolderId').value = settings.google.baseFolderId || '';
    byId('setAuthCallback').value = settings.system.authCallbackUrl || 'http://localhost:3000/oauth2callback';
    byId('setScheduleEnabled').checked = Boolean(settings.schedule.enabled);
    byId('setScheduleTime').value = settings.schedule.time || '00:00';
    byId('setRetention').value = String(settings.system.retentionLimit || 2);
    byId('setTimeout').value = String(settings.system.backupTimeout || 60);
    renderDays();
}

function renderDays() {
    const container = byId('daysContainer');
    container.replaceChildren();
    const selected = new Set(state.settings.schedule.days || []);
    days.forEach((label, day) => {
        const button = createElement('button', `day-button${selected.has(day) ? ' active' : ''}`, label);
        button.type = 'button';
        button.setAttribute('aria-pressed', String(selected.has(day)));
        button.addEventListener('click', () => {
            const values = new Set(state.settings.schedule.days || []);
            if (values.has(day)) values.delete(day); else values.add(day);
            state.settings.schedule.days = [...values].sort((a, b) => a - b);
            renderDays();
        });
        container.append(button);
    });
}

function collectSettings() {
    return {
        google: {
            clientId: byId('setGoogleClientId').value.trim(),
            clientSecret: byId('setGoogleClientSecret').value,
            baseFolderId: byId('setGoogleFolderId').value.trim()
        },
        servers: state.settings.servers.map(server => ({
            id: server.id,
            host: server.host,
            port: Number(server.port || 22),
            username: server.username,
            password: server.password || '',
            backups: server.backups.map(backup => ({
                name: backup.name,
                remotePath: backup.remotePath,
                accessMode: backup.accessMode || 'standard'
            }))
        })),
        system: {
            port: state.settings.system.port,
            retentionLimit: Number(byId('setRetention').value),
            backupTimeout: Number(byId('setTimeout').value),
            authCallbackUrl: byId('setAuthCallback').value.trim()
        },
        schedule: {
            enabled: byId('setScheduleEnabled').checked,
            time: byId('setScheduleTime').value,
            days: [...state.settings.schedule.days]
        }
    };
}

async function saveAllSettings(showSuccess = true) {
    const result = await api('/api/settings', { method: 'POST', body: collectSettings() });
    state.settings = result.settings;
    fillSettingsForm();
    renderServersList();
    if (showSuccess) showToast('Configurações salvas.');
    await refreshDashboard(true);
    return result;
}

function addFolderRow(name = '', remotePath = '', accessMode = 'standard') {
    const row = createElement('div', 'folder-row');
    const nameLabel = createElement('label', '', 'Nome');
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.maxLength = 80;
    nameInput.required = true;
    nameInput.value = name;
    nameLabel.append(nameInput);

    const pathLabel = createElement('label', '', 'Caminho remoto');
    const pathInput = document.createElement('input');
    pathInput.type = 'text';
    pathInput.required = true;
    pathInput.value = remotePath;
    pathLabel.append(pathInput);

    const modeLabel = createElement('label', '', 'Acesso de leitura');
    const modeSelect = document.createElement('select');
    modeSelect.className = 'folder-access-mode';
    [
        ['standard', 'Normal — falhar sem permissão'],
        ['ignore-unreadable', 'Ignorar itens sem permissão'],
        ['sudo', 'sudo sem senha — backup completo']
    ].forEach(([value, label]) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        option.selected = value === (accessMode || 'standard');
        modeSelect.append(option);
    });
    modeLabel.append(modeSelect);

    const remove = createElement('button', 'button danger-outline compact', 'Remover');
    remove.type = 'button';
    remove.addEventListener('click', () => row.remove());
    row.append(nameLabel, pathLabel, modeLabel, remove);
    byId('modalFolders').append(row);
}

function openServerDialog(serverId = null) {
    state.editingServerId = serverId;
    const server = serverId ? state.settings.servers.find(item => item.id === serverId) : null;
    byId('serverDialogTitle').textContent = server ? 'Editar servidor' : 'Novo servidor';
    byId('mServerId').value = server?.id || '';
    byId('mServerId').readOnly = Boolean(server);
    byId('mServerHost').value = server?.host || '';
    byId('mServerPort').value = String(server?.port || 22);
    byId('mServerUser').value = server?.username || '';
    byId('mServerPass').value = '';
    byId('mServerPass').placeholder = server?.hasPassword ? 'Configurada; deixe em branco para preservar' : 'Informe a senha SSH';
    byId('mServerPass').required = !server;
    byId('modalFolders').replaceChildren();
    (server?.backups || [{ name: '', remotePath: '', accessMode: 'standard' }])
        .forEach(backup => addFolderRow(backup.name, backup.remotePath, backup.accessMode || 'standard'));
    showError('serverFormError', '');
    byId('serverDialog').showModal();
}

function closeServerDialog() {
    byId('serverDialog').close();
}

function collectServerFromDialog() {
    const backups = [...byId('modalFolders').querySelectorAll('.folder-row')].map(row => {
        const inputs = row.querySelectorAll('input');
        const accessMode = row.querySelector('.folder-access-mode')?.value || 'standard';
        return {
            name: inputs[0].value.trim(),
            remotePath: inputs[1].value.trim(),
            accessMode
        };
    }).filter(backup => backup.name || backup.remotePath);
    return {
        id: byId('mServerId').value.trim(),
        host: byId('mServerHost').value.trim(),
        port: Number(byId('mServerPort').value),
        username: byId('mServerUser').value.trim(),
        password: byId('mServerPass').value,
        hasPassword: Boolean(state.editingServerId),
        backups
    };
}

async function saveServer(event) {
    event.preventDefault();
    showError('serverFormError', '');
    try {
        const server = collectServerFromDialog();
        if (!server.backups.length) throw new Error('Adicione ao menos uma pasta de backup.');
        const duplicate = state.settings.servers.some(item => item.id === server.id && item.id !== state.editingServerId);
        if (duplicate) throw new Error('Já existe um servidor com esse identificador.');
        if (state.editingServerId) {
            const index = state.settings.servers.findIndex(item => item.id === state.editingServerId);
            state.settings.servers[index] = server;
        } else {
            state.settings.servers.push(server);
        }
        await saveAllSettings(false);
        closeServerDialog();
        showToast('Servidor salvo.');
    } catch (error) {
        showError('serverFormError', error.message);
    }
}

async function deleteServer(serverId) {
    if (!window.confirm(`Excluir o servidor ${serverId}?`)) return;
    const original = state.settings.servers;
    state.settings.servers = original.filter(server => server.id !== serverId);
    try {
        await saveAllSettings(false);
        showToast('Servidor excluído.');
    } catch (error) {
        state.settings.servers = original;
        renderServersList();
        showToast(error.message, 'error');
    }
}

async function triggerBackup(serverId, folderName) {
    try {
        await api(`/api/backup/${encodeURIComponent(serverId)}/${encodeURIComponent(folderName)}`, { method: 'POST' });
        showToast(`Backup de ${folderName} iniciado.`);
        await refreshDashboard();
    } catch (error) {
        showToast(error.message, 'error');
    }
}

async function startGoogleAuth() {
    let popup = null;
    try {
        popup = window.open('about:blank', 'google-backup-auth', 'popup,width=640,height=760');
        if (!popup) throw new Error('O navegador bloqueou a janela de autenticação. Libere pop-ups e tente novamente.');
        popup.document.title = 'Preparando autenticação';
        popup.document.body.textContent = 'Preparando autenticação segura...';
        await saveAllSettings(false);
        const result = await api('/api/google/auth/start', { method: 'POST' });
        popup.location.replace(result.url);
        showToast('Conclua a autorização na janela aberta.');
    } catch (error) {
        if (popup && !popup.closed) popup.close();
        showToast(error.message, 'error');
    }
}

async function disconnectGoogle() {
    if (!window.confirm('Remover a autorização armazenada do Google Drive?')) return;
    try {
        await api('/api/google/token', { method: 'DELETE' });
        await loadSettings();
        await refreshDashboard(true);
        showToast('Google Drive desconectado.');
    } catch (error) {
        showToast(error.message, 'error');
    }
}

function showTab(tabName) {
    document.querySelectorAll('.tab').forEach(button => button.classList.toggle('active', button.dataset.tab === tabName));
    document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.add('hidden'));
    byId(`tab-${tabName}`).classList.remove('hidden');
}

function bindEvents() {
    byId('setupForm').addEventListener('submit', async event => {
        event.preventDefault();
        showError('setupError', '');
        const password = byId('setupPassword').value;
        if (password !== byId('setupPasswordConfirm').value) return showError('setupError', 'As senhas não coincidem.');
        try {
            const result = await api('/api/bootstrap/setup', {
                method: 'POST',
                body: { setupCode: byId('setupCode').value, username: byId('setupUsername').value, password }
            });
            await showApplication(result);
        } catch (error) {
            showError('setupError', error.message);
        }
    });

    byId('loginForm').addEventListener('submit', async event => {
        event.preventDefault();
        showError('loginError', '');
        try {
            const result = await api('/api/login', {
                method: 'POST',
                body: { username: byId('loginUsername').value, password: byId('loginPassword').value }
            });
            await showApplication(result);
        } catch (error) {
            showError('loginError', error.message);
        }
    });

    byId('logoutButton').addEventListener('click', async () => {
        try { await api('/api/logout', { method: 'POST' }); } catch (_) { /* sessão já pode ter expirado */ }
        showLogin();
    });
    document.querySelectorAll('.tab').forEach(button => button.addEventListener('click', () => showTab(button.dataset.tab)));
    byId('refreshButton').addEventListener('click', () => refreshDashboard(true));
    byId('newServerButton').addEventListener('click', () => openServerDialog());
    byId('closeServerDialog').addEventListener('click', closeServerDialog);
    byId('cancelServerButton').addEventListener('click', closeServerDialog);
    byId('addFolderButton').addEventListener('click', () => addFolderRow());
    byId('serverForm').addEventListener('submit', saveServer);
    byId('settingsForm').addEventListener('submit', async event => {
        event.preventDefault();
        try { await saveAllSettings(true); } catch (error) { showToast(error.message, 'error'); }
    });
    byId('googleAuthButton').addEventListener('click', startGoogleAuth);
    byId('googleDisconnectButton').addEventListener('click', disconnectGoogle);
}

bindEvents();
bootstrap();
