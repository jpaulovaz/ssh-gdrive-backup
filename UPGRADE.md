# Atualização para a versão 1.1.0

## Antes de atualizar

1. Pare o processo da aplicação.
2. Faça uma cópia protegida de `settings.json` e `history.json`.
3. Não substitua esses dois arquivos pelos modelos vazios de uma instalação nova.
4. Preserve o diretório `data/` depois que a versão 1.1.0 tiver sido inicializada. Ele conterá a chave mestra e o usuário administrativo.

O pacote de atualização fornecido com esta versão automatiza a cópia de segurança do código e não sobrescreve `settings.json`, `history.json` nem `data/`.

## Primeira inicialização após a atualização

Na primeira execução:

- as senhas SSH e credenciais Google existentes são migradas para o formato criptografado;
- `data/master.key` é criado com permissão restrita;
- um código de configuração administrativa é exibido no terminal;
- a interface solicitará esse código para criar o primeiro usuário.

Guarde uma cópia segura de `data/master.key`. Sem essa chave, os segredos criptografados não podem ser recuperados.

## Dependências

As quatro dependências usadas pela versão 1.1.0 já existiam na versão anterior. Em uma atualização sobre a instalação existente, o `node_modules` atual normalmente é suficiente.

Quando houver acesso ao repositório npm, alinhe as dependências com:

```bash
npm ci --omit=dev
```

Não execute esse comando em um servidor sem acesso ao npm antes de confirmar que possui uma cópia funcional do `node_modules`, pois o `npm ci` remove o diretório atual antes da reinstalação.

## Retenção de arquivos antigos

A nova retenção atua somente sobre backups criados pela versão 1.1.0 ou posterior, identificados por propriedades internas no Google Drive. Arquivos gerados por versões anteriores e outros documentos existentes nas pastas são preservados. Caso seja necessário removê-los, faça a revisão manualmente no Drive.

## HTTPS e proxy reverso

Para publicar a aplicação por HTTPS atrás de um proxy reverso, encaminhe `/oauth2callback` para a mesma aplicação e inicie o processo com, por exemplo:

```bash
TRUST_PROXY=1 COOKIE_SECURE=true npm start
```

Cadastre no Google Cloud a mesma URL HTTPS informada no campo **Callback URL**. Para uma URL HTTPS, a aplicação pressupõe que o proxy reverso encaminhará o callback para a porta principal.

## Validação após a atualização

```bash
npm run check
npm test
```

Depois:

1. entre na interface;
2. valide o status do Google Drive;
3. execute um backup pequeno manualmente;
4. confirme tamanho e checksums no histórico;
5. confirme a presença do arquivo no Drive;
6. extraia esse backup em uma área de teste antes de considerar a atualização concluída.

A aplicação testa a estrutura do `.tar.gz`, mas a validação operacional definitiva continua sendo um teste de restauração em diretório isolado.
