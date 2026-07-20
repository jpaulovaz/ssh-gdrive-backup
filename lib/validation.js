const path = require('path');

const BACKUP_ACCESS_MODES = new Set(['standard', 'ignore-unreadable', 'sudo']);

function validationError(message) {
    const error = new Error(message);
    error.statusCode = 400;
    return error;
}

function cleanText(value, label, options = {}) {
    const text = String(value ?? '').trim();
    const min = options.min ?? 1;
    const max = options.max ?? 255;
    if (text.length < min || text.length > max) {
        throw validationError(`${label} deve ter entre ${min} e ${max} caracteres.`);
    }
    if (/\0|[\r\n]/.test(text)) {
        throw validationError(`${label} contém caracteres inválidos.`);
    }
    return text;
}

function optionalText(value, label, max = 2048) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    return cleanText(text, label, { min: 1, max });
}

function integerInRange(value, label, min, max) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) {
        throw validationError(`${label} deve ser um número inteiro entre ${min} e ${max}.`);
    }
    return number;
}

function validateIdentifier(value, label) {
    const text = cleanText(value, label, { min: 1, max: 80 });
    if (!/^[\p{L}\p{N}._ -]+$/u.test(text)) {
        throw validationError(`${label} aceita apenas letras, números, espaço, ponto, hífen e sublinhado.`);
    }
    return text;
}

function validateHost(value) {
    const text = cleanText(value, 'Host', { min: 1, max: 255 });
    if (!/^[A-Za-z0-9._:\-\[\]]+$/.test(text)) {
        throw validationError('Host inválido.');
    }
    return text;
}

function validateRemotePath(value) {
    const text = cleanText(value, 'Caminho remoto', { min: 1, max: 2048 });
    if (!text.startsWith('/')) throw validationError('O caminho remoto deve ser absoluto e começar com /.');
    const normalized = path.posix.normalize(text);
    if (normalized === '/') throw validationError('O diretório raiz / não pode ser usado diretamente como origem do backup.');
    return normalized;
}

function normalizeBackupAccessMode(value) {
    const mode = String(value || 'standard').trim();
    return BACKUP_ACCESS_MODES.has(mode) ? mode : 'standard';
}

function validateBackupAccessMode(value) {
    const mode = String(value || 'standard').trim();
    if (!BACKUP_ACCESS_MODES.has(mode)) {
        throw validationError('Modo de acesso do backup inválido.');
    }
    return mode;
}

function validateCallbackUrl(value) {
    const raw = cleanText(value, 'Callback URL', { min: 10, max: 2048 });
    let url;
    try {
        url = new URL(raw);
    } catch (_) {
        throw validationError('Callback URL inválida.');
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw validationError('Callback URL deve usar http ou https.');
    }
    if (url.username || url.password || url.search || url.hash) {
        throw validationError('Callback URL não pode conter credenciais, parâmetros ou fragmentos.');
    }
    if (url.pathname !== '/oauth2callback') {
        throw validationError('Callback URL deve terminar em /oauth2callback.');
    }
    return url.toString().replace(/\/$/, '');
}

function normalizeSettings(input, currentSettings = null) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw validationError('Configurações inválidas.');
    }

    const current = currentSettings || {
        google: {},
        servers: [],
        system: {},
        schedule: {}
    };

    const googleInput = input.google || {};
    const systemInput = input.system || {};
    const scheduleInput = input.schedule || {};
    const serverInput = Array.isArray(input.servers) ? input.servers : [];

    const callbackUrl = validateCallbackUrl(
        systemInput.authCallbackUrl || current.system.authCallbackUrl || 'http://localhost:3000/oauth2callback'
    );

    const scheduleTime = cleanText(scheduleInput.time || '00:00', 'Horário', { min: 5, max: 5 });
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(scheduleTime)) {
        throw validationError('Horário inválido. Use o formato HH:MM.');
    }

    const daysRaw = Array.isArray(scheduleInput.days) ? scheduleInput.days : [];
    const days = [...new Set(daysRaw.map(day => integerInRange(day, 'Dia da semana', 0, 6)))].sort((a, b) => a - b);
    if (Boolean(scheduleInput.enabled) && days.length === 0) {
        throw validationError('Selecione ao menos um dia para o agendamento ativo.');
    }

    const currentServers = new Map((current.servers || []).map(server => [server.id, server]));
    const seenServerIds = new Set();
    const servers = serverInput.map((server, serverIndex) => {
        if (!server || typeof server !== 'object') throw validationError(`Servidor ${serverIndex + 1} inválido.`);
        const id = validateIdentifier(server.id, 'Identificador do servidor');
        if (seenServerIds.has(id)) throw validationError(`O identificador de servidor "${id}" está duplicado.`);
        seenServerIds.add(id);

        const existing = currentServers.get(id);
        const backupsRaw = Array.isArray(server.backups) ? server.backups : [];
        if (backupsRaw.length === 0) throw validationError(`O servidor "${id}" precisa ter ao menos uma pasta de backup.`);
        const seenBackupNames = new Set();
        const backups = backupsRaw.map((backup, backupIndex) => {
            if (!backup || typeof backup !== 'object') throw validationError(`Pasta ${backupIndex + 1} do servidor "${id}" inválida.`);
            const name = validateIdentifier(backup.name, 'Nome da pasta');
            if (seenBackupNames.has(name)) throw validationError(`A pasta "${name}" está duplicada no servidor "${id}".`);
            seenBackupNames.add(name);
            return {
                name,
                remotePath: validateRemotePath(backup.remotePath),
                accessMode: validateBackupAccessMode(backup.accessMode)
            };
        });

        const passwordInput = String(server.password || '');
        if (!existing && !passwordInput) throw validationError(`Informe a senha SSH do novo servidor "${id}".`);
        if (passwordInput.length > 1000) throw validationError(`A senha SSH do servidor "${id}" é muito longa.`);
        const password = passwordInput || existing?.password || '';

        const sudoUsesSshPassword = server.sudoUsesSshPassword !== false;
        const sudoPasswordInput = String(server.sudoPassword || '');
        if (sudoPasswordInput.length > 1000) throw validationError(`A senha sudo do servidor "${id}" é muito longa.`);
        if (/\0|[\r\n]/.test(sudoPasswordInput)) {
            throw validationError(`A senha sudo do servidor "${id}" não pode conter quebra de linha ou caractere nulo.`);
        }
        const sudoPassword = sudoPasswordInput || existing?.sudoPassword || '';
        const requiresSudo = backups.some(backup => backup.accessMode === 'sudo');
        const effectiveSudoPassword = sudoUsesSshPassword ? password : sudoPassword;
        if (requiresSudo && !effectiveSudoPassword) {
            throw validationError(`Configure a senha sudo do servidor "${id}" ou marque a opção para reutilizar a senha SSH.`);
        }
        if (requiresSudo && /\0|[\r\n]/.test(effectiveSudoPassword)) {
            throw validationError(`A senha usada pelo sudo no servidor "${id}" não pode conter quebra de linha ou caractere nulo.`);
        }

        return {
            id,
            host: validateHost(server.host),
            port: integerInRange(server.port || 22, 'Porta SSH', 1, 65535),
            username: cleanText(server.username, 'Usuário SSH', { min: 1, max: 255 }),
            password,
            sudoUsesSshPassword,
            sudoPassword,
            backups
        };
    });

    const clientSecretInput = String(googleInput.clientSecret || '');
    if (clientSecretInput.length > 5000) throw validationError('Client Secret muito longo.');

    return {
        google: {
            clientId: optionalText(googleInput.clientId, 'Client ID', 5000),
            clientSecret: clientSecretInput || current.google.clientSecret || '',
            refreshToken: current.google.refreshToken || '',
            baseFolderId: optionalText(googleInput.baseFolderId, 'Base Folder ID', 500)
        },
        servers,
        system: {
            port: integerInRange(current.system.port || systemInput.port || 8990, 'Porta da aplicação', 1, 65535),
            retentionLimit: integerInRange(systemInput.retentionLimit ?? 2, 'Retenção', 1, 10000),
            backupTimeout: integerInRange(systemInput.backupTimeout ?? 60, 'Timeout', 1, 1440),
            authCallbackUrl: callbackUrl
        },
        schedule: {
            enabled: Boolean(scheduleInput.enabled),
            time: scheduleTime,
            days
        }
    };
}

module.exports = {
    BACKUP_ACCESS_MODES,
    normalizeSettings,
    normalizeBackupAccessMode,
    validateBackupAccessMode,
    validateIdentifier,
    validateRemotePath,
    validateCallbackUrl,
    validationError
};
