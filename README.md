# 3D Mesh Downloader

Extensão Chrome (Manifest V3) que **exporta a cena 3D de qualquer página para `.obj`**.

Não é um "download de assets": ela intercepta a cena Three.js que está sendo renderizada
na página e reconstrói a geometria (posição, normais, UVs, materiais e transformações de
objeto) em um arquivo Wavefront OBJ.

Baseado na extensão original [`bopjesvla/3d-downloader`](https://github.com/bopjesvla/3d-downloader)
(Chrome Web Store: *"3D Model Downloader"*, ID `gbdaimhoibipdfjcejfnhjiiipglfolf`).
Esta versão é uma reimplementação com as correções descritas em [docs/ANALISE.md](docs/ANALISE.md).

---

## Instalação

### Como extensão descompactada (desenvolvimento)

```bash
npm run build
```

Depois:

1. Abra `chrome://extensions`
2. Ative **Modo do desenvolvedor**
3. Clique em **Carregar sem compactação** e escolha a pasta `dist/`

### Empacotar como `.crx` (para distribuir)

O próprio Chrome gera o pacote assinado:

```bash
"C:\Program Files\Google\Chrome\Application\chrome.exe" --pack-extension=D:\Projetos\3d-mesh-downloader\dist
```

O Chrome cria `dist.crx` e `dist.pem` (guarde o `.pem` — é a chave que mantém o ID fixo).

### Publicar na Chrome Web Store

`npm run build` gera `release/3d-mesh-downloader-<versão>.zip` com o `manifest.json` na raiz,
pronto para upload no [Painel do Desenvolvedor](https://chrome.google.com/webstore/devconsole).

---

## Uso

1. Abra uma página que renderiza 3D com Three.js
2. Clique no ícone da extensão → o contador mostra quantas malhas foram capturadas
3. Ajuste as opções e clique em **Baixar malhas**
4. Os arquivos `.obj` (e `.mtl`) caem na pasta de downloads

> A extensão só captura cenas **construídas depois** que ela é injetada. Se o contador
> ficar em `0`, recarregue a página (F5).

### Formatos de saída

O seletor **Formato do arquivo** no popup escolhe o que é gravado:

| Formato | O que acontece |
|---|---|
| **OBJ (+ .mtl)** | `.obj` com `v`/`vt`/`vn`/`f` + `.mtl` com materiais, cores e texturas referenciadas |
| **STL binário** | A geometria é convertida **no navegador** e o `.stl` é gravado direto — o `.obj` nunca é criado. Formato ideal para impressão 3D |
| **STL ASCII** | Idêntico, mas em texto (legível, ~40% maior) |

A conversão STL acontece dentro da página, em memória:

- todos os modelos são fundidos em uma **sopa de triângulos** (STL é malha única);
- cada facet recebe a **normal calculada a partir dos seus três vértices**
  (STL não guarda normal por vértice);
- **triângulos degenerados** (área zero) são descartados;
- o arquivo binário sai com o layout padrão: 80 bytes de cabeçalho + contagem de
  4 bytes + 50 bytes por facet.

O tamanho estimado de cada modelo no filtro também acompanha o formato escolhido
(`84 + 50 × triângulos` para o STL binário), então filtrar por KB faz sentido em
qualquer formato.

No modelo real do Tripo (352.853 faces): **OBJ 36,5 MB → STL 16,8 MB**.

### Opções de exportação

| Opção | Padrão | Efeito |
|---|---|---|
| Aplicar transformações do objeto | ligado | Exporta em espaço de mundo (`matrixWorld`), com posição/rotação/escala |
| Exportar normais (`vn`) | ligado | Usa o atributo de normal; se faltar, calcula normal planar e expande os vértices |
| Exportar UVs (`vt`) | ligado | Exporta o atributo `uv` quando existir |
| Expandir `InstancedMesh` | ligado | Uma malha por instância, aplicando a matriz de cada uma |
| Exportar materiais (`.mtl`) | ligado | Gera `newmtl`, `Kd`, `Pr`, `Pm` e `map_Kd` |
| Unir tudo em um único `.obj` | ligado | **1 `.obj` + 1 `.mtl`** em vez de N downloads (contorna o limite do Chrome) |

### Filtro por nome e por tamanho

O popup lista **cada malha encontrada** com nome, vértices, faces e tamanho estimado,
e permite filtrar antes de exportar:

| Controle | Efeito |
|---|---|
| Campo de texto | Casa o nome do modelo, o nome da cena e o nome do material (case-insensitive) |
| `min KB` / `max KB` | Filtra pelo tamanho estimado do `.obj` que a malha produziria |
| Checkbox por modelo | Seleção explícita: exporta só o que estiver marcado |
| `Todos` / `Nenhum` / `Só os visíveis` | Atalhos para a seleção |

O filtro é aplicado **no navegador** (no `injected.js`), então o que sai no download
já é o que foi filtrado. As opções chegam ao script da página por `window.postMessage`
e são validadas de novo lá — o popup nunca envia dados do modelo, só uma lista de ids.

Exemplo real (página do Tripo3D, 68 malhas):

| Filtro | Resultado |
|---|---|
| texto `skeleton` | 2 malhas — 360 faces |
| `max 50 KB` | 66 malhas — 3.833 faces |
| `min 5000 KB` | 1 malha — 340.956 faces (34 MB) |
| sem filtro | 68 malhas — 352.853 faces (36,5 MB) |

---

## Arquitetura

```
popup.js  ──chrome.tabs.sendMessage──▶  content.js (contexto isolado)
                                            │ window.postMessage
                                            ▼
                                          injected.js (world: MAIN, document_start)
                                            │ hooks do three.js
                                            ▼
                              cena capturada → .obj (+ .mtl)
```

| Arquivo | Papel |
|---|---|
| `src/injected.js` | Roda no contexto da página. Instala os hooks, percorre o grafo de cena e escreve o OBJ |
| `src/content.js` | Ponte isolada ↔ página. Não toca em dados da página |
| `src/background.js` | Service worker: localiza a aba alvo de um deep link sem a permissao `tabs` |
| `src/popup.html` / `src/popup.js` | Interface: contador, opções, disparo do download |
| `src/manifest.json` | MV3, permissão `activeTab`, content scripts em `<all_urls>` |

### Como a cena é capturada

Três camadas de hook, nesta ordem de prioridade:

1. **`window.__THREE_DEVTOOLS__`** — o three.js dispara `CustomEvent('observe')`:
   - `detail = Scene` → cena capturada direto (funciona em **todas** as versões testadas, r150 → r181)
   - `detail = Renderer` → o renderizador é instrumentado
2. **`renderer.render(scene, camera)`** — instrumentado na instância e em
   `THREE.WebGLRenderer.prototype` (builds UMD que expõem `THREE` global).
   É a rede de segurança para builds/frameworks que nunca despacham `observe`.
3. **`window.THREE`** — instalado como *accessor* para que a página não sobrescreva o hook
   silenciosamente; reconferido a cada 500 ms durante os primeiros 15 s.

O `__THREE_DEVTOOLS__` da extensão é instalado como *accessor* (`Object.defineProperty`),
então uma página que defina o próprio valor **não** consegue roubar o hook — o valor da
página é capturado e nossos listeners são anexados a ele.

### Nenhuma dependência do namespace three.js

Toda a matemática de matriz (multiplicação 4×4, aplicação em ponto, *normal matrix*
= transposta da inversa do 3×3) está implementada do zero em `src/injected.js`.
Isso mantém a extensão funcionando em qualquer versão do three.js, inclusive as mais novas.

---

## Diferenças em relação à extensão original

| | Original (v1.0.0) | Aqui (v2.0.0) |
|---|---|---|
| Transformações | ignoradas (espaço local) | aplicadas via `matrixWorld` |
| Normais | não exporta | exporta `vn`; calcula planar quando falta |
| UVs | não exporta | exporta `vt` |
| Materiais | não exporta | gera `.mtl` com cor, rugosidade, metalicidade e textura |
| Espaço de cor | — | converte de linear (padrão do three.js) para **sRGB** no `.mtl` |
| `InstancedMesh` | exporta só a geometria base | expande uma malha por instância |
| `SkinnedMesh` | exporta pose bind | exporta a pose deformada (skinning) |
| Nº de downloads | 1 por malha (Chrome corta ~10) | 1 `.obj` + 1 `.mtl` |
| Nome do arquivo | `mesh.name` cru | saneado e único |
| Sobrevive a `__THREE_DEVTOOLS__` da página | não (era sobrescrito) | sim |
| Avisos | `alert()` | status no popup |

---

## Testes

### Unitários (Node)

```bash
npm test
```

A suíte roda o `src/injected.js` **real** dentro de um contexto `vm` do Node com DOM
mockado (`test/harness.js`) e cenas Three.js simuladas (`test/mock-three.js`).

Cobre: captura de cena, transformações (com e sem), normais (atributo e planar),
UVs, expansão de instâncias, skinning, materiais, modo por-malha, índices das faces
e robustez (página sem cena, página que define o próprio `__THREE_DEVTOOLS__`).

```
45 passed, 0 failed
```

### Integração (navegador real)

```bash
npm run test:browser
```

Abre `http://127.0.0.1:8731/test/browser-check.html?v=0.180.0`. A página carrega o
**three.js de verdade** do CDN, injeta o `src/injected.js` **antes** dele (como a
extensão faz em `document_start` / `world: MAIN`) e intercepta os downloads para
inspecionar o OBJ gerado — sem gravar nada.

Verificado com sucesso em:

| three.js | build | resultado |
|---|---|---|
| 0.160.0 | `three.module.js` (arquivo único) | 1 cena, 1 malha, 24 v / 24 vn / 24 vt / 12 f |
| 0.171.0 | `three.core.js` + `three.module.js` (a partir do r167) | idem |
| 0.180.0 | `three.core.js` + `three.module.js` | idem |

Nos três casos o primeiro vértice sai em `(8, 22, 32)` - o valor correto para
`BoxGeometry(2,2,2)` com `position (10,20,30)`, `rotation.z = 90°` e `scale 2`,
confirmando a aplicação da `matrixWorld`.

### Pagina de demonstracao local

`test/demo.html` monta uma cena com 9 modelos de nomes e tamanhos diferentes
(caixa, esfera, toro, cilindro, cone, toro-nó detalhado, icosaedro, plano e uma
grade de 40 instancias) e traz um painel com os mesmos filtros do popup, para
testar offline sem depender de nenhum site:

```bash
npm run test:browser
# abre http://127.0.0.1:8731/test/demo.html
```

### Teste em navegador real (Chrome + CDP)
O `tools/` traz um cliente CDP próprio (`tools/cdp.js`), sem dependências, para
dirigir um Chrome real:

```bash
# 1. sobe uma instancia de teste (perfil proprio em .chrome-debug)
powershell -ExecutionPolicy Bypass -File tools\relaunch-debug-chrome.ps1

# 2. dispara uma exportacao e observa os eventos de download
node tools\cdp-download-test.js
```

> O `--remote-debugging-port` é ignorado pelo Chrome 136+ quando se usa o perfil
> padrão, por isso a instância de teste usa um `--user-data-dir` próprio.
> A extensão é instalada por `Extensions.loadUnpacked` (CDP), já que o Chrome
> de marca ignora `--load-extension`.

Validado em <https://studio.tripo3d.ai/workspace/generate/white-fluffy-dog-with-pink-bow-843c95e3-2c89-4ac4-997c-15a119fd0ea7>
(three.js **r183**, 182.412 vértices / 340.956 faces):

- a extensão capturou **68 malhas em 5 cenas**, e o modelo principal bate
  exatamente com o contador da própria página (182.412 vértices / 340.956 faces);
- a exportação completa gerou um `.obj` de **36,5 MB** (190.427 vértices,
  352.853 faces, 21 materiais) + um `.mtl`;
- os quatro filtros (texto, tamanho mín/máx, seleção explícita) produziram
  exatamente os conjuntos esperados.

Esse teste real encontrou um bug que os testes sintéticos não pegavam — ver
[docs/ANALISE.md](docs/ANALISE.md).

---

## Privacidade

- Nenhuma requisição de rede, nenhum analytics, nenhum dado enviado a lugar nenhum.
- Permissão declarada: apenas `activeTab`. Content scripts em `<all_urls>` (necessário
  para rodar antes do three.js da página).
- O `.obj` gerado fica **no seu disco**; nada sai do navegador.

## Limitações conhecidas

- Apenas Three.js. Other engines (Babylon.js, PlayCanvas) não são suportadas.
- Morph targets são ignorados.
- `WebGPURenderer` não é instrumentado (só expõe `render`, sem `observe`).
- Materiais complexos (shader nodes, PBR completo) viram um `.mtl` simplificado; as
  texturas são apenas **referenciadas por URL**, não baixadas.
