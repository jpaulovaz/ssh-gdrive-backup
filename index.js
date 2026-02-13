const express = require('express');
const cron = require('node-cron');
const fs = require('fs-extra');
const path = require('path');
const SSHManager = require('./sshManager');
const DriveManager = require('./driveManager');

const app = express();
app.use(express.json());

const SETTINGS_FILE = './settings.json';
const HISTORY_FILE = './history.json';
const TEMP_DIR = path.resolve('./temp_backups');

fs.ensureDirSync(TEMP_DIR);

// Funções de Persistência
const getSettings = () => {
    try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
    catch (e) { return { google: {}, servers: [], system: { port: 8990, retentionLimit: 2 }, schedule: { enabled: true, time: "00:00", days: [0,1,2,3,4,5,6] } }; }
};

const saveSettings = (data) => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2));

const getHistory = () => {
    try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); }
    catch (e) { return []; }
};

const saveHistory = (data) => fs.writeFileSync(HISTORY_FILE, JSON.stringify(data.slice(0, 100), null, 2));

// Estado Global
const backupStatus = {};
let cronJob = null;

// Função de Backup
async function runBackup(server, backupConfig) {
    const statusKey = `${server.id}:${backupConfig.name}`;
    const settings = getSettings();
    
    console.log(`[Job] Iniciando: ${server.id} -> ${backupConfig.name}`);
    backupStatus[statusKey] = { status: 'Iniciando...', running: true };

    try {
        // 1. SSH
        const ssh = new SSHManager(server);
        const result = await ssh.createRemoteBackup(
            backupConfig.remotePath, 
            TEMP_DIR, 
            (msg) => { backupStatus[statusKey].status = msg; },
            settings.system.backupTimeout || 60
        );
        
        // 2. Google Drive
        const drive = new DriveManager(settings.google);
        await drive.uploadFile(
            result.localPath, 
            result.fileName, 
            server.id,
            backupConfig.name, // Passando o nome da pasta para criar subpasta
            (msg) => { backupStatus[statusKey].status = msg; },
            settings.system.retentionLimit
        );
        
        // 3. Cleanup
        await fs.remove(result.localPath);
        
        // 4. History
        const history = getHistory();
        history.unshift({ server: server.id, folder: backupConfig.name, timestamp: new Date().toISOString(), success: true });
        saveHistory(history);

        backupStatus[statusKey] = { status: 'Concluído!', running: false, success: true };
    } catch (error) {
        console.error(`[Job Error] ${error.message}`);
        const history = getHistory();
        history.unshift({ server: server.id, folder: backupConfig.name, timestamp: new Date().toISOString(), success: false, error: error.message });
        saveHistory(history);
        backupStatus[statusKey] = { status: `Erro: ${error.message}`, running: false, success: false };
    }
}

// Cron Dinâmico
function setupCron() {
    const settings = getSettings();
    if (cronJob) cronJob.stop();

    if (settings.schedule && settings.schedule.enabled && settings.schedule.time) {
        const [hour, minute] = settings.schedule.time.split(':');
        const days = settings.schedule.days.join(',');
        const cronExpr = `${minute} ${hour} * * ${days}`;

        console.log(`[Cron] Agendado para: ${cronExpr}`);
        cronJob = cron.schedule(cronExpr, async () => {
            console.log('[Cron] Executando rotina...');
            const currentSettings = getSettings();
            for (const server of currentSettings.servers) {
                for (const backup of server.backups) {
                    await runBackup(server, backup);
                }
            }
        });
    }
}

// API
app.use(express.static('public'));

app.get('/api/settings', (req, res) => res.json(getSettings()));
app.post('/api/settings', (req, res) => {
    saveSettings(req.body);
    setupCron();
    res.json({ success: true });
});

app.get('/api/history', (req, res) => res.json(getHistory()));

app.get('/api/status', (req, res) => {
    const settings = getSettings();
    const history = getHistory();
    res.json({
        servers: settings.servers.map(s => ({
            id: s.id,
            host: s.host,
            folders: s.backups.map(b => {
                const last = history.find(h => h.server === s.id && h.folder === b.name && h.success);
                return {
                    name: b.name,
                    status: backupStatus[`${s.id}:${b.name}`] || { status: 'Aguardando', running: false },
                    lastBackup: last ? last.timestamp : null
                };
            })
        }))
    });
});

app.get('/backup/:serverId/:folderName', async (req, res) => {
    const settings = getSettings();
    const server = settings.servers.find(s => s.id === req.params.serverId);
    const backup = server?.backups.find(b => b.name === req.params.folderName);
    if (server && backup) {
        runBackup(server, backup);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Não encontrado' });
    }
});

const settings = getSettings();
app.listen(settings.system.port || 8990, () => {
    console.log(`[System] Rodando na porta ${settings.system.port || 8990}`);
    setupCron();
});
