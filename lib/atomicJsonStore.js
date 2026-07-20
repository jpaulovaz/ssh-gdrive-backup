const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

async function pathExists(target) {
    try {
        await fsp.access(target);
        return true;
    } catch (_) {
        return false;
    }
}

class AtomicJsonStore {
    constructor(filePath, defaultValue, options = {}) {
        this.filePath = path.resolve(filePath);
        this.backupPath = `${this.filePath}.bak`;
        this.defaultValue = clone(defaultValue);
        this.mode = options.mode || 0o600;
        this.queue = Promise.resolve();
    }

    async init() {
        await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
        if (!(await pathExists(this.filePath))) {
            await this._atomicWrite(this.defaultValue, false);
        } else {
            await fsp.chmod(this.filePath, this.mode).catch(() => undefined);
        }
        if (await pathExists(this.backupPath)) {
            await fsp.chmod(this.backupPath, this.mode).catch(() => undefined);
        }
        return this.read();
    }

    async read() {
        try {
            return JSON.parse(await fsp.readFile(this.filePath, 'utf8'));
        } catch (error) {
            try {
                const backup = JSON.parse(await fsp.readFile(this.backupPath, 'utf8'));
                await this._atomicWrite(backup, false);
                return backup;
            } catch (_) {
                if (error.code === 'ENOENT') return clone(this.defaultValue);
                throw new Error(`Falha ao ler ${path.basename(this.filePath)}: ${error.message}`);
            }
        }
    }

    async write(value, options = {}) {
        const createBackup = options.createBackup !== false;
        return this._enqueue(async () => {
            await this._atomicWrite(value, createBackup);
            return clone(value);
        });
    }

    async update(mutator) {
        return this._enqueue(async () => {
            const current = await this.read();
            const next = await mutator(clone(current));
            await this._atomicWrite(next, true);
            return clone(next);
        });
    }

    _enqueue(operation) {
        const run = this.queue.then(operation, operation);
        this.queue = run.catch(() => undefined);
        return run;
    }

    async _atomicWrite(value, createBackup) {
        const dir = path.dirname(this.filePath);
        await fsp.mkdir(dir, { recursive: true });

        if (createBackup && await pathExists(this.filePath)) {
            try {
                await fsp.copyFile(this.filePath, this.backupPath);
                await fsp.chmod(this.backupPath, this.mode);
            } catch (error) {
                console.warn(`[Storage] Não foi possível atualizar o backup de ${path.basename(this.filePath)}: ${error.message}`);
            }
        }

        const tempPath = path.join(dir, `.${path.basename(this.filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
        const payload = `${JSON.stringify(value, null, 2)}\n`;
        let handle;

        try {
            handle = await fsp.open(tempPath, 'w', this.mode);
            await handle.writeFile(payload, 'utf8');
            await handle.sync();
            await handle.close();
            handle = null;
            await fsp.rename(tempPath, this.filePath);
            await fsp.chmod(this.filePath, this.mode);

            try {
                const dirHandle = await fsp.open(dir, 'r');
                await dirHandle.sync();
                await dirHandle.close();
            } catch (_) {
                // Alguns sistemas de arquivos não permitem fsync em diretórios.
            }
        } finally {
            if (handle) await handle.close().catch(() => undefined);
            await fsp.rm(tempPath, { force: true }).catch(() => undefined);
        }
    }
}

module.exports = AtomicJsonStore;
