# Changelog

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
