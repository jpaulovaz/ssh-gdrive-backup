const { Client } = require('ssh2');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { shellQuote, sanitizeFilePart, calculateChecksums, verifyLocalArchive } = require('./lib/backupIntegrity');

const ACCESS_MODES = new Set(['standard', 'ignore-unreadable', 'sudo']);

function normalizeAccessMode(value) {
    const mode = String(value || 'standard');
    return ACCESS_MODES.has(mode) ? mode : 'standard';
}

function summarizeTarMessages(value, maxLines = 8, maxLength = 2400) {
    const lines = String(value || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
    if (!lines.length) return '';
    const selected = lines.slice(0, maxLines);
    let summary = selected.join(' | ');
    if (lines.length > maxLines) summary += ` | ... e mais ${lines.length - maxLines} ocorrência(s)`;
    if (summary.length > maxLength) summary = `${summary.slice(0, maxLength - 3)}...`;
    return summary;
}

function buildArchiveCommand(remoteTempFile, parentPath, baseName, accessMode = 'standard') {
    const mode = normalizeAccessMode(accessMode);
    const tarOptions = mode === 'ignore-unreadable'
        ? '--warning=no-file-changed --ignore-failed-read'
        : '--warning=no-file-changed';
    const tarExecutable = mode === 'sudo' ? 'sudo -n tar' : 'tar';
    const lines = [
        'set -u',
        `archive=${shellQuote(remoteTempFile)}`,
        `parent=${shellQuote(parentPath)}`,
        `source_name=${shellQuote(baseName)}`,
        'umask 077',
        'rm -f -- "$archive"',
        `${tarExecutable} ${tarOptions} -czf "$archive" -C "$parent" -- "$source_name"`,
        'tar_rc=$?',
        'if [ "$tar_rc" -ne 0 ] && [ ! -s "$archive" ]; then exit "$tar_rc"; fi',
        'if [ "$tar_rc" -gt 1 ]; then exit "$tar_rc"; fi'
    ];

    if (mode === 'sudo') {
        lines.push(
            'if ! sudo -n chown "$(id -u):$(id -g)" -- "$archive"; then printf "Não foi possível transferir a propriedade do arquivo criado com sudo.\n" >&2; exit 93; fi',
            'chmod 600 -- "$archive" || exit 94'
        );
    }

    lines.push(
        'test -s "$archive" || exit 91',
        'tar -tzf "$archive" >/dev/null || exit 92',
        'archive_size=$(wc -c < "$archive" | tr -d "[:space:]")',
        'archive_sha=$(sha256sum "$archive" | awk "{print \\$1}")',
        'printf "BACKUP_META:%s:%s:%s\\n" "$tar_rc" "$archive_size" "$archive_sha"'
    );

    return lines.join('\n');
}

function formatTarFailure(detail, accessMode) {
    const mode = normalizeAccessMode(accessMode);
    const text = String(detail || 'Falha desconhecida durante a compactação.');

    if (mode === 'sudo' && /sudo:|password is required|a password is required|not allowed to execute|not in the sudoers|a terminal is required/i.test(text)) {
        return `Falha na compactação com sudo sem senha: ${text} Configure NOPASSWD para os comandos necessários ou selecione outro modo de acesso.`;
    }

    if (mode === 'standard' && /permission denied|cannot open|cannot stat/i.test(text)) {
        return `Falha na compactação por falta de permissão de leitura: ${text} Edite esta pasta e use "sudo sem senha" para um backup completo, ou "ignorar itens sem permissão" caso aceite um backup parcial identificado com alerta.`;
    }

    return `Falha na compactação ou validação remota: ${text}`;
}

class SSHManager {
    constructor(serverConfig) {
        this.config = serverConfig;
        this.activeConnection = null;
        this.activeLocalPath = null;
    }

    _connectionConfig(readyTimeout = 20000) {
        return {
            host: this.config.host,
            port: this.config.port || 22,
            username: this.config.username,
            password: this.config.password,
            tryKeyboard: true,
            readyTimeout,
            keepaliveInterval: 10000,
            keepaliveCountMax: 3
        };
    }

    connect(readyTimeout = 20000) {
        return new Promise((resolve, reject) => {
            const conn = new Client();
            let settled = false;
            conn.once('ready', () => {
                settled = true;
                resolve(conn);
            });
            conn.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
                finish(prompts.map(prompt => prompt.prompt.toLowerCase().includes('password') ? this.config.password : ''));
            });
            conn.once('error', error => {
                if (!settled) reject(error);
            });
            conn.connect(this._connectionConfig(readyTimeout));
        });
    }

    execCommand(conn, command) {
        return new Promise((resolve, reject) => {
            conn.exec(command, (error, stream) => {
                if (error) return reject(error);
                let stdout = '';
                let stderr = '';
                stream.on('data', data => { stdout += data.toString(); });
                stream.stderr.on('data', data => { stderr += data.toString(); });
                stream.once('error', reject);
                stream.once('close', (code, signal) => resolve({
                    code: Number.isInteger(code) ? code : -1,
                    signal,
                    stdout,
                    stderr
                }));
            });
        });
    }

    async cleanupRemoteFile(remoteFile, existingConnection = null, useSudo = false) {
        const attempt = async connection => {
            const quotedFile = shellQuote(remoteFile);
            const command = useSudo
                ? `rm -f -- ${quotedFile} 2>/dev/null || sudo -n rm -f -- ${quotedFile}`
                : `rm -f -- ${quotedFile}`;
            const result = await this.execCommand(connection, command);
            if (result.code !== 0) {
                throw new Error(result.stderr.trim() || `rm retornou código ${result.code}`);
            }
        };

        if (existingConnection) {
            try {
                await attempt(existingConnection);
                return null;
            } catch (_) {
                // A conexão original pode ter sido encerrada; tenta uma sessão curta separada.
            }
        }

        let cleanupConnection = null;
        try {
            cleanupConnection = await this.connect(10000);
            await attempt(cleanupConnection);
            return null;
        } catch (error) {
            return `Não foi possível remover o arquivo temporário remoto ${remoteFile}: ${error.message}`;
        } finally {
            if (cleanupConnection) cleanupConnection.end();
        }
    }

    async _createRemoteBackup(remotePath, localDest, backupName, onProgress, deadline, options = {}) {
        let conn = null;
        let remoteTempFile = null;
        const warnings = [];
        const accessMode = normalizeAccessMode(options.accessMode);
        const useSudoCleanup = accessMode === 'sudo';

        try {
            conn = await this.connect();
            this.activeConnection = conn;
            if (onProgress) {
                const message = accessMode === 'sudo'
                    ? 'Conectado. Iniciando compactação com sudo sem senha...'
                    : accessMode === 'ignore-unreadable'
                        ? 'Conectado. Iniciando compactação; itens sem permissão serão ignorados e registrados...'
                        : 'Conectado. Iniciando compactação...';
                onProgress(message);
            }

            const normalizedPath = path.posix.normalize(remotePath);
            const parentPath = path.posix.dirname(normalizedPath);
            const baseName = path.posix.basename(normalizedPath);
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const unique = crypto.randomBytes(5).toString('hex');
            const fileName = `ssh-gdrive-backup_${sanitizeFilePart(backupName || baseName)}_${timestamp}_${unique}.tar.gz`;
            remoteTempFile = `/tmp/${fileName}`;
            const localFilePath = path.join(localDest, fileName);
            this.activeLocalPath = localFilePath;

            const command = buildArchiveCommand(remoteTempFile, parentPath, baseName, accessMode);
            const tarResult = await this.execCommand(conn, command);
            if (tarResult.code !== 0) {
                const detail = tarResult.stderr.trim() || tarResult.stdout.trim() || `código ${tarResult.code}`;
                throw new Error(formatTarFailure(detail, accessMode));
            }

            const metadataMatch = tarResult.stdout.match(/BACKUP_META:(\d+):(\d+):([a-f0-9]{64})/i);
            if (!metadataMatch) {
                throw new Error('O servidor não retornou os metadados de integridade do backup. Verifique se sha256sum está instalado.');
            }
            const tarExitCode = Number(metadataMatch[1]);
            const remoteSize = Number(metadataMatch[2]);
            const remoteSha256 = metadataMatch[3].toLowerCase();
            const tarMessages = summarizeTarMessages(tarResult.stderr);

            if (tarExitCode === 1) {
                warnings.push(`O tar retornou alerta durante a compactação, mas o arquivo final passou no teste de integridade.${tarMessages ? ` Detalhe: ${tarMessages}` : ''}`);
            } else if (accessMode === 'ignore-unreadable' && tarMessages) {
                warnings.push(`Backup parcial permitido: o tar ignorou ou sinalizou itens que não puderam ser lidos. Detalhe: ${tarMessages}`);
            }

            if (onProgress) onProgress('Compactação validada. Baixando...');
            const sftp = await new Promise((resolve, reject) => {
                conn.sftp((error, client) => error ? reject(error) : resolve(client));
            });
            const stats = await new Promise((resolve, reject) => {
                sftp.stat(remoteTempFile, (error, value) => error ? reject(error) : resolve(value));
            });
            if (!stats.size || Number(stats.size) !== remoteSize) {
                throw new Error(`Tamanho remoto inconsistente. Esperado ${remoteSize} bytes e encontrado ${stats.size || 0}.`);
            }

            let lastReportedPercent = -1;
            await new Promise((resolve, reject) => {
                sftp.fastGet(remoteTempFile, localFilePath, {
                    step: transferred => {
                        const percent = remoteSize ? Math.floor((transferred / remoteSize) * 100) : 0;
                        const bucket = Math.floor(percent / 10) * 10;
                        if (bucket !== lastReportedPercent) {
                            lastReportedPercent = bucket;
                            if (onProgress) onProgress(`Download: ${Math.min(bucket, 100)}%`);
                        }
                    }
                }, error => error ? reject(error) : resolve());
            });

            const localStats = await fsp.stat(localFilePath);
            if (localStats.size !== remoteSize) {
                throw new Error(`Tamanho local inconsistente. Esperado ${remoteSize} bytes e recebido ${localStats.size}.`);
            }

            if (onProgress) onProgress('Validando checksum e conteúdo do arquivo baixado...');
            const checksums = await calculateChecksums(localFilePath);
            if (checksums.sha256 !== remoteSha256) {
                throw new Error('O checksum SHA-256 do arquivo baixado não corresponde ao arquivo remoto.');
            }
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) throw new Error('O tempo limite foi atingido antes da validação local do arquivo.');
            await verifyLocalArchive(localFilePath, remainingMs);

            if (onProgress) onProgress('Removendo arquivo temporário remoto...');
            const cleanupWarning = await this.cleanupRemoteFile(remoteTempFile, conn, false);
            if (cleanupWarning) warnings.push(cleanupWarning);
            remoteTempFile = null;

            return {
                localPath: localFilePath,
                fileName,
                size: remoteSize,
                sha256: checksums.sha256,
                md5: checksums.md5,
                accessMode,
                warnings
            };
        } catch (error) {
            if (this.activeLocalPath) await fsp.rm(this.activeLocalPath, { force: true }).catch(() => undefined);
            if (remoteTempFile) {
                const cleanupWarning = await this.cleanupRemoteFile(remoteTempFile, conn, useSudoCleanup);
                if (cleanupWarning) error.cleanupWarning = cleanupWarning;
            }
            throw error;
        } finally {
            if (conn) conn.end();
            this.activeConnection = null;
            this.activeLocalPath = null;
        }
    }

    async createRemoteBackup(remotePath, localDest, backupName, onProgress, timeoutMinutes = 60, options = {}) {
        const timeoutMs = timeoutMinutes * 60 * 1000;
        const deadline = Date.now() + timeoutMs;
        let timedOut = false;
        const timeoutId = setTimeout(() => {
            timedOut = true;
            if (this.activeConnection) this.activeConnection.destroy();
            if (this.activeLocalPath) fsp.rm(this.activeLocalPath, { force: true }).catch(() => undefined);
        }, timeoutMs);

        try {
            return await this._createRemoteBackup(remotePath, localDest, backupName, onProgress, deadline, options);
        } catch (error) {
            if (timedOut) {
                const timeoutError = new Error(`Tempo limite de ${timeoutMinutes} minutos excedido no backup SSH.`);
                if (error.cleanupWarning) timeoutError.cleanupWarning = error.cleanupWarning;
                throw timeoutError;
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }
    }
}

module.exports = SSHManager;
module.exports.normalizeAccessMode = normalizeAccessMode;
module.exports.summarizeTarMessages = summarizeTarMessages;
module.exports.buildArchiveCommand = buildArchiveCommand;
module.exports.formatTarFailure = formatTarFailure;
