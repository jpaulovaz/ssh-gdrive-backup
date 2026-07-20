const AtomicJsonStore = require('./atomicJsonStore');
const { normalizeSettings, normalizeBackupAccessMode } = require('./validation');

const DEFAULT_SETTINGS = {
    version: 4,
    google: {
        clientId: '',
        clientSecretEncrypted: null,
        refreshTokenEncrypted: null,
        baseFolderId: ''
    },
    servers: [],
    system: {
        port: 8990,
        retentionLimit: 2,
        backupTimeout: 60,
        authCallbackUrl: 'http://localhost:3000/oauth2callback'
    },
    schedule: {
        enabled: true,
        time: '00:00',
        days: [0, 1, 2, 3, 4, 5, 6]
    }
};

class SettingsStore {
    constructor(filePath, securityManager) {
        this.security = securityManager;
        this.store = new AtomicJsonStore(filePath, DEFAULT_SETTINGS, { mode: 0o600 });
    }

    async init() {
        await this.store.init();
        const raw = await this.store.read();
        const migrated = this._migrateRaw(raw);
        if (JSON.stringify(raw) !== JSON.stringify(migrated)) {
            // Não cria .bak durante a migração: o arquivo anterior pode conter segredos em texto puro.
            await this.store.write(migrated, { createBackup: false });
        }
    }

    _encryptLegacySecret(encryptedValue, plainValue, alternateValue) {
        if (this.security.isEncrypted(encryptedValue)) return encryptedValue;
        if (typeof encryptedValue === 'string') return this.security.encrypt(encryptedValue);
        if (typeof plainValue === 'string') return this.security.encrypt(plainValue);
        if (this.security.isEncrypted(alternateValue)) return alternateValue;
        return this.security.encrypt(typeof alternateValue === 'string' ? alternateValue : '');
    }

    _migrateRaw(rawInput) {
        const raw = rawInput && typeof rawInput === 'object' ? rawInput : {};
        const google = raw.google || {};
        const servers = Array.isArray(raw.servers) ? raw.servers : [];

        const clientSecretEncrypted = this._encryptLegacySecret(
            google.clientSecretEncrypted,
            google.clientSecret,
            google.clientSecret
        );
        const refreshTokenEncrypted = this._encryptLegacySecret(
            google.refreshTokenEncrypted,
            google.refreshToken,
            google.refreshToken
        );

        const migratedServers = servers.map(server => ({
            id: server.id || '',
            host: server.host || '',
            port: Number(server.port) || 22,
            username: server.username || '',
            passwordEncrypted: this._encryptLegacySecret(
                server.passwordEncrypted,
                server.password,
                server.password
            ),
            sudoUsesSshPassword: server.sudoUsesSshPassword !== false,
            sudoPasswordEncrypted: this._encryptLegacySecret(
                server.sudoPasswordEncrypted,
                server.sudoPassword,
                server.sudoPassword
            ),
            backups: Array.isArray(server.backups) ? server.backups.map(backup => ({
                name: backup.name || '',
                remotePath: backup.remotePath || '',
                accessMode: normalizeBackupAccessMode(backup.accessMode)
            })) : []
        }));

        return {
            version: 4,
            google: {
                clientId: google.clientId || '',
                clientSecretEncrypted,
                refreshTokenEncrypted,
                baseFolderId: google.baseFolderId || ''
            },
            servers: migratedServers,
            system: {
                port: Number(raw.system?.port) || 8990,
                retentionLimit: Number(raw.system?.retentionLimit) || 2,
                backupTimeout: Number(raw.system?.backupTimeout) || 60,
                authCallbackUrl: raw.system?.authCallbackUrl || `http://localhost:${Number(raw.system?.authPort) || 3000}/oauth2callback`
            },
            schedule: {
                enabled: raw.schedule?.enabled !== false,
                time: raw.schedule?.time || '00:00',
                days: Array.isArray(raw.schedule?.days) ? raw.schedule.days : [0, 1, 2, 3, 4, 5, 6]
            }
        };
    }

    _decryptRaw(raw) {
        return {
            google: {
                clientId: raw.google?.clientId || '',
                clientSecret: this.security.decrypt(raw.google?.clientSecretEncrypted),
                refreshToken: this.security.decrypt(raw.google?.refreshTokenEncrypted),
                baseFolderId: raw.google?.baseFolderId || ''
            },
            servers: (raw.servers || []).map(server => ({
                id: server.id,
                host: server.host,
                port: server.port || 22,
                username: server.username,
                password: this.security.decrypt(server.passwordEncrypted),
                sudoUsesSshPassword: server.sudoUsesSshPassword !== false,
                sudoPassword: this.security.decrypt(server.sudoPasswordEncrypted),
                backups: Array.isArray(server.backups) ? server.backups : []
            })),
            system: {
                port: raw.system?.port || 8990,
                retentionLimit: raw.system?.retentionLimit || 2,
                backupTimeout: raw.system?.backupTimeout || 60,
                authCallbackUrl: raw.system?.authCallbackUrl || 'http://localhost:3000/oauth2callback'
            },
            schedule: {
                enabled: raw.schedule?.enabled !== false,
                time: raw.schedule?.time || '00:00',
                days: Array.isArray(raw.schedule?.days) ? raw.schedule.days : []
            }
        };
    }

    _encryptSettings(settings) {
        return {
            version: 4,
            google: {
                clientId: settings.google.clientId,
                clientSecretEncrypted: this.security.encrypt(settings.google.clientSecret),
                refreshTokenEncrypted: this.security.encrypt(settings.google.refreshToken),
                baseFolderId: settings.google.baseFolderId
            },
            servers: settings.servers.map(server => ({
                id: server.id,
                host: server.host,
                port: server.port,
                username: server.username,
                passwordEncrypted: this.security.encrypt(server.password),
                sudoUsesSshPassword: server.sudoUsesSshPassword !== false,
                sudoPasswordEncrypted: this.security.encrypt(server.sudoPassword),
                backups: server.backups
            })),
            system: settings.system,
            schedule: settings.schedule
        };
    }

    async getPrivate() {
        const raw = this._migrateRaw(await this.store.read());
        return this._decryptRaw(raw);
    }

    async getPublic() {
        const settings = await this.getPrivate();
        return {
            google: {
                clientId: settings.google.clientId,
                clientSecret: '',
                hasClientSecret: Boolean(settings.google.clientSecret),
                hasRefreshToken: Boolean(settings.google.refreshToken),
                baseFolderId: settings.google.baseFolderId
            },
            servers: settings.servers.map(server => ({
                id: server.id,
                host: server.host,
                port: server.port,
                username: server.username,
                password: '',
                hasPassword: Boolean(server.password),
                sudoUsesSshPassword: server.sudoUsesSshPassword !== false,
                sudoPassword: '',
                hasSudoPassword: Boolean(server.sudoPassword),
                backups: server.backups
            })),
            system: settings.system,
            schedule: settings.schedule
        };
    }

    async updateFromPublic(input) {
        let updatedPrivate;
        await this.store.update(raw => {
            const current = this._decryptRaw(this._migrateRaw(raw));
            updatedPrivate = normalizeSettings(input, current);
            return this._encryptSettings(updatedPrivate);
        });
        return updatedPrivate;
    }

    async replacePrivate(settings) {
        await this.store.write(this._encryptSettings(settings));
    }

    async setRefreshToken(refreshToken) {
        await this.store.update(raw => {
            const migrated = this._migrateRaw(raw);
            migrated.google.refreshTokenEncrypted = this.security.encrypt(refreshToken);
            return migrated;
        });
    }

    async clearRefreshToken() {
        await this.store.update(raw => {
            const migrated = this._migrateRaw(raw);
            migrated.google.refreshTokenEncrypted = null;
            return migrated;
        });
    }
}

module.exports = { SettingsStore, DEFAULT_SETTINGS };
