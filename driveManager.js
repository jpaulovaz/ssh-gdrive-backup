const { google } = require('googleapis');
const fs = require('fs');
const { escapeDriveQuery, propertyKey, buildManagedBackupQuery } = require('./lib/driveQuery');

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

class DriveManager {
    constructor(googleConfig) {
        if (!googleConfig.clientId || !googleConfig.clientSecret || !googleConfig.refreshToken) {
            throw new Error('Configurações do Google Drive incompletas.');
        }

        const oauth2Client = new google.auth.OAuth2(
            googleConfig.clientId,
            googleConfig.clientSecret
        );
        oauth2Client.setCredentials({ refresh_token: googleConfig.refreshToken });
        this.drive = google.drive({ version: 'v3', auth: oauth2Client });
        this.baseFolderId = googleConfig.baseFolderId || 'root';
    }

    async testConnection() {
        const response = await this.drive.about.get({ fields: 'user' });
        let baseFolderName = 'Meu Drive';
        if (this.baseFolderId !== 'root') {
            const folder = await this.drive.files.get({
                fileId: this.baseFolderId,
                fields: 'id, name, mimeType, trashed'
            });
            if (folder.data.trashed || folder.data.mimeType !== 'application/vnd.google-apps.folder') {
                throw new Error('A pasta base configurada não é uma pasta válida ou está na lixeira.');
            }
            baseFolderName = folder.data.name || this.baseFolderId;
        }
        return {
            connected: true,
            displayName: response.data.user?.displayName || '',
            emailAddress: response.data.user?.emailAddress || '',
            baseFolderName
        };
    }

    async getOrCreateFolder(folderName, parentId) {
        const safeName = escapeDriveQuery(folderName);
        const safeParent = escapeDriveQuery(parentId || 'root');
        const query = `name = '${safeName}' and mimeType = 'application/vnd.google-apps.folder' and '${safeParent}' in parents and trashed = false`;
        const response = await this.drive.files.list({
            q: query,
            fields: 'files(id, name)',
            spaces: 'drive',
            pageSize: 10
        });

        if (response.data.files?.length > 0) return response.data.files[0].id;

        const folder = await this.drive.files.create({
            resource: {
                name: folderName,
                mimeType: 'application/vnd.google-apps.folder',
                parents: [parentId || 'root']
            },
            fields: 'id'
        });
        if (!folder.data.id) throw new Error(`O Google Drive não retornou o ID da pasta ${folderName}.`);
        return folder.data.id;
    }

    async listManagedBackups(folderId, serverName, folderName) {
        const query = buildManagedBackupQuery(folderId, serverName, folderName);
        const files = [];
        let pageToken;
        do {
            const response = await this.drive.files.list({
                q: query,
                fields: 'nextPageToken, files(id, name, createdTime, size, appProperties)',
                orderBy: 'createdTime desc',
                pageSize: 1000,
                pageToken
            });
            files.push(...(response.data.files || []));
            pageToken = response.data.nextPageToken;
        } while (pageToken);
        return files;
    }

    async rotateBackups(folderId, limit, serverName, folderName) {
        if (!limit || limit <= 0) return { deleted: 0 };
        const files = await this.listManagedBackups(folderId, serverName, folderName);
        const filesToDelete = files.slice(limit);
        for (const file of filesToDelete) {
            await this.drive.files.delete({ fileId: file.id });
            console.log(`[Drive] Backup antigo removido: ${file.name}`);
        }
        return { deleted: filesToDelete.length };
    }

    async verifyUploadedFile(fileId, expected) {
        const response = await this.drive.files.get({
            fileId,
            fields: 'id, name, size, md5Checksum, trashed, appProperties'
        });
        const file = response.data;
        if (!file.id || file.trashed) throw new Error('O arquivo enviado não está disponível no Google Drive.');
        if (file.name !== expected.fileName) throw new Error('O nome do arquivo no Google Drive é diferente do esperado.');
        if (Number(file.size) !== Number(expected.size)) throw new Error('O tamanho do arquivo no Google Drive é diferente do arquivo local.');
        if (!file.md5Checksum || file.md5Checksum.toLowerCase() !== expected.md5.toLowerCase()) throw new Error('O checksum MD5 calculado pelo Google Drive é diferente do arquivo local.');
        if (file.appProperties?.sha256 !== expected.sha256) throw new Error('O checksum SHA-256 registrado no Google Drive é diferente do checksum local.');
        if (file.appProperties?.backupApp !== 'ssh-gdrive-backup') throw new Error('O marcador de propriedade do backup não foi salvo no Google Drive.');
        return file;
    }

    async uploadFile(filePath, fileName, serverName, folderName, integrity, onProgress, retentionLimit, retryCount = 3) {
        let lastError;

        for (let attempt = 1; attempt <= retryCount; attempt += 1) {
            let uploadedFileId = null;
            try {
                if (attempt > 1) {
                    if (onProgress) onProgress(`Tentando upload novamente (${attempt}/${retryCount})...`);
                    await delay(5000);
                } else if (onProgress) {
                    onProgress('Preparando estrutura de pastas no Google Drive...');
                }

                const serverFolderId = await this.getOrCreateFolder(serverName, this.baseFolderId);
                const backupFolderId = await this.getOrCreateFolder(folderName, serverFolderId);
                const fileSize = fs.statSync(filePath).size;
                let lastReportedPercent = -1;

                const response = await this.drive.files.create({
                    resource: {
                        name: fileName,
                        parents: [backupFolderId],
                        appProperties: {
                            backupApp: 'ssh-gdrive-backup',
                            serverKey: propertyKey(serverName),
                            backupKey: propertyKey(folderName),
                            sha256: integrity.sha256,
                            schemaVersion: '1'
                        }
                    },
                    media: {
                        mimeType: 'application/gzip',
                        body: fs.createReadStream(filePath)
                    },
                    fields: 'id, name, size, appProperties'
                }, {
                    onUploadProgress: event => {
                        const percent = fileSize ? Math.floor((event.bytesRead / fileSize) * 100) : 0;
                        const bucket = Math.floor(percent / 5) * 5;
                        if (bucket !== lastReportedPercent) {
                            lastReportedPercent = bucket;
                            if (onProgress) onProgress(`Upload Google Drive: ${Math.min(bucket, 100)}%`);
                        }
                    }
                });

                uploadedFileId = response.data.id;
                if (!uploadedFileId) throw new Error('O Google Drive não retornou o ID do arquivo enviado.');

                if (onProgress) onProgress('Verificando o arquivo armazenado no Google Drive...');
                await this.verifyUploadedFile(uploadedFileId, {
                    fileName,
                    size: integrity.size,
                    sha256: integrity.sha256,
                    md5: integrity.md5
                });

                const warnings = [];
                if (retentionLimit) {
                    if (onProgress) onProgress('Aplicando retenção aos backups gerenciados...');
                    try {
                        await this.rotateBackups(backupFolderId, retentionLimit, serverName, folderName);
                    } catch (rotationError) {
                        warnings.push(`Upload validado, mas a retenção falhou: ${rotationError.message}`);
                    }
                }

                return { fileId: uploadedFileId, backupFolderId, warnings };
            } catch (error) {
                lastError = error;
                console.error(`[Drive] Erro na tentativa ${attempt}: ${error.message}`);
                if (uploadedFileId) {
                    await this.drive.files.delete({ fileId: uploadedFileId }).catch(() => undefined);
                }
                if (/invalid_client|invalid_grant|unauthorized_client/i.test(error.message)) break;
            }
        }
        throw lastError;
    }
}

module.exports = DriveManager;
