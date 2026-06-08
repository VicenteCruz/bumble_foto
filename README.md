# Bumble Foto

Uma web app estática e "serverless" (sem backend) que te permite organizar e limpar fotografias localmente com a velocidade e intuição de uma app de encontros. 

Desliza para a direita para **Guardar**, desliza para a esquerda para **Apagar**, e desliza para baixo para criar **Grupos** de fotografias duplicadas ou semelhantes!

## Funcionalidades Principais
* **Gestos de Swipe**: Compatível com rato (arrastar e largar) e atalhos de teclado (Teclas Direcionais / A / D / M).
* **Análise Inteligente de Imagem**: Deteção automática de fotos desfocadas, escuras ou estouradas através de histogramas locais e análise de contraste.
* **Agrupamento Automático**: Identifica fotografias estruturalmente idênticas (via Algoritmo dHash) para fácil agrupamento de "burst shots".
* **Lado-a-Lado**: Compara a fotografia atual e a seguinte rapidamente sem teres de trocar de visualização.
* **Tudo na Tua Máquina**: Usa a _File System Access API_ nativa dos browsers modernos para ler e mover os teus ficheiros sem fazer upload para lado nenhum. 100% privado.

## Como Usar (Hosting Local ou GitHub Pages)
Sendo uma aplicação web puramente estática (HTML, CSS e Vanilla Javascript), não precisas de `npm install` nem de nenhum servidor backend complexo!

Podes usar o Bumble Foto de duas formas:

### 1. Via GitHub Pages (Recomendado)
Podes hospedar isto no GitHub Pages gratuitamente para teres uma App acessível a partir de qualquer computador.
1. Vai às definições (Settings) do teu repositório no GitHub.
2. Clica no separador **Pages** na barra lateral.
3. Em "Build and deployment", seleciona a source como **Deploy from a branch**.
4. Seleciona o branch `main` (ou `master`) e a pasta `/(root)` e clica em **Save**.
5. Em poucos minutos, a app estará disponível num URL seguro (`https://<teu-username>.github.io/bumble_foto`).

> **Aviso:** A funcionalidade de organizar ficheiros no teu computador requer que o URL seja servido via `https://` (o que o GitHub Pages garante automaticamente) para que o browser confie e ative a *File System Access API*.

### 2. Localmente
Abre a pasta do projeto no teu computador e corre um servidor HTTP simples.
Se tiveres Python instalado:
```bash
python -m http.server 8000
```
Se tiveres Node.js instalado:
```bash
npx serve .
```
Depois, abre `http://localhost:8000` (ou a porta correspondente) no Google Chrome ou Microsoft Edge.

## Requisitos
* Google Chrome, Microsoft Edge ou Opera (Browsers baseados em Chromium suportam na perfeição a API de gestão de ficheiros locais).
* Os ficheiros fotográficos originais nunca saem do teu disco.
