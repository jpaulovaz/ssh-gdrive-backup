# Changelog

## 1.1.2 - Sudo Password Backup (2026-07-20)

### Backup completo sem alteração no servidor remoto

- O modo `sudo` passa a aceitar autenticação por senha, sem exigir configuração `NOPASSWD` no servidor de origem.
- Por padrão, o aplicativo reutiliza a senha SSH como senha do sudo; também é possível cadastrar uma senha sudo diferente por servidor.
- A senha sudo é armazenada com AES-256-GCM usando a mesma chave mestra dos demais segredos.
- A senha é enviada pelo `stdin` do canal SSH, codificada apenas para transporte, e nunca é incluída na linha de comando remota.
- A execução solicita pseudo-terminal, desativa o eco durante o recebimento da senha e remove possíveis segredos das saídas capturadas.
- Compactação, validação, ajuste de propriedade e permissões são executados dentro de uma única sessão privilegiada, evitando expiração do cache do sudo durante backups longos.
- O arquivo temporário remoto também pode ser removido com sudo e senha em fluxos de falha.
- Configurações existentes no modo `sudo` são migradas automaticamente para reutilizar a senha SSH.

## 1.1.1 - Resilient Access (2026-07-19)

### Google Drive

- O status da conta Google foi separado da validação dos metadados da pasta base.
- Respostas 403/404 ao consultar a pasta com o escopo `drive.file` não são mais exibidas como falha geral de conexão.
- A interface passa a mostrar “Google conectado” com alerta quando a conta está válida, mas a pasta não pode ser consultada diretamente.
- Upload, checksum e retenção continuam sendo validados durante cada execução real.

### Permissões de leitura no servidor

- Cada pasta de backup passa a aceitar três modos: Normal, Ignorar itens sem permissão e sudo sem senha.
- O modo Normal continua sendo o padrão e interrompe o backup se houver conteúdo ilegível.
- O modo Ignorar cria um backup parcial, registra os itens problemáticos e conclui com alerta explícito.
- O modo sudo executa a compactação com `sudo -n`, sem armazenar ou enviar senha de sudo pela aplicação.
- Mensagens de erro de permissão e de sudo foram ampliadas com orientação operacional.

## 1.1.0 - Secure Reliability (2026-07-19)

### Segurança

- Adicionada configuração inicial protegida por código temporário exibido no terminal.
- Adicionados login administrativo, sessões `HttpOnly`, proteção CSRF e limitação de tentativas.
- Senhas SSH, Client Secret e Refresh Token passam a ser gravados com AES-256-GCM.
- As APIs deixam de devolver segredos ao navegador.
- Adicionadas validação de entradas, citação segura de comandos shell e política de segurança de conteúdo.

### Integridade do backup

- O resultado do `tar` remoto passa a ser validado.
- O arquivo remoto é testado com `tar -tzf`, medido e identificado por SHA-256.
- O download é conferido por tamanho, SHA-256 e novo teste local do arquivo.
- O upload é conferido no Google Drive por nome, tamanho, MD5 e metadados SHA-256.
- Uploads que não passam na validação são removidos.

### Retenção e concorrência

- A retenção remove somente arquivos marcados como criados pela aplicação e pertencentes ao mesmo servidor e backup.
- Backups antigos, sem os novos marcadores, não são excluídos automaticamente.
- O mesmo backup não pode executar duas vezes simultaneamente no mesmo processo.
- Arquivos temporários locais e remotos são removidos nos fluxos de sucesso e falha; resíduos locais são limpos na inicialização.

### Interface e operação

- A autenticação OAuth do Google foi integrada à interface; `auth.js` foi removido.
- O Callback URL configurado passa a ser usado efetivamente.
- O status do Google Drive agora faz uma chamada real e valida também a pasta base.
- Adicionados controle de ativação do agendamento e cálculo real da próxima execução.
- Removidas dependências visuais externas da interface.

### Persistência e manutenção

- Configurações e histórico passam a usar gravação atômica, fila de atualizações e cópia de recuperação.
- A migração inicial não cria cópia `.bak` com os segredos legados em texto puro.
- Removidos arquivos de configuração obsoletos, o repositório Git embutido no pacote e dependências não utilizadas.
- Adicionados testes automatizados e validação de sintaxe.
