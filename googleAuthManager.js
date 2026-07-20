const express = require('express');
const crypto = require('crypto');
const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

class GoogleAuthManager {
    constructor(settingsStore) {
        this.settingsStore = settingsStore;
        this.pendingStates = new Map();
        this.callbackServer = null;
        this.callbackPort = null;
        this.callbackPath = '/oauth2callback';
    }

    async start(mainPort) {
        const settings = await this.settingsStore.getPrivate();
        await this.configureCallbackListener(settings.system.authCallbackUrl, mainPort);
        setInterval(() => this.cleanupStates(), 5 * 60 * 1000).unref();
    }

    cleanupStates() {
        const now = Date.now();
        for (const [state, entry] of this.pendingStates.entries()) {
            if (entry.expiresAt <= now) this.pendingStates.delete(state);
        }
    }

    createClient(config, redirectUri) {
        return new google.auth.OAuth2(config.clientId, config.clientSecret, redirectUri);
    }

    async createAuthorizationUrl(username) {
        const settings = await this.settingsStore.getPrivate();
        if (!settings.google.clientId || !settings.google.clientSecret) {
            const error = new Error('Salve o Client ID e o Client Secret antes de autenticar o Google Drive.');
            error.statusCode = 400;
            throw error;
        }

        const state = crypto.randomBytes(32).toString('base64url');
        this.pendingStates.set(state, {
            username,
            expiresAt: Date.now() + 10 * 60 * 1000,
            redirectUri: settings.system.authCallbackUrl
        });
        const client = this.createClient(settings.google, settings.system.authCallbackUrl);
        return client.generateAuthUrl({
            access_type: 'offline',
            scope: SCOPES,
            prompt: 'consent',
            state
        });
    }

    async handleCallback(req, res) {
        const state = String(req.query.state || '');
        const code = String(req.query.code || '');
        const pending = this.pendingStates.get(state);
        this.pendingStates.delete(state);

        if (!pending || pending.expiresAt <= Date.now()) {
            return res.status(400).send(this.resultPage('Autenticação inválida', 'O estado da autenticação expirou ou não é reconhecido. Inicie novamente pelo aplicativo.'));
        }
        if (!code) {
            const reason = req.query.error ? `O Google retornou: ${String(req.query.error)}` : 'O código de autorização não foi recebido.';
            return res.status(400).send(this.resultPage('Autenticação cancelada', reason));
        }

        try {
            const settings = await this.settingsStore.getPrivate();
            const client = this.createClient(settings.google, pending.redirectUri);
            const { tokens } = await client.getToken(code);
            const refreshToken = tokens.refresh_token || settings.google.refreshToken;
            if (!refreshToken) {
                throw new Error('O Google não retornou um Refresh Token. Revogue o acesso anterior e tente novamente.');
            }
            await this.settingsStore.setRefreshToken(refreshToken);
            return res.send(this.resultPage('Autenticação concluída', 'O acesso ao Google Drive foi salvo com segurança. Esta janela pode ser fechada.'));
        } catch (error) {
            console.error(`[Google Auth] ${error.message}`);
            return res.status(500).send(this.resultPage('Falha na autenticação', 'Não foi possível concluir a autenticação. Consulte o log da aplicação e tente novamente.'));
        }
    }

    resultPage(title, message) {
        const escape = value => String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
        return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title></head><body><main><h1>${escape(title)}</h1><p>${escape(message)}</p></main></body></html>`;
    }

    async configureCallbackListener(callbackUrl, mainPort) {
        const parsed = new URL(callbackUrl);
        const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
        this.callbackPath = parsed.pathname;

        if (port === Number(mainPort) || parsed.protocol === 'https:') {
            await this.stopCallbackListener();
            this.callbackPort = port;
            return;
        }
        if (this.callbackServer && this.callbackPort === port) return;

        await this.stopCallbackListener();
        const callbackApp = express();
        callbackApp.disable('x-powered-by');
        callbackApp.use((_req, res, next) => {
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-Frame-Options', 'DENY');
            res.setHeader('Referrer-Policy', 'no-referrer');
            next();
        });
        callbackApp.get(this.callbackPath, (req, res) => this.handleCallback(req, res));
        callbackApp.use((_req, res) => res.status(404).send('Não encontrado.'));

        await new Promise((resolve, reject) => {
            const server = callbackApp.listen(port, '0.0.0.0', resolve);
            server.once('error', reject);
            this.callbackServer = server;
        });
        this.callbackPort = port;
        console.log(`[Google Auth] Callback aguardando em 0.0.0.0:${port}${this.callbackPath}`);
    }

    async stopCallbackListener() {
        if (!this.callbackServer) return;
        const server = this.callbackServer;
        this.callbackServer = null;
        await new Promise(resolve => server.close(() => resolve()));
    }
}

module.exports = GoogleAuthManager;
