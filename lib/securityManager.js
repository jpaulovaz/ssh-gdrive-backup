const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const AtomicJsonStore = require('./atomicJsonStore');

const PASSWORD_KEY_LENGTH = 64;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SETUP_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';


function httpError(message, statusCode) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function timingSafeEqualText(a, b) {
    const aBuffer = Buffer.from(String(a));
    const bBuffer = Buffer.from(String(b));
    if (aBuffer.length !== bBuffer.length) return false;
    return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function hashPassword(password, salt) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, PASSWORD_KEY_LENGTH, (error, derivedKey) => {
            if (error) reject(error);
            else resolve(derivedKey.toString('hex'));
        });
    });
}

function randomSetupCode(length = 16) {
    let value = '';
    const bytes = crypto.randomBytes(length);
    for (let i = 0; i < length; i += 1) {
        value += SETUP_CODE_ALPHABET[bytes[i] % SETUP_CODE_ALPHABET.length];
    }
    return value.match(/.{1,4}/g).join('-');
}

class SecurityManager {
    constructor(options = {}) {
        const dataDir = path.resolve(options.dataDir || './data');
        this.keyPath = path.join(dataDir, 'master.key');
        this.store = new AtomicJsonStore(
            path.join(dataDir, 'security.json'),
            { version: 1, admin: null, setup: null },
            { mode: 0o600 }
        );
        this.masterKey = null;
        this.sessions = new Map();
        this.loginAttempts = new Map();
        this.sessionTtlMs = options.sessionTtlMs || SESSION_TTL_MS;
    }

    async init() {
        let generatedSetupCode = null;
        await fsp.mkdir(path.dirname(this.keyPath), { recursive: true });
        this.masterKey = await this._loadOrCreateMasterKey();
        const state = await this.store.init();

        if (!state.admin) {
            const setupCode = randomSetupCode();
            generatedSetupCode = setupCode;
            const codeSalt = crypto.randomBytes(16).toString('hex');
            const codeHash = await hashPassword(setupCode, codeSalt);
            await this.store.update(current => ({
                ...current,
                version: 1,
                setup: {
                    codeSalt,
                    codeHash,
                    createdAt: new Date().toISOString()
                }
            }));
            console.log('\n[Segurança] Configuração inicial necessária.');
            console.log(`[Segurança] Código de configuração: ${setupCode}`);
            console.log('[Segurança] Use esse código na primeira tela do aplicativo.\n');
        }

        setInterval(() => this.cleanupExpiredSessions(), 10 * 60 * 1000).unref();
        return { setupCode: generatedSetupCode };
    }

    async _loadOrCreateMasterKey() {
        try {
            await fsp.access(this.keyPath);
            const keyText = (await fsp.readFile(this.keyPath, 'utf8')).trim();
            const key = Buffer.from(keyText, 'base64');
            if (key.length !== 32) {
                throw new Error('A chave mestra existente é inválida. Restaure data/master.key a partir de um backup seguro.');
            }
            return key;
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }

        const key = crypto.randomBytes(32);
        try {
            await fsp.writeFile(this.keyPath, `${key.toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
            await fsp.chmod(this.keyPath, 0o600);
            return key;
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            const existingText = (await fsp.readFile(this.keyPath, 'utf8')).trim();
            const existingKey = Buffer.from(existingText, 'base64');
            if (existingKey.length !== 32) {
                throw new Error('A chave mestra existente é inválida. Restaure data/master.key a partir de um backup seguro.');
            }
            return existingKey;
        }
    }

    encrypt(plainText) {
        if (plainText === undefined || plainText === null || plainText === '') return null;
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey, iv);
        const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
        return {
            version: 1,
            algorithm: 'aes-256-gcm',
            iv: iv.toString('base64'),
            tag: cipher.getAuthTag().toString('base64'),
            data: encrypted.toString('base64')
        };
    }

    decrypt(value) {
        if (!value) return '';
        if (typeof value === 'string') return value;
        if (value.version !== 1 || value.algorithm !== 'aes-256-gcm') {
            throw new Error('Formato de segredo criptografado não reconhecido.');
        }
        const decipher = crypto.createDecipheriv(
            'aes-256-gcm',
            this.masterKey,
            Buffer.from(value.iv, 'base64')
        );
        decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
        const decrypted = Buffer.concat([
            decipher.update(Buffer.from(value.data, 'base64')),
            decipher.final()
        ]);
        return decrypted.toString('utf8');
    }

    isEncrypted(value) {
        return Boolean(value && typeof value === 'object' && value.algorithm === 'aes-256-gcm');
    }

    async getBootstrapStatus() {
        const state = await this.store.read();
        return { needsSetup: !state.admin };
    }

    async completeSetup(setupCode, username, password) {
        const normalizedUsername = this.validateUsername(username);
        this.validateAdminPassword(password);
        const normalizedCode = String(setupCode || '').trim().toUpperCase();
        const salt = crypto.randomBytes(16).toString('hex');

        await this.store.update(async state => {
            if (state.admin) throw httpError('A configuração inicial já foi concluída.', 409);
            if (!state.setup?.codeHash || !state.setup?.codeSalt) {
                throw httpError('Código de configuração indisponível. Reinicie a aplicação.', 409);
            }
            const suppliedHash = await hashPassword(normalizedCode, state.setup.codeSalt);
            if (!timingSafeEqualText(suppliedHash, state.setup.codeHash)) {
                throw httpError('Código de configuração inválido.', 401);
            }
            const passwordHash = await hashPassword(password, salt);
            return {
                version: 1,
                admin: {
                    username: normalizedUsername,
                    salt,
                    passwordHash,
                    createdAt: new Date().toISOString()
                },
                setup: null
            };
        });
        return normalizedUsername;
    }

    validateUsername(username) {
        const value = String(username || '').trim();
        if (!/^[A-Za-z0-9._-]{3,40}$/.test(value)) {
            throw httpError('O usuário deve ter entre 3 e 40 caracteres e usar apenas letras, números, ponto, hífen ou sublinhado.', 400);
        }
        return value;
    }

    validateAdminPassword(password) {
        const value = String(password || '');
        if (value.length < 12 || value.length > 200) {
            throw httpError('A senha administrativa deve ter entre 12 e 200 caracteres.', 400);
        }
        if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) {
            throw httpError('A senha administrativa deve conter ao menos uma letra e um número.', 400);
        }
    }

    _attemptKey(ip) {
        return String(ip || 'unknown');
    }

    assertAttemptAllowed(ip) {
        const key = this._attemptKey(ip);
        const now = Date.now();
        const entry = this.loginAttempts.get(key);
        if (!entry || entry.resetAt <= now) {
            this.loginAttempts.delete(key);
            return;
        }
        if (entry.count >= 5) {
            const seconds = Math.ceil((entry.resetAt - now) / 1000);
            const error = new Error(`Muitas tentativas. Aguarde ${seconds} segundos.`);
            error.statusCode = 429;
            throw error;
        }
    }

    recordFailedAttempt(ip) {
        const key = this._attemptKey(ip);
        const now = Date.now();
        const current = this.loginAttempts.get(key);
        if (!current || current.resetAt <= now) {
            this.loginAttempts.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
        } else {
            current.count += 1;
        }
    }

    clearAttempts(ip) {
        this.loginAttempts.delete(this._attemptKey(ip));
    }

    async authenticate(username, password, ip) {
        const attemptKey = `login:${this._attemptKey(ip)}`;
        this.assertAttemptAllowed(attemptKey);
        const state = await this.store.read();
        if (!state.admin) {
            const error = new Error('A configuração inicial ainda não foi concluída.');
            error.statusCode = 409;
            throw error;
        }

        const suppliedUsername = String(username || '').trim();
        const suppliedHash = await hashPassword(String(password || ''), state.admin.salt);
        const validUser = timingSafeEqualText(suppliedUsername, state.admin.username);
        const validPassword = timingSafeEqualText(suppliedHash, state.admin.passwordHash);
        if (!validUser || !validPassword) {
            this.recordFailedAttempt(attemptKey);
            const error = new Error('Usuário ou senha inválidos.');
            error.statusCode = 401;
            throw error;
        }

        this.clearAttempts(attemptKey);
        return this.createSession(state.admin.username);
    }

    createSession(username) {
        const id = crypto.randomBytes(32).toString('base64url');
        const csrfToken = crypto.randomBytes(24).toString('base64url');
        const expiresAt = Date.now() + this.sessionTtlMs;
        this.sessions.set(id, { username, csrfToken, expiresAt });
        return { id, username, csrfToken, expiresAt };
    }

    getSession(sessionId) {
        if (!sessionId) return null;
        const session = this.sessions.get(sessionId);
        if (!session) return null;
        if (session.expiresAt <= Date.now()) {
            this.sessions.delete(sessionId);
            return null;
        }
        session.expiresAt = Date.now() + this.sessionTtlMs;
        return session;
    }

    destroySession(sessionId) {
        if (sessionId) this.sessions.delete(sessionId);
    }

    cleanupExpiredSessions() {
        const now = Date.now();
        for (const [id, session] of this.sessions.entries()) {
            if (session.expiresAt <= now) this.sessions.delete(id);
        }
    }
}

module.exports = SecurityManager;
