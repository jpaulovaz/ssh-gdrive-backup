const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function sanitizeFilePart(value, maxLength = 80) {
    const normalized = String(value || '')
        .normalize('NFKD')
        .replace(/[^\p{L}\p{N}._-]+/gu, '_')
        .replace(/^[_\.-]+|[_\.-]+$/g, '')
        .slice(0, maxLength);
    return normalized || 'backup';
}

function hashFile(filePath, algorithm) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash(algorithm);
        const stream = fs.createReadStream(filePath);
        stream.on('error', reject);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

function calculateChecksums(filePath) {
    return new Promise((resolve, reject) => {
        const sha256 = crypto.createHash('sha256');
        const md5 = crypto.createHash('md5');
        const stream = fs.createReadStream(filePath);
        stream.on('error', reject);
        stream.on('data', chunk => {
            sha256.update(chunk);
            md5.update(chunk);
        });
        stream.on('end', () => resolve({
            sha256: sha256.digest('hex'),
            md5: md5.digest('hex')
        }));
    });
}

function sha256File(filePath) {
    return hashFile(filePath, 'sha256');
}

function md5File(filePath) {
    return hashFile(filePath, 'md5');
}

function verifyLocalArchive(filePath, timeoutMs = 10 * 60 * 1000) {
    return new Promise((resolve, reject) => {
        const child = spawn('tar', ['-tzf', filePath], {
            stdio: ['ignore', 'ignore', 'pipe']
        });
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            child.kill('SIGKILL');
            settled = true;
            reject(new Error('O teste local do arquivo excedeu o tempo limite.'));
        }, timeoutMs);

        child.stderr.on('data', chunk => {
            if (stderr.length < 8192) stderr += chunk.toString().slice(0, 8192 - stderr.length);
        });
        child.once('error', error => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new Error(`Não foi possível executar o teste local do arquivo: ${error.message}`));
        });
        child.once('close', code => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error(`O arquivo baixado falhou no teste de integridade${stderr.trim() ? `: ${stderr.trim()}` : ` (código ${code})`}.`));
        });
    });
}

module.exports = {
    shellQuote,
    sanitizeFilePart,
    hashFile,
    calculateChecksums,
    sha256File,
    md5File,
    verifyLocalArchive
};
