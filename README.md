# 🛡️ SSH-GDrive Backup Pro (v12 - Ultimate Edition)

![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Google Drive](https://img.shields.io/badge/Google%20Drive-4285F4?style=for-the-badge&logo=googledrive&logoColor=white)
![PM2](https://img.shields.io/badge/PM2-2B037A?style=for-the-badge&logo=pm2&logoColor=white)
![TailwindCSS](https://img.shields.io/badge/Tailwind_CSS-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white)

O **SSH-GDrive Backup Pro** é uma solução completa e centralizada para automação de backups. O que começou como um script simples evoluiu para uma plataforma robusta com interface web, gerenciamento de múltiplos servidores, agendamento dinâmico e rotação inteligente de arquivos no Google Drive.

---

## 📜 A Evolução do Projeto

Este projeto passou por uma jornada de aprimoramento contínuo para chegar ao estado atual:

1.  **v1 - v3**: Script básico em Node.js com suporte a SSH e upload simples.
2.  **v4 - v6**: Implementação de tolerância a falhas (arquivos dinâmicos/DBs) e correção de travamentos em sessões SSH.
3.  **v7 - v9**: Adição do primeiro Dashboard visual e script de autenticação independente.
4.  **v10 - v11**: Introdução de agendamento dinâmico, histórico de atividades e suporte a autenticação interativa (Keyboard-Interactive).
5.  **v12 (Atual)**: **Unificação Total**. Remoção de arquivos `.env`, centralização de todas as configurações em interface web e lógica de rotação de backups ultra-segura.

---

## 🌟 Funcionalidades Principais

### 🖥️ Interface Web Centralizada
- **Dashboard em Tempo Real**: Monitore o progresso de cada etapa (Compactação, Download, Upload) com barras de status e logs visuais.
- **Gerenciador de Servidores**: Adicione, edite ou remova servidores e pastas de backup sem tocar no código.
- **Painel de Configurações**: Configure sua API do Google, horários de backup e limites de retenção diretamente pelo navegador.

### 🛡️ Robustez e Segurança
- **Tolerância a Arquivos Ativos**: Utiliza flags avançadas no `tar` para garantir que backups de bancos de dados e arquivos em uso não falhem.
- **♻️ Rotação Inteligente**: Mantém apenas a quantidade de backups definida, organizada individualmente por subpastas (`Servidor > Pasta`).
- **⌨️ Interface Inteligente**: O auto-refresh do Dashboard é pausado enquanto você digita, evitando perda de dados.**Conectividade Ampla**: Suporte a múltiplos métodos de autenticação SSH, incluindo servidores modernos que exigem interação por teclado.

### 📅 Automação Total
- **Agendador Dinâmico**: Escolha os dias da semana e o horário exato. O sistema atualiza o cronograma em tempo real sem necessidade de reiniciar.
- **API de Disparo**: Além do automático, dispare backups manuais com um único clique ou via chamada HTTP.

---

## 🚀 Instalação e Início Rápido

### 1. Preparação
```bash
# Clone o repositório
git clone https://github.com/seu-usuario/ssh-gdrive-backup.git
cd ssh-gdrive-backup

# Instale as dependências
npm install
```

### 2. Execução
Recomendamos o uso do PM2 para manter o sistema sempre online:
```bash
pm2 start index.js --name "ssh-backup"
pm2 save
```

### 3. Configuração Inicial
1. Acesse `http://seu-ip:8990`.
2. Vá na aba **Configurações** e insira suas credenciais do Google Cloud (Client ID e Secret).
3. **Autenticação (Importante)**: O Google não permite IPs privados (192.168.x.x).
   - No Google Cloud Console, use o Redirect URI: `http://localhost:3000/oauth2callback`.
   - Se o servidor for remoto, faça um túnel SSH no seu PC: `ssh -L 3000:localhost:3000 usuario@ip-servidor`.
   - No servidor, rode: `node auth.js`.
4. Na aba **Servidores**, cadastre seus hosts e as pastas que deseja proteger.

---

## 📂 Estrutura de Dados
- `settings.json`: Armazena todas as configurações (Google, Servidores, Sistema).
- `history.json`: Log das últimas 100 atividades realizadas.
- `public/`: Frontend moderno construído com Tailwind CSS.

---

## 🤝 Contribuição
Contribuições são o que fazem a comunidade open source um lugar incrível para aprender, inspirar e criar. Qualquer contribuição que você fizer será **muito apreciada**.

1. Faça um Fork do projeto
2. Crie uma Branch para sua Feature (`git checkout -b feature/AmazingFeature`)
3. Commit suas mudanças (`git commit -m 'Add some AmazingFeature'`)
4. Push para a Branch (`git push origin feature/AmazingFeature`)
5. Abra um Pull Request

---

## 📄 Licença
Distribuído sob a licença MIT. Veja `LICENSE` para mais informações.

---
Desenvolvido com ❤️ por **Manus AI** & **João Paulo Vaz**
