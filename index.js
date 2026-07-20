const express = require('express');
const cron = require('node-cron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const AtomicJsonStore = require('./lib/atomicJsonStore');
const SecurityManager = require('./lib/securityManager');
const { SettingsStore } = require('./lib/settingsStore');
const { parseCookies, serializeCookie } = require('./lib/cookies');
const { calculateNextRun } = require('./lib/scheduler');
const SSHManager = require('./sshManager');
const DriveManager = require('./driveManager');
const GoogleAuthManager = require('./googleAuthManager');

const APP_ROOT = __dirname;
const SETTINGS_FILE = process.env.SETTINGS_FILE || path.join(APP_ROOT, 'settings.json');
const HISTORY_FILE = process.env.HISTORY_FILE || path.join(APP_ROOT, 'history.json');
const DATA_DIR = process.env.DATA_DIR || path.join(APP_ROOT, 'data');
const TEMP_DIR = process.env.TEMP_DIR || path.join(APP_ROOT, 'temp_backups');
const SESSION_COOKIE = 'ssh_gdrive_session';

const security = new SecurityManager({ dataDir: DATA_DIR });
const settingsStore = new SettingsStore(SETTINGS_FILE, security);
const historyStore = new AtomicJsonStore(HISTORY_FILE, [], { mode: 0o600 });
const backupStatus = new Map();
const runningJobs = new Set();
let cronJob = null;
let googleStatusCache = { expiresAt: 0, value: null };
let googleAuthManager;
let mainPort;

function invalidateGoogleStatus() {
    googleStatusCache = { expiresAt: 0, value: null };
}

function statusKey(serverId, folderName) {
    return `${serverId}:${folderName}`;
}

function isSecureRequest(req) {
    return req.secure || process.env.COOKIE_SECURE === 'true';
}

function setSessionCookie(req, res, session) {
    res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, session.id, {
        maxAge: Math.floor((session.expiresAt - Date.now()) / 1000),
        secure: isSecureRequest(req),
        sameSite: 'Strict',
        httpOnly: true,
        path: '/'
    }));
}

function clearSessionCookie(req, res) {
    res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, '', {
        maxAge: 0,
        expires: new Date(0),
        secure: isSecureRequest(req),
        sameSite: 'Strict',
        httpOnly: true,
        path: '/'
    }));
}

function attachSession(req, _res, next) {
    const cookies = parseCookies(req.headers.cookie);
    req.sessionId = cookies[SESSION_COOKIE] || '';
    req.session = security.getSession(req.sessionId);
    next();
}

function requireAuth(req, res, next) {
    if (!req.session) return res.status(401).json({ error: 'Autenticação necessária.' });
    next();
}

function requireCsrf(req, res, next) {
    const token = String(req.headers['x-csrf-token'] || '');
    if (!req.session || !token || token !== req.session.csrfToken) {
        return res.status(403).json({ error: 'Token de segurança inválido. Atualize a página e tente novamente.' });
    }
    next();
}

async function appendHistory(entry) {
    await historyStore.update(current => {
        const history = Array.isArray(current) ? current : [];
        history.unshift(entry);
        return history.slice(0, 100);
    });
}

async function clearStaleLocalFiles() {
    await fsp.mkdir(TEMP_DIR, { recursive: true });
    const entries = await fsp.readdir(TEMP_DIR);
    for (const entry of entries) {
        await fsp.rm(path.join(TEMP_DIR, entry), { recursive: true, force: true }).catch(() => undefined);
    }
}

async function runBackup(server, backupConfig, source = 'manual') {
    const key = statusKey(server.id, backupConfig.name);
    if (runningJobs.has(key)) {
        const error = new Error('Este backup já está em execução.');
        error.statusCode = 409;
        throw error;
    }

    runningJobs.add(key);
    const startedAt = new Date();
    let localPath = null;
    backupStatus.set(key, {
        status: 'Iniciando...',
        running: true,
        success: null,
        startedAt: startedAt.toISOString()
    });

    try {
        const settings = await settingsStore.getPrivate();
        const ssh = new SSHManager(server);
        const sshResult = await ssh.createRemoteBackup(
            backupConfig.remotePath,
            TEMP_DIR,
            backupConfig.name,
            message => {
                const current = backupStatus.get(key) || {};
                backupStatus.set(key, { ...current, status: message, running: true });
            },
            settings.system.backupTimeout || 60
        );
        localPath = sshResult.localPath;

        const drive = new DriveManager(settings.google);
        const driveResult = await drive.uploadFile(
            sshResult.localPath,
            sshResult.fileName,
            server.id,
            backupConfig.name,
            { size: sshResult.size, sha256: sshResult.sha256, md5: sshResult.md5 },
            message => {
                const current = backupStatus.get(key) || {};
                backupStatus.set(key, { ...current, status: message, running: true });
            },
            settings.system.retentionLimit
        );

        const warnings = [...(sshResult.warnings || []), ...(driveResult.warnings || [])];
        const completedAt = new Date();
        await appendHistory({
            server: server.id,
            folder: backupConfig.name,
            timestamp: completedAt.toISOString(),
            startedAt: startedAt.toISOString(),
            durationMs: completedAt.getTime() - startedAt.getTime(),
            source,
            success: true,
            warning: warnings.length ? warnings.join(' ') : null,
            fileName: sshResult.fileName,
            size: sshResult.size,
            sha256: sshResult.sha256,
            md5: sshResult.md5,
            driveFileId: driveResult.fileId
        });

        backupStatus.set(key, {
            status: warnings.length ? 'Concluído com alerta.' : 'Concluído e validado.',
            running: false,
            success: true,
            warning: warnings.length ? warnings.join(' ') : null,
            startedAt: startedAt.toISOString(),
            completedAt: completedAt.toISOString()
        });
    } catch (error) {
        const completedAt = new Date();
        const detail = error.cleanupWarning ? `${error.message} ${error.cleanupWarning}` : error.message;
        console.error(`[Backup] ${server.id}/${backupConfig.name}: ${detail}`);
        await appendHistory({
            server: server.id,
            folder: backupConfig.name,
            timestamp: completedAt.toISOString(),
            startedAt: startedAt.toISOString(),
            durationMs: completedAt.getTime() - startedAt.getTime(),
            source,
            success: false,
            error: detail
        }).catch(historyError => console.error(`[History] ${historyError.message}`));
        backupStatus.set(key, {
            status: `Erro: ${detail}`,
            running: false,
            success: false,
            startedAt: startedAt.toISOString(),
            completedAt: completedAt.toISOString()
        });
        throw error;
    } finally {
        if (localPath) await fsp.rm(localPath, { force: true }).catch(() => undefined);
        runningJobs.delete(key);
    }
}

async function setupCron() {
    const settings = await settingsStore.getPrivate();
    if (cronJob) {
        cronJob.stop();
        cronJob = null;
    }

    if (!settings.schedule.enabled) {
        console.log('[Cron] Agendamento desativado.');
        return;
    }
    const [hour, minute] = settings.schedule.time.split(':');
    const days = settings.schedule.days.join(',');
    const cronExpression = `${minute} ${hour} * * ${days}`;
    if (!cron.validate(cronExpression)) throw new Error(`Expressão de agendamento inválida: ${cronExpression}`);

    cronJob = cron.schedule(cronExpression, async () => {
        console.log('[Cron] Iniciando rotina agendada.');
        const currentSettings = await settingsStore.getPrivate();
        for (const server of currentSettings.servers) {
            for (const backup of server.backups) {
                try {
                    await runBackup(server, backup, 'schedule');
                } catch (error) {
                    if (error.statusCode !== 409) {
                        console.error(`[Cron] Falha em ${server.id}/${backup.name}: ${error.message}`);
                    }
                }
            }
        }
    });
    console.log(`[Cron] Agendado: ${cronExpression}`);
}

async function getGoogleStatus(force = false) {
    if (!force && googleStatusCache.value && googleStatusCache.expiresAt > Date.now()) {
        return googleStatusCache.value;
    }
    const settings = await settingsStore.getPrivate();
    let value;
    if (!settings.google.clientId || !settings.google.clientSecret || !settings.google.refreshToken) {
        value = { connected: false, configured: false, message: 'Credenciais ou autenticação pendentes.' };
    } else {
        try {
            const drive = new DriveManager(settings.google);
            const result = await drive.testConnection();
            value = { ...result, configured: true, message: 'Conexão validada.' };
        } catch (error) {
            value = { connected: false, configured: true, message: error.message };
        }
    }
    googleStatusCache = { value, expiresAt: Date.now() + 15000 };
    return value;
}

async function createApp() {
    await security.init();
    await settingsStore.init();
    await historyStore.init();
    await clearStaleLocalFiles();

    const initialSettings = await settingsStore.getPrivate();
    mainPort = Number(process.env.PORT || initialSettings.system.port || 8990);

    const app = express();
    app.disable('x-powered-by');
    if (process.env.TRUST_PROXY) {
        const rawTrustProxy = process.env.TRUST_PROXY.trim();
        const trustProxy = /^\d+$/.test(rawTrustProxy)
            ? Number(rawTrustProxy)
            : rawTrustProxy === 'true' ? true : rawTrustProxy;
        app.set('trust proxy', trustProxy);
    }
    app.use(express.json({ limit: '256kb' }));
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
        if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
        next();
    });
    app.use(attachSession);

    app.get('/api/bootstrap/status', async (_req, res, next) => {
        try {
            res.json(await security.getBootstrapStatus());
        } catch (error) { next(error); }
    });

    app.post('/api/bootstrap/setup', async (req, res, next) => {
        const attemptKey = `setup:${req.ip}`;
        try {
            const bootstrapStatus = await security.getBootstrapStatus();
            if (!bootstrapStatus.needsSetup) {
                const error = new Error('A configuração inicial já foi concluída.');
                error.statusCode = 409;
                throw error;
            }
            security.assertAttemptAllowed(attemptKey);
            const username = await security.completeSetup(req.body.setupCode, req.body.username, req.body.password);
            security.clearAttempts(attemptKey);
            const session = security.createSession(username);
            setSessionCookie(req, res, session);
            res.status(201).json({ success: true, username, csrfToken: session.csrfToken });
        } catch (error) {
            if (error.statusCode !== 409 && error.statusCode !== 429) security.recordFailedAttempt(attemptKey);
            next(error);
        }
    });

    app.post('/api/login', async (req, res, next) => {
        try {
            const session = await security.authenticate(req.body.username, req.body.password, req.ip);
            setSessionCookie(req, res, session);
            res.json({ success: true, username: session.username, csrfToken: session.csrfToken });
        } catch (error) { next(error); }
    });

    app.get('/api/session', (req, res) => {
        if (!req.session) return res.json({ authenticated: false });
        setSessionCookie(req, res, { id: req.sessionId, ...req.session });
        res.json({ authenticated: true, username: req.session.username, csrfToken: req.session.csrfToken });
    });

    app.post('/api/logout', requireAuth, requireCsrf, (req, res) => {
        security.destroySession(req.sessionId);
        clearSessionCookie(req, res);
        res.json({ success: true });
    });

    app.get('/oauth2callback', (req, res) => googleAuthManager.handleCallback(req, res));

    app.use('/api', requireAuth);

    app.get('/api/settings', async (_req, res, next) => {
        try { res.json(await settingsStore.getPublic()); }
        catch (error) { next(error); }
    });

    app.post('/api/settings', requireCsrf, async (req, res, next) => {
        const previous = await settingsStore.getPrivate().catch(() => null);
        try {
            const updated = await settingsStore.updateFromPublic(req.body);
            try {
                await googleAuthManager.configureCallbackListener(updated.system.authCallbackUrl, mainPort);
                await setupCron();
            } catch (configurationError) {
                if (previous) {
                    await settingsStore.replacePrivate(previous);
                    await googleAuthManager.configureCallbackListener(previous.system.authCallbackUrl, mainPort).catch(() => undefined);
                    await setupCron().catch(() => undefined);
                }
                configurationError.statusCode = configurationError.statusCode || 400;
                throw configurationError;
            }
            invalidateGoogleStatus();
            res.json({ success: true, settings: await settingsStore.getPublic() });
        } catch (error) { next(error); }
    });

    app.get('/api/history', async (_req, res, next) => {
        try {
            const history = await historyStore.read();
            res.json(Array.isArray(history) ? history : []);
        } catch (error) { next(error); }
    });

    app.get('/api/status', async (_req, res, next) => {
        try {
            const settings = await settingsStore.getPrivate();
            const historyValue = await historyStore.read();
            const history = Array.isArray(historyValue) ? historyValue : [];
            const nextRun = calculateNextRun(settings.schedule);
            res.json({
                scheduleEnabled: settings.schedule.enabled,
                nextBackup: nextRun ? nextRun.toISOString() : null,
                servers: settings.servers.map(server => ({
                    id: server.id,
                    host: server.host,
                    folders: server.backups.map(backup => {
                        const last = history.find(item => item.server === server.id && item.folder === backup.name && item.success);
                        return {
                            name: backup.name,
                            status: backupStatus.get(statusKey(server.id, backup.name)) || { status: 'Aguardando', running: false, success: null },
                            lastBackup: last?.timestamp || null,
                            lastWarning: last?.warning || null
                        };
                    })
                }))
            });
        } catch (error) { next(error); }
    });

    app.post('/api/backup/:serverId/:folderName', requireCsrf, async (req, res, next) => {
        try {
            const settings = await settingsStore.getPrivate();
            const server = settings.servers.find(item => item.id === req.params.serverId);
            const backup = server?.backups.find(item => item.name === req.params.folderName);
            if (!server || !backup) return res.status(404).json({ error: 'Servidor ou pasta de backup não encontrado.' });
            const key = statusKey(server.id, backup.name);
            if (runningJobs.has(key)) return res.status(409).json({ error: 'Este backup já está em execução.' });
            runBackup(server, backup, 'manual').catch(() => undefined);
            res.status(202).json({ success: true });
        } catch (error) { next(error); }
    });

    app.get('/api/google/status', async (req, res, next) => {
        try { res.json(await getGoogleStatus(req.query.refresh === '1')); }
        catch (error) { next(error); }
    });

    app.post('/api/google/auth/start', requireCsrf, async (req, res, next) => {
        try {
            const url = await googleAuthManager.createAuthorizationUrl(req.session.username);
            res.json({ url });
        } catch (error) { next(error); }
    });

    app.delete('/api/google/token', requireCsrf, async (_req, res, next) => {
        try {
            await settingsStore.clearRefreshToken();
            invalidateGoogleStatus();
            res.json({ success: true });
        } catch (error) { next(error); }
    });

    app.use(express.static(path.join(APP_ROOT, 'public'), {
        etag: true,
        maxAge: 0,
        index: 'index.html'
    }));

    app.use((req, res) => {
        if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Rota não encontrada.' });
        res.sendFile(path.join(APP_ROOT, 'public', 'index.html'));
    });

    app.use((error, _req, res, _next) => {
        const statusCode = Number(error.statusCode) || 500;
        if (statusCode >= 500) console.error(error.stack || error.message);
        res.status(statusCode).json({
            error: statusCode >= 500 ? 'Erro interno da aplicação. Consulte os logs.' : error.message
        });
    });

    googleAuthManager = new GoogleAuthManager(settingsStore);
    return app;
}

async function start() {
    const app = await createApp();
    const server = await new Promise((resolve, reject) => {
        const listener = app.listen(mainPort, '0.0.0.0', () => resolve(listener));
        listener.once('error', reject);
    });
    await googleAuthManager.start(mainPort);
    await setupCron();
    console.log(`[System] SSH-GDrive Backup Pro v1.1.0 na porta ${mainPort}`);
    return server;
}

if (require.main === module) {
    start().catch(error => {
        console.error(`[Fatal] ${error.stack || error.message}`);
        process.exit(1);
    });
}

module.exports = {
    createApp,
    start,
    runBackup,
    calculateNextRun
};
