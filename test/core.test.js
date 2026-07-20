const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { execFile } = require('child_process');
const { promisify } = require('util');

const AtomicJsonStore = require('../lib/atomicJsonStore');
const SecurityManager = require('../lib/securityManager');
const { SettingsStore } = require('../lib/settingsStore');
const { normalizeSettings, validateRemotePath } = require('../lib/validation');
const DriveManager = require('../driveManager');
const SSHManager = require('../sshManager');
const { calculateNextRun } = require('../lib/scheduler');
const { parseCookies, serializeCookie } = require('../lib/cookies');
const { shellQuote, sanitizeFilePart, calculateChecksums, sha256File, md5File, verifyLocalArchive } = require('../lib/backupIntegrity');
const { escapeDriveQuery, buildManagedBackupQuery } = require('../lib/driveQuery');

const execFileAsync = promisify(execFile);

async function tempDir(prefix) {
    return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('AtomicJsonStore serializa atualizações concorrentes e grava JSON válido', async () => {
    const dir = await tempDir('backup-store-');
    const file = path.join(dir, 'counter.json');
    const store = new AtomicJsonStore(file, { count: 0 });
    await store.init();
    await Promise.all(Array.from({ length: 25 }, () => store.update(value => ({ count: value.count + 1 }))));
    assert.deepEqual(await store.read(), { count: 25 });
    assert.deepEqual(JSON.parse(await fsp.readFile(file, 'utf8')), { count: 25 });
});

test('SecurityManager criptografa segredos e exige credenciais válidas', async () => {
    const dir = await tempDir('backup-security-');
    const manager = new SecurityManager({ dataDir: dir, sessionTtlMs: 10000 });
    const initialized = await manager.init();
    assert.ok(initialized.setupCode);
    const encrypted = manager.encrypt('segredo-forte');
    assert.notEqual(JSON.stringify(encrypted).includes('segredo-forte'), true);
    assert.equal(manager.decrypt(encrypted), 'segredo-forte');

    const username = await manager.completeSetup(initialized.setupCode, 'admin.test', 'SenhaSegura123');
    assert.equal(username, 'admin.test');
    const session = await manager.authenticate('admin.test', 'SenhaSegura123', '127.0.0.1');
    assert.equal(session.username, 'admin.test');
    assert.ok(manager.getSession(session.id));
    await assert.rejects(() => manager.authenticate('admin.test', 'errada', '10.0.0.1'), /inválidos/);
});


test('SecurityManager renova o código de configuração enquanto não há administrador', async () => {
    const dir = await tempDir('backup-setup-renew-');
    const first = new SecurityManager({ dataDir: dir });
    const firstInit = await first.init();
    const second = new SecurityManager({ dataDir: dir });
    const secondInit = await second.init();
    assert.ok(firstInit.setupCode);
    assert.ok(secondInit.setupCode);
    assert.notEqual(secondInit.setupCode, firstInit.setupCode);
    await assert.rejects(() => second.completeSetup(firstInit.setupCode, 'admin', 'SenhaSegura123'), /inválido/);
    await second.completeSetup(secondInit.setupCode, 'admin', 'SenhaSegura123');
});

test('SettingsStore migra segredos legados sem mantê-los em texto puro', async () => {
    const dir = await tempDir('backup-settings-');
    const settingsFile = path.join(dir, 'settings.json');
    await fsp.writeFile(settingsFile, JSON.stringify({
        google: {
            clientId: 'client-id',
            clientSecret: 'client-secret-plain',
            refreshToken: 'refresh-token-plain',
            baseFolderId: 'root-folder'
        },
        servers: [{
            id: 'srv1', host: '127.0.0.1', port: 22, username: 'root', password: 'ssh-password-plain',
            backups: [{ name: 'dados', remotePath: '/var/data' }]
        }],
        system: { port: 8990, retentionLimit: 2, backupTimeout: 60, authPort: 3000 },
        schedule: { enabled: true, time: '01:00', days: [1] }
    }, null, 2));

    const security = new SecurityManager({ dataDir: path.join(dir, 'data') });
    await security.init();
    const store = new SettingsStore(settingsFile, security);
    await store.init();
    const privateSettings = await store.getPrivate();
    assert.equal(privateSettings.google.clientSecret, 'client-secret-plain');
    assert.equal(privateSettings.google.refreshToken, 'refresh-token-plain');
    assert.equal(privateSettings.servers[0].password, 'ssh-password-plain');
    assert.equal(privateSettings.servers[0].backups[0].accessMode, 'standard');

    const raw = await fsp.readFile(settingsFile, 'utf8');
    assert.equal(raw.includes('client-secret-plain'), false);
    assert.equal(raw.includes('refresh-token-plain'), false);
    assert.equal(raw.includes('ssh-password-plain'), false);
    await assert.rejects(() => fsp.access(`${settingsFile}.bak`));

    const publicSettings = await store.getPublic();
    assert.equal(publicSettings.google.clientSecret, '');
    assert.equal(publicSettings.google.hasClientSecret, true);
    assert.equal(publicSettings.servers[0].password, '');
    assert.equal(publicSettings.servers[0].hasPassword, true);
});

test('Validação preserva segredos existentes e bloqueia entradas perigosas', () => {
    const current = {
        google: { clientId: 'id', clientSecret: 'secret', refreshToken: 'token', baseFolderId: '' },
        servers: [{ id: 'srv', host: 'host', port: 22, username: 'user', password: 'pass', backups: [{ name: 'data', remotePath: '/srv/data', accessMode: 'standard' }] }],
        system: { port: 8990, retentionLimit: 2, backupTimeout: 60, authCallbackUrl: 'http://localhost:3000/oauth2callback' },
        schedule: { enabled: true, time: '00:00', days: [0] }
    };
    const normalized = normalizeSettings({
        google: { clientId: 'id2', clientSecret: '', baseFolderId: '' },
        servers: [{ id: 'srv', host: 'host', port: 22, username: 'user', password: '', backups: [{ name: 'data', remotePath: '/srv/data', accessMode: 'sudo' }] }],
        system: { retentionLimit: 3, backupTimeout: 90, authCallbackUrl: 'http://localhost:3000/oauth2callback' },
        schedule: { enabled: true, time: '02:30', days: [1, 1, 2] }
    }, current);
    assert.equal(normalized.google.clientSecret, 'secret');
    assert.equal(normalized.google.refreshToken, 'token');
    assert.equal(normalized.servers[0].password, 'pass');
    assert.equal(normalized.servers[0].backups[0].accessMode, 'sudo');
    assert.deepEqual(normalized.schedule.days, [1, 2]);
    assert.throws(() => validateRemotePath('/'), /diretório raiz/);
    assert.throws(() => normalizeSettings({
        google: {},
        servers: [{ id: 'srv;rm', host: 'host', port: 22, username: 'u', password: 'x', backups: [{ name: 'b', remotePath: '/tmp/a' }] }],
        system: { retentionLimit: 2, backupTimeout: 60, authCallbackUrl: 'http://localhost:3000/oauth2callback' },
        schedule: { enabled: false, time: '00:00', days: [] }
    }, current), /Identificador/);
});

test('Cálculo de próxima execução respeita dia e horário', () => {
    const now = new Date(2026, 6, 20, 10, 0, 30); // segunda-feira local
    const sameDay = calculateNextRun({ enabled: true, time: '11:30', days: [1] }, now);
    assert.equal(sameDay.getDay(), 1);
    assert.equal(sameDay.getHours(), 11);
    const nextWeek = calculateNextRun({ enabled: true, time: '09:00', days: [1] }, now);
    assert.equal(Math.round((nextWeek - now) / 86400000), 7);
    assert.equal(calculateNextRun({ enabled: false, time: '09:00', days: [1] }, now), null);
});

test('Escapes impedem quebra de comandos e consultas', () => {
    assert.equal(shellQuote("/tmp/a'b"), "'/tmp/a'\"'\"'b'");
    assert.equal(sanitizeFilePart('Dados / Financeiro'), 'Dados_Financeiro');
    assert.equal(sanitizeFilePart('***'), 'backup');
    assert.equal(escapeDriveQuery("Pasta d'água\\x"), "Pasta d\\'água\\\\x");
    const query = buildManagedBackupQuery('folder-id', 'Servidor A', 'Dados');
    assert.match(query, /backupApp/);
    assert.match(query, /serverKey/);
    assert.match(query, /backupKey/);
    assert.equal(query.includes('Servidor A'), false);
});

test('Cookie de sessão usa atributos de proteção', () => {
    const cookie = serializeCookie('session', 'abc', { maxAge: 100, secure: true });
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Secure/);
    assert.equal(parseCookies('a=1; session=abc').session, 'abc');
});


test('Validação aplica modo normal em backups antigos e rejeita modo desconhecido', () => {
    const current = {
        google: { clientId: '', clientSecret: '', refreshToken: '', baseFolderId: '' },
        servers: [],
        system: { port: 8990, retentionLimit: 2, backupTimeout: 60, authCallbackUrl: 'http://localhost:3000/oauth2callback' },
        schedule: { enabled: false, time: '00:00', days: [] }
    };
    const normalized = normalizeSettings({
        google: {},
        servers: [{
            id: 'srv', host: 'host', port: 22, username: 'user', password: 'pass',
            backups: [{ name: 'dados', remotePath: '/srv/dados' }]
        }],
        system: { retentionLimit: 2, backupTimeout: 60, authCallbackUrl: 'http://localhost:3000/oauth2callback' },
        schedule: { enabled: false, time: '00:00', days: [] }
    }, current);
    assert.equal(normalized.servers[0].backups[0].accessMode, 'standard');

    assert.throws(() => normalizeSettings({
        google: {},
        servers: [{
            id: 'srv', host: 'host', port: 22, username: 'user', password: 'pass',
            backups: [{ name: 'dados', remotePath: '/srv/dados', accessMode: 'root-total' }]
        }],
        system: { retentionLimit: 2, backupTimeout: 60, authCallbackUrl: 'http://localhost:3000/oauth2callback' },
        schedule: { enabled: false, time: '00:00', days: [] }
    }, current), /Modo de acesso/);
});

test('Comandos de compactação diferenciam modo estrito, parcial e sudo', () => {
    const standard = SSHManager.buildArchiveCommand('/tmp/a.tar.gz', '/srv', 'dados', 'standard');
    const partial = SSHManager.buildArchiveCommand('/tmp/a.tar.gz', '/srv', 'dados', 'ignore-unreadable');
    const sudo = SSHManager.buildArchiveCommand('/tmp/a.tar.gz', '/srv', 'dados', 'sudo');

    assert.doesNotMatch(standard, /ignore-failed-read/);
    assert.doesNotMatch(standard, /sudo -n tar/);
    assert.match(partial, /--ignore-failed-read/);
    assert.match(sudo, /sudo -n tar/);
    assert.match(sudo, /sudo -n chown/);
});

test('Status do Google mantém a conta conectada quando a pasta não é visível pelo escopo', async () => {
    const manager = Object.create(DriveManager.prototype);
    manager.baseFolderId = 'folder-id';
    manager.drive = {
        about: {
            get: async () => ({ data: { user: { displayName: 'Teste', emailAddress: 'teste@example.com' } } })
        },
        files: {
            get: async () => {
                const error = new Error('File not found: folder-id.');
                error.code = 404;
                throw error;
            }
        }
    };

    const result = await manager.testConnection();
    assert.equal(result.connected, true);
    assert.equal(result.emailAddress, 'teste@example.com');
    assert.equal(result.baseFolderStatus, 'unverified');
    assert.match(result.baseFolderMessage, /drive\.file/);
});

test('Checksum e teste local detectam arquivo tar.gz válido', async () => {
    const dir = await tempDir('backup-archive-');
    const sourceDir = path.join(dir, 'source');
    const archive = path.join(dir, 'archive.tar.gz');
    await fsp.mkdir(sourceDir, { recursive: true });
    await fsp.writeFile(path.join(sourceDir, 'file.txt'), 'conteudo de teste');
    await execFileAsync('tar', ['-czf', archive, '-C', dir, 'source']);
    await verifyLocalArchive(archive);
    const checksum = await sha256File(archive);
    const md5 = await md5File(archive);
    const combined = await calculateChecksums(archive);
    assert.match(checksum, /^[a-f0-9]{64}$/);
    assert.match(md5, /^[a-f0-9]{32}$/);
    assert.deepEqual(combined, { sha256: checksum, md5 });
});
