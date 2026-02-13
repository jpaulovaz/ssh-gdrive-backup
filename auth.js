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
            console.log('\n[Auth] Código recebido. Trocando por tokens...');
            const { tokens } = await oauth2Client.getToken(code);
            
            const currentSettings = getSettings();
            currentSettings.google.refreshToken = tokens.refresh_token;
            saveSettings(currentSettings);

            console.log('\n=== ✅ Sucesso! ===');
            console.log('O Refresh Token foi salvo automaticamente no seu settings.json.');
            
            res.send('<h1>Autenticação concluída!</h1><p>O token foi salvo. Você já pode fechar esta aba e reiniciar o programa principal.</p>');
            
            setTimeout(() => process.exit(0), 3000);
        } catch (error) {
            console.error('\n❌ ERRO DETALHADO DO GOOGLE:');
            if (error.response && error.response.data) {
                console.error(JSON.stringify(error.response.data, null, 2));
            } else {
                console.error(error.message);
            }
            
            console.log('\n💡 DICA: Verifique se o Client Secret no Dashboard não tem espaços extras e se o tipo de app no Google Console é "Web Application".');
            
            res.status(500).send(`<h1>Erro na autenticação</h1><pre>${error.message}</pre>`);
        }
    }
});

console.log('\n=== Autenticação Google Drive (Diagnóstico) ===');
console.log(`\n1. URI de Redirecionamento configurada: ${REDIRECT_URI}`);
console.log('2. Abra o link abaixo no seu navegador:');
console.log('\n\x1b[36m%s\x1b[0m', authUrl);

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\nEsperando autorização na porta ${PORT}...`);
});
