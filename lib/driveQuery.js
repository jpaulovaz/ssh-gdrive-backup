const crypto = require('crypto');

function escapeDriveQuery(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function propertyKey(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 40);
}

function buildManagedBackupQuery(folderId, serverName, folderName) {
    return [
        `'${escapeDriveQuery(folderId)}' in parents`,
        'trashed = false',
        "mimeType != 'application/vnd.google-apps.folder'",
        "appProperties has { key='backupApp' and value='ssh-gdrive-backup' }",
        `appProperties has { key='serverKey' and value='${propertyKey(serverName)}' }`,
        `appProperties has { key='backupKey' and value='${propertyKey(folderName)}' }`
    ].join(' and ');
}

module.exports = { escapeDriveQuery, propertyKey, buildManagedBackupQuery };
