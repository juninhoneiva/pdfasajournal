# PDF as Journal

Módulo para Foundry VTT (v12 e v13; alvo principal: 13.351) que importa um PDF e o transforma em um Journal Entry, preservando o máximo possível do layout original.

## O que ele faz

Cada página do PDF vira uma página do journal. O módulo lê o texto com a posição de cada trecho e reconstrói a estrutura:

- **Colunas**: detectadas pelos espaços em branco entre os blocos de texto (corte XY recursivo). Viram uma grade CSS com as mesmas proporções do PDF (modo *Fiel*) ou colunas fluidas (modo *Fluida*). Funciona com 1, 2, 3 ou mais colunas e com títulos ocupando a largura toda acima delas.
- **Títulos**: inferidos pelo tamanho da fonte em relação ao texto do corpo do documento inteiro (h1 a h4).
- **Formatação**: negrito, itálico, sobrescrito, listas com marcadores, capitulares, alinhamento centralizado/à direita e texto menor (legendas, notas).
- **Cabeçalhos e rodapés** repetidos e números de página são removidos.
- **Nomes das páginas**: vêm dos marcadores (sumário) do PDF; na falta deles, do primeiro título da página.
- **Imagens**: extraídas na resolução original, já com rotação e espelhamento aplicados, gravadas em WebP na pasta do mundo.
  - Se a imagem já tem transparência no PDF (canal alfa / SMask), ela é preservada.
  - Se não tem, o fundo liso que toca as bordas é removido (com suavização das bordas). Fotos e ilustrações com moldura são detectadas e ficam como estão.
  - Imagens de fundo de página inteira e ornamentos repetidos em muitas páginas são ignorados (configurável).

## Como usar

Na aba **Journal**, clique em **Importar PDF**, escolha ou arraste o arquivo, ajuste as opções e clique em **Importar**. O PDF é processado no próprio navegador; só as imagens extraídas são enviadas ao servidor.

API para macros:

```js
const api = game.modules.get("pdf-as-journal").api;
api.open(); // abre a janela de importação

const data = await (await fetch("caminho/arquivo.pdf")).arrayBuffer();
await api.importPdf({ data, fileName: "arquivo.pdf", options: { pages: "1-10", columnMode: "grid" } });
```

## Limitações atuais

- PDFs escaneados (só imagem, sem texto) não têm texto a extrair; seria preciso OCR.
- Desenhos vetoriais (mapas, molduras e ícones feitos de linhas) ainda não são capturados; só imagens rasterizadas.
- A cor do texto e as fontes originais não são reproduzidas; o journal usa a tipografia do Foundry/sistema.
- Texto girado (barras laterais verticais) é ignorado.
- Tabelas saem como colunas de texto, não como `<table>`.
- Editar a página no editor do Foundry (ProseMirror) pode simplificar parte do layout das colunas.

## Desenvolvimento

```bash
npm install
npm run vendor     # copia o pdf.js para lib/pdfjs (já versionado no repositório)
npm test           # testes do conversor em Node, com PDFs de exemplo
node tools/preview.mjs arquivo.pdf saida/ [páginas]   # gera saida/index.html para conferir o resultado
python3 tools/make-fixtures.py                        # regenera os PDFs de teste (reportlab + Pillow)
```

- `scripts/core/`: conversor independente do Foundry (extração, layout, imagens, HTML). Roda em Node e no navegador.
- `scripts/foundry/`: janela de importação, upload das imagens e criação do journal.
- `lib/pdfjs/`: pdf.js 5.4.296 (Apache 2.0).

Para publicar uma versão, crie um *release* no GitHub com a tag `vX.Y.Z`; o workflow gera `module.json` e `module.zip`, e o manifesto `https://github.com/juninhoneiva/pdfasajournal/releases/latest/download/module.json` passa a servir para instalar pelo Foundry.
