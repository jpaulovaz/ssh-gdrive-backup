const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

class DriveManager {
    constructor(googleConfig) {
        if (!googleConfig.clientId || !googleConfig.clientSecret || !googleConfig.refreshToken) {
            throw new Error('Configurações do Google Drive incompletas.');
        }

        const oauth2Client = new google.auth.OAuth2(
            googleConfig.clientId,
            googleConfig.clientSecret
        );

        oauth2Client.setCredentials({
            refresh_token: googleConfig.refreshToken
        });

        this.drive = google.drive({ version: 'v3', auth: oauth2Client });
        this.baseFolderId = googleConfig.baseFolderId;
    }

    async getOrCreateFolder(folderName, parentId) {
        const query = `name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and trashed = false`;
        const response = await this.drive.files.list({
            q: query,
            fields: 'files(id, name)',
            spaces: 'drive',
        });

        if (response.data.files.length > 0) {
            return response.data.files[0].id;
        }

        const fileMetadata = {
            name: folderName,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [parentId],
        };

        const folder = await this.drive.files.create({
            resource: fileMetadata,
            fields: 'id',
        });

        return folder.data.id;
    }

    async rotateBackups(folderId, limit) {
        if (!limit || limit <= 0) return;

        try {
            const response = await this.drive.files.list({
                q: `'${folderId}' in parents and trashed = false`,
                fields: 'files(id, name, createdTime)',
                orderBy: 'createdTime desc',
            });

            const files = response.data.files;
            if (files.length > limit) {
                const filesToDelete = files.slice(limit);
                console.log(`[Drive] Rotatividade: Mantendo os ${limit} mais recentes. Apagando ${filesToDelete.length} antigos...`);
                
                for (const file of filesToDelete) {
                    await this.drive.files.delete({ fileId: file.id });
                    console.log(`[Drive] Removido backup antigo: ${file.name}`);
                }
            }
        } catch (error) {
            console.error('[Drive] Erro na rotação de backups:', error.message);
        }
    }

    async uploadFile(filePath, fileName, serverName, folderName, onProgress, retentionLimit) {
        try {
            if (onProgress) onProgress(`Preparando estrutura de pastas no Google Drive...`);
            
            // 1. Criar/Obter pasta do Servidor
            const serverFolderId = await this.getOrCreateFolder(serverName, this.baseFolderId);
            
            // 2. Criar/Obter subpasta específica do Backup (Ex: docker, grafana)
            const backupFolderId = await this.getOrCreateFolder(folderName, serverFolderId);

            const fileSize = fs.statSync(filePath).size;
            const fileMetadata = {
                name: fileName,
                parents: [backupFolderId],
            };
            
            const media = {
                mimeType: 'application/gzip',
                body: fs.createReadStream(filePath),
            };

            const response = await this.drive.files.create({
                resource: fileMetadata,
                media: media,
                fields: 'id, name',
            }, {
                onUploadProgress: evt => {
                    if (onProgress) {
                        const progress = Math.round((evt.bytesRead / fileSize) * 100);
                        if (progress % 5 === 0) {
                            onProgress(`Upload Google Drive: ${progress}%`);
                        }
                    }
                }
            });

            const uploadedFileId = response.data.id;
            
            if (uploadedFileId && retentionLimit) {
                if (onProgress) onProgress(`Upload concluído. Organizando backups antigos desta pasta...`);
                await this.rotateBackups(backupFolderId, retentionLimit);
            }

            return uploadedFileId;
        } catch (error) {
            console.error('[Drive] Erro crítico no upload:', error.message);
            throw error;
        }
    }
}

module.exports = DriveManager;
