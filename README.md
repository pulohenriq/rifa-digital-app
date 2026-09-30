# Sistema de Rifa e Sorteio Serverless
Um sistema completo, seguro e de custo zero para gerenciamento de rifas, reservas de números, pagamentos via Pix (com envio de comprovantes), painel administrativo e interface de sorteio animada.
Construído com HTML/CSS/JS (Vanilla) no frontend (hospedado via GitHub Pages) e Google Apps Script + Google Sheets no backend (banco de dados e API).

# Arquitetura

O sistema funciona de forma "serverless", utilizando os serviços gratuitos do Google como infraestrutura. O frontend nunca acessa a planilha diretamente; toda a comunicação é feita via API com validação e travas de concorrência.

```text
┌──────────────────────────── GitHub Pages (gratuito) ────────────────────────────┐
│  index.html  → comprador: grade de números, carrinho, checkout, Pix, comprovante │
│  admin.html  → organização: login, pedidos, aprovar/recusar, dashboard           │
│  sorteio.html→ palco do sorteio (visual atual), só números PAGOS, exige login    │
└───────────────────────────────┬──────────────────────────────────────────────────┘
                                │ fetch (GET / POST com JSON em text/plain)
┌───────────────────────────────▼──────────────────────────────────────────────────┐
│  Google Apps Script (App da Web, "Executar como: eu")                            │
│  doGet / doPost → roteador de ações → validação → LockService → CacheService     │
└───────┬─────────────────────────────────────┬────────────────────────────────────┘
        │                                     │
┌───────▼──────────────────┐        ┌─────────▼──────────────────────────┐
│ Google Sheets (banco)    │        │ Google Drive (pasta PRIVADA)       │
│ CONFIG · NUMEROS ·       │        │ comprovantes (imagem/PDF), um      │
│ PEDIDOS · LOG            │        │ arquivo por pedido                 │
└──────────────────────────┘        └────────────────────────────────────┘

```

# Principais Funcionalidades e Decisões Técnicas

* **Proteção contra Concorrência (`LockService`):** Duas pessoas clicando no mesmo número no mesmo milissegundo não geram venda dupla. A primeira reserva, a segunda é avisada.
* **Performance via Cache (`CacheService`):** O status da rifa é cacheado por alguns segundos. Com dezenas de pessoas atualizando a tela, a planilha (Sheets) não é sobrecarregada.
* **Privacidade e LGPD:** O endpoint público da grade devolve apenas os números e status. Nomes e telefones ficam restritos ao backend.
* **Compressão de Imagens:** Fotos e prints de comprovantes são redimensionados no próprio navegador (para ~1600px, 100-400KB) antes do envio, garantindo rapidez mesmo em redes móveis (4G) instáveis.
* **Armazenamento Seguro:** Comprovantes contêm dados sensíveis e vão direto para uma pasta privada do Google Drive, sem links públicos.
* **Sorteio Transparente e Criptográfico:** Utiliza `crypto.getRandomValues` para evitar vieses. Gera um *hash* da lista antes do sorteio e registra cada ganhador na aba de LOG para auditoria.

# Ciclo de Vida do Sistema

**Dos Números:**
`DISPONIVEL` ➔ `RESERVADO` ➔ `PAGO` (ou `CANCELADO` / Expirado e volta a ficar disponível).

**Dos Pedidos:**
`AGUARDANDO_PAGAMENTO` ➔ `COMPROVANTE_ENVIADO` (pausa o relógio) ➔ `PAGAMENTO_CONFIRMADO` (ou `RECUSADO` / `EXPIRADO`).

---

# Estrutura do Repositório

```text
rifa/
├── index.html              # Página do comprador (Vitrine, Carrinho, Pix)
├── admin.html              # Painel da tesouraria (Aprovações, Dashboard)
├── sorteio.html            # Palco do sorteio animado
└── assets/
    ├── css/
    │   ├── tema.css        # Cores (creme, vinho, oliva), fontes e bilhetes
    │   ├── comprador.css   # Layout da vitrine
    │   ├── admin.css       # Layout do painel
    │   └── sorteio.css     # Estilos da roleta e telão
    └── js/
        ├── config.js       # Configuração da URL da API
        ├── api.js          # Comunicação com o Apps Script
        ├── sessao.js       # Controle de login (admin/sorteio)
        ├── comprador.js    # Lógica da vitrine
        ├── admin.js        # Lógica do painel
        ├── sorteio.js      # Lógica e animações da roleta
        └── vendor/
            └── qrcode.js   # Gerador de QR Code Pix local (MIT)

```

---

# Guia de Instalação e Configuração

### Passo 1: O Banco de Dados (Google Sheets)

1. Crie uma planilha no Google Sheets chamada `Rifa – Banco de dados`.
2. Vá em **Arquivo › Configurações**, defina localidade como **Brasil** e fuso horário como **(GMT-03:00) São Paulo**.
3. Crie 4 abas com estes nomes exatos: `CONFIG`, `NUMEROS`, `PEDIDOS` e `LOG`.
4. Em cada aba, cole o cabeçalho na linha 1 (célula A1), vá em **Dados › Dividir texto em colunas (Vírgula)**:
* `CONFIG`: `chave,valor,descricao`
* `NUMEROS`: `numero,status,pedido_id,comprador_id,nome_comprador,telefone,valor,data_reserva,data_pagamento`
* `PEDIDOS`: `pedido_id,data,nome,telefone,email,quantidade,numeros,valor_total,forma_pagamento,status_pagamento,comprovante_url,data_expiracao,observacao,token_pedido,congregacao,data_confirmacao`
* `LOG`: `data_hora,acao,pedido_id,numero,usuario,resultado,detalhes`


5. Congele a 1ª linha de todas as abas.
6. Preencha a aba `CONFIG` (na vertical) com suas chaves: `id_rifa`, `valor_numero`, `chave_pix`, etc. (O restante será preenchido automaticamente pelo script).

### Passo 2: Armazenamento de Comprovantes (Google Drive)

1. Crie uma pasta no Google Drive chamada `Rifa – Comprovantes`.
2. O compartilhamento deve ficar como **Restrito**.
3. Copie o **ID da pasta** que aparece na barra de endereço (a parte entre `/folders/` e o fim).

### Passo 3: O Backend (Google Apps Script)

1. Na planilha, vá em **Extensões › Apps Script**.
2. Cole os 8 arquivos do backend (`Config.gs`, `Util.gs`, `Estado.gs`, `Api.gs`, `Publico.gs`, `Admin.gs`, `Pagamento.gs`, `Instalacao.gs`) e atualize o `appsscript.json`.
3. Vá em **Configurações do Projeto (engrenagem)** › **Propriedades do script** e adicione:
* `ADMIN_SENHA`: Crie uma senha forte (ex: `rifa-segura-2026`).
* `PASTA_COMPROVANTES_ID`: Cole o ID da pasta do Drive.


4. Rode a função `instalar()`. Dê as permissões necessárias. Isso criará os números na aba `NUMEROS` e configurará os formatos.
5. Rode a função `diagnostico()` para testar a comunicação e gerar um Pix de teste.
6. Vá em **Implantar › Nova implantação** › Tipo: **App da Web**.
* Executar como: **Eu**.
* Quem tem acesso: **Qualquer pessoa**.


7. Copie a **URL do Web App** (termina em `/exec`).
* *Atenção:* Toda vez que alterar o código `.gs`, vá em **Gerenciar implantações › Editar › Nova versão**. Não crie uma implantação do zero.



### Passo 4: O Frontend (GitHub Pages)

1. Faça um Fork ou clone este repositório.
2. Abra o arquivo `assets/js/config.js`.
3. Substitua a constante com a **URL do Web App** copiada no Passo 3.
4. Ative o **GitHub Pages** nas configurações do repositório (`Settings > Pages > Deploy from branch: main`).
5. Seu site estará online em `[https://seu-usuario.github.io/rifa/](https://seu-usuario.github.io/rifa/)`!

---

# Identidade Visual

O sistema mantém uma paleta elegante e legível:

* **Creme:** `#f4e6d8` (Fundo)
* **Vinho:** `#941b1d` / `#6a1314` (Destaques e botões)
* **Salmão:** `#d18a7c` (Apoio)
* **Oliva:** `#5b6e3f` (Sucesso/Livres)
* **Dourado:** `#f0a839` (Seleção ativa)
* **Fontes:** Archivo e Karla (via Google Fonts).

## ⚠️ Limites Operacionais (Plano Google Gratuito)

Este sistema usa as cotas gratuitas do Google Workspace. O sistema é muito robusto para escalas locais/regionais graças ao sistema de Cache implementado, suportando centenas de números e dezenas de usuários simultâneos tranquilamente. Contudo, evite divulgações virais massivas (milhares de acessos por segundo), pois o Google pode limitar as execuções (limite aproximado: 30 execuções simultâneas).
