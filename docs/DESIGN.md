# Arquitetura e decisões de projeto

Documento de referência do **3D-Mesh-Downloader**. Cobre como a cena é capturada,
como os arquivos são gerados, e as decisões que moldaram o código.

---

## Visão geral

```
┌─ popup.js ─────────────┐   chrome.tabs.sendMessage
│  contador, filtros,    │──────────────────────────┐
│  lista de exclusão,    │                          │
│  seleção, formato     │                          ▼
└────────────────────────┘              ┌─ content.js ──────────┐
                                        │  contexto isolado     │
                                        └───────────┬───────────┘
                                                    │ window.postMessage
                                                    ▼
                                        ┌─ injected.js ─────────┐
                                        │  world: MAIN          │
                                        │  hooks do three.js    │
                                        │  escrita do .obj/.stl │
                                        └───────────┬───────────┘
                                                    │
                                              cena three.js
```

| Arquivo | Papel |
|---|---|
| `src/injected.js` | Roda no contexto da página. Instala os hooks, percorre o grafo de cena e escreve o arquivo |
| `src/content.js` | Ponte entre o popup e a página. Também responde `MDL_WHERE` (o `location.href` da própria aba) |
| `src/background.js` | Service worker: localiza a aba alvo de um deep link **sem** a permissão `tabs` |
| `src/popup.html` / `src/popup.js` | Interface: contador, filtros, lista de exclusão, seleção, formato |
| `src/manifest.json` | MV3, permissões `activeTab` + `storage`, content scripts em `<all_urls>` |

---

## Como a cena é capturada

Três camadas de hook, em ordem de prioridade:

### 1. `window.__THREE_DEVTOOLS__`

O three.js dispara `CustomEvent('observe')`:

- `detail = Scene` → a cena é capturada direto;
- `detail = Renderer` → o renderizador é instrumentado.

O hook é instalado como **accessor** (`Object.defineProperty`), com getter e
setter. Se a página definir o próprio `__THREE_DEVTOOLS__` depois, o valor dela
é capturado e os listeners são anexados a ele — a página **não consegue roubar
o hook**.

### 2. `renderer.render(scene, camera)`

Instrumentado na instância e em `THREE.WebGLRenderer.prototype`. É a rede de
segurança para builds ou frameworks que nunca despacham `observe`.

Funciona mesmo aplicado **depois** do renderizador existir, porque
`render` é método de protótipo e a instância não tem cópia própria.

### 3. `window.THREE`

Instalado como accessor também, e reconferido a cada 500 ms durante os
primeiros 15 s — alguns sites definem `var THREE = ...`, o que substitui o
accessor por uma propriedade comum.

### Nenhuma dependência do namespace three.js

Toda a matemática de matriz está implementada do zero em `src/injected.js`:

- multiplicação 4×4 (layout *column-major*, igual ao `Matrix4.elements`);
- aplicação em ponto, com divisão por `w`;
- **normal matrix** = transposta da inversa do 3×3 superior.

Isso mantém a extensão funcionando em qualquer versão do three.js, inclusive
as mais novas, e evita depender de `window.THREE` (que muitos sites não expõem).

### Nota sobre versões do three.js

O `Scene` despacha `observe` em **todas** as versões verificadas, de r150 a
r181. A checagem é sutil porque, a partir do **r167**, o build foi dividido em
`three.core.js` + `three.module.js` — e o `Scene` passou a viver no
`three.core.js`. Ler só o `three.module.js` dá a impressão errada de que o
despacho desapareceu.

---

## Como o arquivo é gerado

### Pipeline

```
jobs (malhas selecionadas)
   └─ extractModel()   → posições em espaço de mundo + normais + UVs + faces por material
        └─ collectTriangles()  → sopa de triângulos (só para STL)
             ├─ buildOBJ()      → .obj (+ .mtl)
             └─ buildBinarySTL() / buildAsciiSTL()
```

### OBJ

- `v` / `vt` / `vn` / `f` com índices **globais** (padrão da spec);
- `o <nome>` por modelo, com nomes únicos (`X`, `X_1`, `X_2`…);
- `usemtl` por grupo de materiais;
- `.mtl` separado com `newmtl`, `Kd`, `Pr`, `Pm` e `map_Kd`.

### STL

A conversão acontece **no navegador**, em memória — o `.obj` nunca é criado.

- todos os modelos são fundidos numa sopa de triângulos (STL é malha única);
- cada facet recebe a normal calculada a partir dos seus três vértices;
- **triângulos degenerados** (área zero) são descartados;
- layout binário padrão: 80 bytes de cabeçalho + 4 bytes de contagem + 50 bytes
  por facet.

No modelo real do Tripo (352.853 faces): **OBJ 36,5 MB → STL 16,8 MB**.

### Espaço de cor

O three.js guarda `Material.color` em espaço **linear** (quando o color
management está ligado, que é o padrão). O `.mtl` espera **sRGB**, então a
conversão é feita com `Color.getHexString('srgb')`, com fallback manual
(`linear → sRGB`) para cores sem esse método.

---

## Filtros, seleção e exclusão

| Conceito | Onde é aplicado | Como |
|---|---|---|
| Filtro por texto | página + popup | nome do modelo, da cena e dos materiais |
| Filtro por tamanho | página + popup | estimativa **por formato** (`84 + 50 × triângulos` no STL) |
| Seleção explícita | página | lista de ids enviada no `include` |
| **Lista de exclusão** | página | padrões de nome, persistidos em `chrome.storage.local` |

O popup e a página usam **a mesma** regra e **os mesmos** números, então
"filtrar por 500 KB" significa a mesma coisa dos dois lados.

A exclusão tem **prioridade sobre a seleção**: um modelo excluído nunca entra
no arquivo, mesmo que esteja marcado.

O padrão de exclusão é testado contra três nomes de cada malha:

1. o nome original (`X`);
2. o nome que ela recebe no arquivo exportado (`X_1`);
3. esse nome sem o sufixo.

Por isso `X*` pega a família inteira e `X_1` pega só o segundo.

### Padrões de curinga

| Padrão | Casa com |
|---|---|
| `X*` | `X`, `X_1`, `X_2`, `XY`, `XYZ`… |
| `X_*` | só os que exportam como `X_1`, `X_2` |
| `X_1` | exatamente o segundo `X` |
| `X?` | `X` + exatamente um caractere |
| `cube` | nome exato (sem curinga) |

Padrões inválidos são ignorados, sem quebrar a exportação.

---

## Decisões de projeto

### Sem a permissão `tabs`

O deep link do popup (`popup.html?url=...`) precisa achar a aba alvo. Sem a
permissão `tabs`, `tab.url` chega vazio — e adicionar essa permissão mostraria
"ler seu histórico de navegação" na loja.

A solução: o service worker pergunta às próprias content scripts o
`location.href` delas (`chrome.tabs.sendMessage(tabId, {type: 'MDL_WHERE'})`).
Nenhuma permissão extra, nenhuma leitura de histórico.

A comparação não é por substring: a URL guardada pode envelhecer quando um SPA
troca de rota (`/workspace/generate/<id>` → `/workspace/segmentation/<id>`).
O `scoreMatch()` pontua os candidatos do mais forte para o mais fraco:

| Pontuação | Critério |
|---|---|
| 100 | mesmo `pathname` (o hash do deep link é ignorado) |
| 80 | mesmo último segmento — o id do modelo, mesmo com a rota trocada |
| 60 | um caminho é prefixo do outro |
| 40 | o último segmento aparece em qualquer posição do caminho |
| 0 | outra origem (nunca casa) |

A aba com maior pontuação vence. Foi o teste real que revelou o problema: o
popup abria com 68 malhas e, minutos depois, o download falhava com "não foi
possível acessar a aba ativa", porque o app tinha mudado de rota e a URL do deep
link deixara de casar.

### Popup em abas

A interface segue o modelo de abas do Chrome — faixa com favicon e rótulo, aba
ativa na cor do conteúdo e as "cortinas" côncavas ligando a aba ao painel:

| Aba | Conteúdo |
|---|---|
| Modelos | contador, filtros, atalhos de seleção, lista |
| Exclusão | padrões, ajuda e prévia do que está sendo excluído |
| Exportar | formato e opções |

As abas são `role="tab"`/`role="tabpanel"` com `aria-selected` e navegação por
`←`/`→` e `1`–`3`. A aba ativa é gravada em `chrome.storage.local`: o popup
reabre onde o usuário parou, como o Chrome restaura a última aba.

O botão de download e o status ficam **fora** do painel, para continuarem
visíveis em qualquer aba. Os badges mostram a seleção atual e o número de
padrões ativos — informação que muda com o uso, não decoração.

### `storage` em vez de sincronização

A lista de exclusão é local do navegador (`chrome.storage.local`). Ela não
contém nada sensível e não precisa viajar entre máquinas.

### Download dentro da página

O `.obj`/`.stl` é gerado com `Blob` + `<a download>` **no contexto da página**,
e não pela API `chrome.downloads`. Isso dispensa a permissão `downloads` — e
como a conversão acontece no navegador, o arquivo nunca passa pelo disco em
formato intermediário.

### Um arquivo só

A exportação combinada (1 `.obj` + 1 `.mtl`, ou 1 `.stl`) contorna o limite de
downloads múltiplos do Chrome, que corta downloads automáticos depois de ~10
arquivos.

---

## Bugs encontrados durante o desenvolvimento

### `InstancedMesh` com zero instâncias

Um `InstancedMesh` com `instanceMatrix.count === 0` era **descartado em
silêncio**: o laço de expansão não executava e o `return` seguinte pulava a
malha inteira.

Foi encontrado no teste com navegador real (o esqueleto do Tripo é um
`InstancedMesh` sem instâncias): a exportação entregava 66 malhas em vez de 68
— exatamente as duas que sumiam — e os filtros que só selecionavam essas duas
devolviam "nenhuma malha encontrada".

**Correção:** com `total === 0`, a malha base é exportada (é o que ela de fato
renderiza), e a contagem de instâncias relatada no popup passa a ser 1.

**Lição:** `InstancedMesh` não é sinônimo de "malha instanciada" — o
`isInstancedMesh` continua verdadeiro mesmo quando a malha é usada como
geometria comum, e o `count` pode ser 0.

### `__THREE_DEVTOOLS__` roubado pela página

A primeira versão sobrescrevia o global da página. Uma página que definisse o
seu próprio `__THREE_DEVTOOLS__` (ou usasse um inspector) quebraria o hook.
Resolvido com o accessor descrito acima.

### Cores em espaço linear

O `.mtl` saía com as cores convertidas duas vezes (o three.js já entrega
linear). Corrigido com `getHexString('srgb')`.

### `tab.url` vazio no deep link

Descrito acima — resolvido com o service worker.

---

## Validação

### Testes unitários

```bash
npm test
```

A suíte roda o `src/injected.js` **real** dentro de um contexto `vm` do Node,
com DOM mockado (`test/harness.js`) e cenas Three.js simuladas
(`test/mock-three.js`).

Cobre: captura de cena, transformações, normais (atributo e planar), UVs,
expansão de instâncias, skinning, materiais, STL binário e ASCII, exclusões,
filtros, seleção, índices das faces e robustez.

### Teste de integração com three.js real

`test/browser-check.html` carrega o three.js do CDN, injeta o `src/injected.js`
**antes** dele (como a extensão faz em `document_start` / `world: MAIN`) e
inspeciona o OBJ gerado.

Validado com r160 (build único), r171 e r180 (build dividido).

### Teste em navegador real (Chrome + CDP)

O `tools/` traz um cliente CDP próprio, sem dependências, para dirigir um
Chrome real:

```bash
powershell -ExecutionPolicy Bypass -File tools\relaunch-debug-chrome.ps1
node tools\cdp-download-test.js
```

> O `--remote-debugging-port` é ignorado pelo Chrome 136+ quando se usa o perfil
> padrão, por isso a instância de teste usa um `--user-data-dir` próprio.
> A extensão é instalada por `Extensions.loadUnpacked` (CDP), já que o Chrome
> de marca ignora `--load-extension`.

Validado em <https://studio.tripo3d.ai/workspace/generate/white-fluffy-dog-with-pink-bow-843c95e3-2c89-4ac4-997c-15a119fd0ea7>
(three.js **r183**, 182.412 vértices / 340.956 faces):

| Verificação | Resultado |
|---|---|
| Extensão injetada / hook ativo | sim / sim |
| Malhas capturadas | 68 em 5 cenas |
| Modelo principal | 182.412 vértices, 340.956 faces — **idêntico ao contador da página** |
| Exportação completa | `.obj` de 36,5 MB (190.427 v, 352.853 f, 21 materiais) + `.mtl` |
| STL binário | 16,8 MB, 352.853 facetas, 0 normais fora de unidade |
| Filtro texto `skeleton` | 2 malhas, 360 faces |
| Filtro tamanho `max 50 KB` | 66 malhas, 3.833 faces |
| Filtro tamanho `min 5000 KB` | 1 malha, 340.956 faces |
| Seleção explícita (`s0_m0`) | 1 malha, 340.956 faces |
| Exclusão `X*`, `Y*`, `Z*`, `skeleton-*` | 12 malhas, 349.673 faces |

A página define `window.__THREE__ = "183"` e **não** expõe `window.THREE` — ou
seja, o namespace não é global, e a extensão funciona só pelo hook
`__THREE_DEVTOOLS__`. Isso confirma que o hook é o caminho essencial e que o
patch em `renderer.render` é mesmo a rede de segurança necessária.

Os downloads foram verificados pelos eventos `Browser.downloadWillBegin` /
`Browser.downloadProgress` do CDP, com `Browser.setDownloadBehavior` apontando
para uma pasta local.

---

## Privacidade

- Nenhuma requisição de rede, nenhum analytics, nenhum dado enviado a lugar nenhum.
- Permissões: `activeTab` (acesso à aba quando o usuário invoca a extensão) e
  `storage` (a lista de exclusão, local).
- Content scripts em `<all_urls>` — necessário para injetar antes do three.js
  da página.
- O arquivo gerado fica **no disco do usuário**; nada sai do navegador.
