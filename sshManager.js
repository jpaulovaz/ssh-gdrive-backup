const { Client } = require('ssh2');
const fs = require('fs-extra');
const path = require('path');

class SSHManager {
    constructor(serverConfig) {
        this.config = serverConfig;
    }

    async createRemoteBackup(remotePath, localDest, onProgress, timeoutMinutes = 60) {
        return new Promise((resolve, reject) => {
            const conn = new Client();
            let isFinished = false;
            
            // Converter minutos para milissegundos
            const timeoutMs = timeoutMinutes * 60 * 1000;
            
            const timeout = setTimeout(() => {
                if (!isFinished) {
                    conn.end();
                    reject(new Error(`Tempo limite de ${timeoutMinutes} minutos excedido no SSH`));
                }
            }, timeoutMs);

            const fileName = `${path.basename(remotePath)}_${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`;
            const remoteTempFile = `/tmp/${fileName}`;
            const localFilePath = path.join(localDest, fileName);

            const cleanupAndResolve = (data) => {
                if (isFinished) return;
                isFinished = true;
                clearTimeout(timeout);
                conn.end();
                resolve(data);
            };

            conn.on('ready', () => {
                console.log(`[SSH] Conectado a ${this.config.host}`);
                if (onProgress) onProgress(`Conectado. Iniciando compactação...`);
                
                const cmd = `tar --warning=no-file-changed -czf "${remoteTempFile}" -C "${path.dirname(remotePath)}" "${path.basename(remotePath)}" && echo "TAR_DONE"`;
                
                conn.exec(cmd, (err, stream) => {
                    if (err) {
                        clearTimeout(timeout);
                        return reject(err);
                    }
                    
                    let stderrData = '';
                    let tarDetected = false;

                    const startDownload = () => {
                        if (tarDetected) return;
                        tarDetected = true;

                        conn.sftp((err, sftp) => {
                            if (err) {
                                clearTimeout(timeout);
                                return reject(err);
                            }
                            
                            sftp.stat(remoteTempFile, (statErr, stats) => {
                                if (statErr) {
                                    clearTimeout(timeout);
                                    return reject(new Error(`Arquivo não encontrado no servidor: ${stderrData}`));
                                }
                                
                                if (onProgress) onProgress(`Compactação concluída. Baixando...`);
                                
                                const totalSize = stats.size;
                                sftp.fastGet(remoteTempFile, localFilePath, {
                                    step: (transferred) => {
                                        const percent = totalSize ? Math.round((transferred / totalSize) * 100) : 0;
                                        if (onProgress && percent % 10 === 0) {
                                            onProgress(`Download: ${percent}% (${(transferred / 1024 / 1024).toFixed(2)} MB)`);
                                        }
                                    }
                                }, (downloadErr) => {
                                    if (downloadErr) {
                                        clearTimeout(timeout);
                                        return reject(downloadErr);
                                    }
                                    
                                    console.log(`[SSH] Download concluído: ${localFilePath}`);
                                    if (onProgress) onProgress(`Limpando servidor remoto...`);
                                    
                                    conn.exec(`rm "${remoteTempFile}"`, () => {
                                        cleanupAndResolve({
                                            localPath: localFilePath,
                                            fileName: fileName,
                                            size: totalSize
                                        });
                                    });
                                });
                            });
                        });
                    };

                    stream.on('data', (data) => {
                        if (data.toString().includes('TAR_DONE')) startDownload();
                    });

                    stream.stderr.on('data', (data) => {
                        stderrData += data.toString();
                    });

                    stream.on('close', () => startDownload());
                });
            }).on('keyboard-interactive', (name, instructions, instructionsLang, prompts, finish) => {
                if (prompts.length > 0 && prompts[0].prompt.toLowerCase().includes('password')) {
                    finish([this.config.password]);
                } else {
                    finish([]);
                }
            }).on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            }).connect({
                host: this.config.host,
                port: this.config.port || 22,
                username: this.config.username,
                password: this.config.password,
                tryKeyboard: true,
                readyTimeout: 20000
            });
        });
    }
}

module.exports = SSHManager;
