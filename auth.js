const { google } = require('googleapis');
const express = require('express');
const fs = require('fs-extra');

const SETTINGS_FILE = './settings.json';

const getSettings = () => {
    try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
    catch (e) { return null; }
};

const saveSettings = (data) => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2));

const settings = getSettings();

if (!settings || !settings.google.clientId || !settings.google.clientSecret) {
    console.error('\n❌ Erro: Configure o Client ID e Client Secret na interface web antes de rodar este script.');
    process.exit(1);
}

// O Google NÃO permite IPs privados (192.168.x.x) como Redirect URI.
// A melhor prática para servidores remotos é usar localhost e fazer um túnel SSH.
const PORT = settings.system.authPort || 3000;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

const oauth2Client = new google.auth.OAuth2(
    settings.google.clientId,
    settings.google.clientSecret,
    REDIRECT_URI
);

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
});

const app = express();

app.get('/oauth2callback', async (req, res) => {
    const { code } = req.query;
    if (code) {
        try {
            const { tokens } = await oauth2Client.getToken(code);
            
            const currentSettings = getSettings();
            currentSettings.google.refreshToken = tokens.refresh_token;
            saveSettings(currentSettings);

            console.log('\n=== ✅ Sucesso! ===');
            console.log('O Refresh Token foi salvo automaticamente no seu settings.json.');
            
            res.send('<h1>Autenticação concluída!</h1><p>O token foi salvo. Você já pode fechar esta aba e reiniciar o programa principal.</p>');
            
            setTimeout(() => process.exit(0), 3000);
        } catch (error) {
            console.error('Erro ao obter token:', error.message);
            res.status(500).send('Erro na autenticação.');
        }
    }
});

console.log('\n=== Autenticação Google Drive ===');
console.log('⚠️  IMPORTANTE: O Google não aceita IPs privados (192.168.x.x).');
console.log(`\n1. No Google Cloud Console, adicione este URI de Redirecionamento:`);
console.log(`   \x1b[33m${REDIRECT_URI}\x1b[0m`);

console.log('\n2. Se você estiver em um servidor remoto, execute este comando no SEU COMPUTADOR LOCAL:');
console.log(`   \x1b[32mssh -L ${PORT}:localhost:${PORT} seu-usuario@ip-do-servidor\x1b[0m`);

console.log('\n3. Agora, abra o link abaixo no seu navegador:');
console.log('\n\x1b[36m%s\x1b[0m', authUrl);

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\nEsperando autorização na porta ${PORT}...`);
});
