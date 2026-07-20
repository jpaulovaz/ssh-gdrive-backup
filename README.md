# SSH-GDrive Backup Pro

**Versão 1.1.1 — Resilient Access**

Aplicação Node.js para compactar diretórios remotos por SSH, validar a integridade do arquivo, transferi-lo ao Google Drive e manter retenção controlada por servidor e pasta.

## Principais mudanças desta versão

1. **Acesso protegido**: configuração inicial com código exibido no terminal, login administrativo, sessão `HttpOnly`, proteção CSRF e limitação de tentativas.
2. **Segredos protegidos**: senhas SSH, Client Secret e Refresh Token são criptografados no `settings.json` e nunca são devolvidos pela API.
3. **Integridade do backup**: o arquivo é testado no servidor, conferido por tamanho e SHA-256 após o download, testado novamente localmente e comparado com o MD5 calculado pelo Google Drive após o upload.
4. **Retenção segura**: somente arquivos marcados pela própria aplicação podem ser removidos pela rotação. Outros arquivos da pasta do Drive são preservados.
5. **Concorrência e limpeza**: o mesmo backup não pode ser iniciado duas vezes simultaneamente; arquivos temporários são removidos nos fluxos de finalização e sobras locais são limpas na inicialização.
6. **Interface e persistência**: autenticação Google integrada, status separado entre conta e pasta base, modos de leitura por pasta, controle do agendamento e gravação JSON atômica.

## Requisitos

- Node.js 18 ou superior.
- `tar` e `sha256sum` disponíveis nos servidores de origem.
- `tar` disponível no host da aplicação para a segunda validação do arquivo baixado.
- Credenciais OAuth 2.0 do Google Cloud.

## Instalação nova

```bash
npm ci --omit=dev
npm start
```

Na primeira inicialização, o terminal exibirá um **código de configuração**. Se ele for perdido antes da criação do administrador, reinicie a aplicação para gerar outro código. Abra `http://IP_DO_SERVIDOR:8990`, informe esse código e crie o usuário administrativo.

Com PM2:

```bash
pm2 start index.js --name ssh-gdrive-backup
pm2 save
```

Para atualizar uma instalação anterior, consulte [UPGRADE.md](UPGRADE.md) e use preferencialmente o pacote de atualização, que preserva os dados existentes.

## Autenticação do Google Drive

1. Cadastre no Google Cloud exatamente a URI configurada no campo **Callback URL**. O padrão é:

```text
http://localhost:3000/oauth2callback
```

2. Em uma instalação remota que use `localhost`, mantenha um túnel aberto no computador que executará o navegador:

```bash
ssh -L 3000:localhost:3000 usuario@servidor
```

3. Na interface, salve o Client ID, o Client Secret e a pasta base.
4. Clique em **Autenticar Google** e conclua a autorização na janela aberta.

O processo `auth.js` deixou de ser necessário; a autenticação agora é conduzida pelo processo principal.

Para HTTPS atrás de proxy reverso, encaminhe `/oauth2callback` para a aplicação e use `TRUST_PROXY=1 COOKIE_SECURE=true`. A URL cadastrada no Google deve ser idêntica ao Callback URL salvo na interface.

## Arquivos importantes

- `settings.json`: configurações e segredos criptografados.
- `history.json`: últimas 100 execuções.
- `data/master.key`: chave necessária para descriptografar os segredos.
- `data/security.json`: hash do usuário administrativo e estado da configuração inicial.
- `temp_backups/`: área transitória, limpa automaticamente.

## Backup obrigatório da chave mestra

Guarde uma cópia protegida de `data/master.key`. Sem essa chave, as senhas e os tokens já gravados não podem ser recuperados. Não compartilhe nem versione esse arquivo.

A criptografia evita exposição acidental no JSON e pela API. Ela não protege contra um invasor que consiga ler simultaneamente o `settings.json` e o `data/master.key`; as permissões do sistema operacional continuam essenciais.

## Acesso a arquivos sem permissão

Cada pasta cadastrada possui um modo de acesso:

- **Normal**: modo padrão. Qualquer erro de leitura interrompe a execução para evitar um backup silenciosamente incompleto.
- **Ignorar itens sem permissão**: usa `tar --ignore-failed-read`. O backup pode ser parcial e sempre é registrado como sucesso com alerta quando o `tar` relata itens ignorados.
- **sudo sem senha**: usa `sudo -n` para compactar e exige configuração prévia de `NOPASSWD` no servidor. A aplicação não reutiliza a senha SSH como senha de sudo.

Para dados de containers, como Loki e Grafana, prefira corrigir permissões por grupo ou ACL. Use o modo sudo apenas quando for necessário obter um backup completo e a política do servidor permitir. O usuário SSH precisa poder executar, sem senha, os comandos `tar`, `chown` e `rm` usados no arquivo temporário.

## Status do Google Drive

A versão 1.1.1 considera a conta conectada quando a chamada de identidade do Google é válida. Se o escopo `drive.file` não permitir consultar diretamente os metadados da pasta base, a interface apresenta um alerta de pasta não validada, sem classificar a autenticação como falha. O acesso efetivo continua sendo confirmado durante o upload e a verificação do backup.

## Retenção

A retenção remove somente backups que tenham sido criados e marcados pela própria aplicação para o mesmo servidor e pasta. Backups antigos sem esses marcadores são preservados e devem ser revisados manualmente no Google Drive.

## Recuperação do acesso administrativo

Caso a senha seja perdida, pare a aplicação, faça backup e remova somente `data/security.json`. Mantenha `data/master.key`. Ao iniciar novamente, um novo código de configuração será exibido e os segredos existentes continuarão acessíveis com a mesma chave.

## Validação

```bash
npm run check
npm test
```

Uma execução é marcada como concluída somente depois das validações remota, local e no Google Drive. O histórico registra tamanho, SHA-256, MD5, duração e eventuais alertas.

Essas validações confirmam a consistência técnica do arquivo. Periodicamente, extraia um backup em uma área isolada para comprovar o processo completo de restauração.
