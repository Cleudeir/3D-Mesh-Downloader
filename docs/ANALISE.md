# Análise da extensão original "3D Mesh Downloader"

> Documento de referência do **projeto reproduzido** (`3d-mesh-downloader` v2.0.0).
> Descreve a extensão original (`bopjesvla/3d-downloader`, v1.0.0) e os problemas
> que motivaram a reimplementação.

## Identificação

| | |
|---|---|
| Nome na loja | **3D Model Downloader** |
| Nome interno (popup) | **3D Mesh Downloader** |
| ID | `gbdaimhoibipdfjcejfnhjiiipglfolf` |
| Versão | 1.0.0 (publicada em 16/fev/2026) |
| Desenvolvedor | `bopjesvla` — não identificado como comerciante |
| Usuários / nota | ~4.000 · 4,5 ★ (13 avaliações) |
| Tamanho | 17,8 KiB |
| Manifest | MV3 · `activeTab` · content scripts em `<all_urls>` · `world: "MAIN"` |
| Repositório | <https://github.com/bopjesvla/3d-downloader> |
| Issue aberta | [#1 — "only download 10 files"](https://github.com/bopjesvla/3d-downloader/issues/1) |

## Procedência do código analisado

| Artefato | Origem |
|---|---|
| `github/` | `codeload.github.com/bopjesvla/3d-downloader` (branch master) |
| `chrome-store-crx/` | CRX3 extraído do serviço de atualização do Chrome (`clients2.google.com/service/update2/crx`) |
| `3d-mesh-downloader-1.0.0.crx` | CRX3 original (18.238 bytes; header 1.309 + zip 16.917) |

### Diff GitHub ↔ Chrome Web Store

Todos os arquivos `.js`, `.html` e `.png` são **byte-idênticos** (SHA-256 conferido).
As únicas diferenças são de empacotamento:

- `manifest.json` — GitHub: `"name": "3D Mesh Downloader"`; loja: `"3D Model Downloader"` + `"update_url"`
- A loja acrescenta `description.txt` (texto da página) e `icons.html` (artefato de
  desenvolvimento — um gerador de ícones de 9,7 KB que ficou no pacote; não é referenciado
  pelo manifest e não é executado)
- `_metadata/verified_contents.json` — hashes do pacote assinados pelo Chrome Web Store

**Conclusão: o repositório público é fiel ao binário distribuído. Não há código oculto.**

---

## Arquitetura original

```
popup.js  ──chrome.tabs.sendMessage──▶  content.js (contexto isolado)
                                            │ window.postMessage({type:'…'})
                                            ▼
                                          injected.js (world: MAIN, document_start)
                                            │ window.__THREE_DEVTOOLS__ (EventTarget)
                                            ▼
                                    three.js  →  collectMeshes()  →  exportMeshToOBJ() → .obj
```

1. **`injected.js`** cria `window.__THREE_DEVTOOLS__ = new EventTarget()` antes dos scripts da página.
2. O construtor `Scene` do three.js dispara `new CustomEvent('observe', { detail: this })`;
   a extensão captura a cena (`collectedScenes.push(scene)`).
3. **`collectMeshes()`** percorre `children` recursivamente e coleta tudo com `isMesh === true`.
4. **`exportMeshToOBJ()`** gera o `.obj` à mão (`v`/`f`) e dispara o download via
   `Blob` + `<a download>` **dentro da página** — por isso não é necessária a permissão `downloads`.
5. **`content.js`** é apenas uma ponte entre `chrome.runtime` e `window.postMessage`.

---

## Problemas encontrados

### 1. Transformações do objeto são ignoradas — severidade alta

O OBJ exportado usa `geometry.attributes.position` cru, ou seja, coordenadas de **espaço local**.
Não há `updateMatrixWorld()` nem aplicação de `matrixWorld`.

Comprovado com um harness que executa o `injected.js` real: uma malha com
`position {100,50,-25}`, `rotation {0.5,0,0}` e `scale {2,2,2}` gera

```
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
```

O transform some completamente — no Blender todos os objetos ficam sobrepostos na origem.

### 2. Só posição e faces — severidade média

O `.obj` gerado não tem `vn` (normais), `vt` (UVs), `usemtl`, `mtllib` nem cores de vértice.
Texturas e materiais são perdidos: o resultado importa no Blender como geometria cinza.

### 3. `InstancedMesh` e `SkinnedMesh` exportados incorretamente — severidade média

`InstancedMesh extends Mesh` e `SkinnedMesh extends Mesh`, portanto ambos têm
`isMesh === true` e são capturados — mas o exportador só lê a geometria base:

- `InstancedMesh`: as N matrizes de instância (`instanceMatrix`) são ignoradas → todas as
  cópias viram uma.
- `SkinnedMesh`: a malha sai na pose *bind*, sem a deformação do rig.

### 4. Limite de downloads do Chrome — severidade média

`downloadAllMeshes()` dispara **um download por malha**, em loop síncrono. O Chrome bloqueia
downloads múltiplos automáticos (pede permissão na barra de endereço e corta depois de ~10
arquivos). É exatamente a issue [#1](https://github.com/bopjesvla/3d-downloader/issues/1),
ainda aberta: *"I can only download 10 files in the end, with many files missing"*.

### 5. Sobrescreve `window.__THREE_DEVTOOLS__` em todo site — severidade média

O content script roda em `<all_urls>`, então a extensão **sobrescreve** o global
`__THREE_DEVTOOLS__` em 100% das páginas. Sites que definem o próprio global (ou usam o
three.js inspector) têm o hook clobbered, e não há como desativar por domínio.

### 6. Assumindo triângulos — severidade baixa

O laço de faces indexadas avança de 3 em 3, o que quebra com `LineSegments`, `Points` e `Line`
(esses ainda passam pelo filtro `isMesh`).

### 7. Nome de arquivo sem sanitização — severidade baixa

`${mesh.name}_${Date.now()}_${index}.obj` usa `mesh.name` cru. Nomes com `/`, `:` ou caracteres
do SO podem falhar ou criar caminhos inesperados; o `Date.now()` torna o download não-idempotente.

### 8. `URL.revokeObjectURL` prematuro — severidade baixa

A URL do blob é revogada 1000 ms depois do clique; para arquivos grandes a leitura pode ser
interrompida.

### 9. `alert()` e `postMessage` de origem não validada — severidade baixa

O `injected.js` escuta mensagens validando `event.source === window` mas **sem validar
`event.origin`**; qualquer script da própria página pode disparar `DOWNLOAD_ALL_MESHES`
(o que a página já poderia fazer sozinha). O `content.js` retransmite para a página com alvo `'*'`.

### 10. Polling agressivo no popup — severidade baixa

`popup.js` faz `setInterval(requestMeshCount, 3000)`: a cada 3 s uma mensagem trafega
popup → content → página.

---

## Investigação: compatibilidade com versões do three.js

Este ponto foi **inicialmente analisado de forma incorreta** e corrigido depois.

O three.js passou a dividir o build em `three.core.js` + `three.module.js` a partir do
**r167**. Como `Scene` passou a viver em `three.core.js`, uma verificação que só lia
`three.module.js` dava a impressão de que o despacho `observe` tinha sumido a partir do r171.

Verificando os **dois** arquivos em cada versão, o quadro real é:

| versão | build | `Scene` despacha `observe`? |
|---|---|---|
| 0.150.0 | `three.module.js` | **sim** |
| 0.160.0 | `three.module.js` | **sim** |
| 0.165.0 | `three.module.js` | **sim** |
| 0.166.0 | `three.module.js` | **sim** |
| 0.167.0 | `three.module.js` | **sim** |
| 0.170.0 | `three.module.js` | **sim** |
| 0.171.0 | `three.core.js` + `three.module.js` | **sim** |
| 0.172.0 | `three.core.js` + `three.module.js` | **sim** |
| 0.175.0 | `three.core.js` + `three.module.js` | **sim** |
| 0.180.0 | `three.core.js` + `three.module.js` | **sim** |
| 0.181.0 | `three.core.js` + `three.module.js` | **sim** |

**Conclusão corrigida: o hook da extensão original continua funcionando em todas as
versões testadas (r150 → r181).** Não há regressão de compatibilidade — o problema é
apenas de *cobertura*: a extensão depende inteiramente do evento `observe`, e não tem
rede de segurança alguma (nenhuma instrumentação de `renderer.render`).

Ainda assim, esta reimplementação adiciona a rede de segurança
(`renderer.render(scene, camera)` instrumentado na instância e no protótipo), porque
frameworks ou builds que não despachem `observe` simplesmente não funcionam na original.

---

## Privacidade da extensão original

- Nenhuma requisição de rede, nenhum beacon, nenhum analytics.
- Permissão declarada: apenas `activeTab`; content scripts em `<all_urls>` (acesso de host implícito).
- `PRIVACY.md`: *"We don't store user data."* — a loja confirma "não coleta nem usa dados".
- O único dado sensível é o `.obj` gerado, que fica no disco (download local).

---

## Correções aplicadas nesta reimplementação

| # | Correção | Onde |
|---|---|---|
| 1 | Hook em `renderer.render(scene, camera)` (instância + `THREE.WebGLRenderer.prototype`) como rede de segurança | `src/injected.js` → `patchRenderer()`, `patchThreeNamespace()` |
| 2 | `__THREE_DEVTOOLS__` instalado como *accessor*: a página não consegue roubar o hook | `src/injected.js` → `installDevToolsHook()` |
| 3 | Transformações aplicadas via `matrixWorld` (com `updateWorldMatrix`) | `src/injected.js` → `worldMatrixOf()` |
| 4 | Normais exportadas (`vn`); normal planar calculada quando o atributo falta, expandindo os vértices | `src/injected.js` → `expandTriangles()` |
| 5 | UVs exportadas (`vt`) | `src/injected.js` → `buildOBJ()` |
| 6 | Materiais em `.mtl` (`newmtl`, `Kd`, `Pr`, `Pm`, `map_Kd`) | `src/injected.js` → `describeMaterial()` |
| 7 | `InstancedMesh` expandido, uma malha por instância | `src/injected.js` → `buildJobs()` |
| 8 | `SkinnedMesh` exportado na pose deformada | `src/injected.js` → `skinnedPositions()` |
| 9 | Exportação combinada (1 `.obj` + 1 `.mtl`) contorna o limite de downloads do Chrome | `src/injected.js` → `runExport()` |
| 10 | Nome de arquivo saneado e único | `src/injected.js` → `sanitizeName()`, `uniqueName()` |
| 11 | `revokeObjectURL` só 30 s depois (e removendo o `<a>` do DOM) | `src/injected.js` → `downloadFile()` |
| 12 | Sem `alert()`; status no popup | `src/popup.js` |

| 13 | Filtro por nome e por tamanho, com seleção explícita por modelo | `src/injected.js` → `matchesFilter()`, `collectModels()` |
| 14 | Deep link `#3dmesh=export&text=...&min=...&max=...` | `src/content.js` |
| 15 | `InstancedMesh` com **zero** instâncias não é mais descartado | `src/injected.js` → `buildJobs()` |

---

## Bug encontrado no teste real

O teste no navegador real (Tripo3D, three.js r183) expôs um bug que os testes
sintéticos não pegaram, porque nenhum mock tinha um `InstancedMesh` sem instâncias.

**Sintoma:** as malhas `skeleton-bone-bodies` e `skeleton-joint-spheres` do
Tripo desapareceram da exportação. Filtros que só selecionavam essas duas
malhas devolviam "nenhuma malha encontrada", e a exportação completa entregava
66 malhas em vez de 68 — exatamente as duas que faltavam. A contagem de faces
também denunciava: 352.493 em vez de 352.853.

**Causa:** no `buildJobs()`, ao expandir instâncias, o laço `for (i = 0; i < total; i++)`
não executa quando `instanceMatrix.count === 0` — e o `return` logo depois
descartava a malha por completo:

```js
if (mesh.isInstancedMesh && ...) {
  var total = mesh.instanceMatrix.count || 0;   // 0
  for (var i = 0; i < total; i++) { ... }        // não entra
  return;                                        // descarta a malha
}
```

**Correção:** quando `total === 0`, a malha base é exportada normalmente
(é o que ela de fato renderiza), e a contagem de instâncias relatada no popup
passa a ser 1 em vez de 0.

**Lição:** `InstancedMesh` não é sinônimo de "malha instanciada". O
`isInstancedMesh` continua verdadeiro mesmo quando a malha é usada como
geometria comum — e o `count` pode ser 0 em esqueletos montados por
ferramentas de rigging. A cobertura de teste precisa de um mock com esse caso.

---

## Validação em navegador real

Alvo: <https://studio.tripo3d.ai/workspace/generate/white-fluffy-dog-with-pink-bow-843c95e3-2c89-4ac4-997c-15a119fd0ea7>
(three.js **r183**, declarado pela própria página em `window.__THREE__`).

| Verificação | Resultado |
|---|---|
| Extensão injetada / hook ativo | sim / sim |
| Malhas capturadas | 68 em 5 cenas |
| Modelo principal | 182.412 vértices, 340.956 faces — **idêntico ao contador da página** |
| Exportação completa | `.obj` de 36,5 MB (190.427 v, 352.853 f, 21 materiais) + `.mtl` |
| Filtro texto `skeleton` | 2 malhas, 360 faces |
| Filtro tamanho `max 50 KB` | 66 malhas, 3.833 faces |
| Filtro tamanho `min 5000 KB` | 1 malha, 340.956 faces |
| Seleção explícita (`s0_m0`) | 1 malha, 340.956 faces |

A página define `window.__THREE__ = "183"` e **não** expõe `window.THREE`, ou seja,
o namespace não é global — a extensão funciona só pelo hook
`__THREE_DEVTOOLS__` (confirmando que o hook é o caminho essencial) e o
patch em `renderer.render` é mesmo a rede de segurança necessária.

Os downloads foram verificados pelos eventos `Browser.downloadWillBegin` /
`Browser.downloadProgress` do CDP, com `Browser.setDownloadBehavior` apontando
para uma pasta local.

---

## Exportacao STL (v2.1)

O popup ganhou um seletor de formato. Em **STL** a geometria é convertida
dentro da página e o `.stl` é gravado direto — o `.obj` nunca chega a existir
em disco.

```
modelos (qualquer formato)
   └─ extractModel()  → posições em espaço de mundo + índices
        └─ collectTriangles()  → sopa de triângulos (12 floats por triângulo)
             └─ buildBinarySTL() / buildAsciiSTL()
```

O que o STL perde e o que ganha:

| | OBJ | STL |
|---|---|---|
| Objetos separados | sim (`o <nome>`) | não — tudo vira uma malha única |
| Normais por vértice | sim (`vn`) | não — cada facet tem uma normal calculada dos seus 3 vértices |
| UVs | sim (`vt`) | não |
| Materiais | `.mtl` | não |
| Tamanho | 36,5 MB (modelo do Tripo) | **16,8 MB** |

O layout binário segue o padrão: 80 bytes de cabeçalho (texto), 4 bytes com a
contagem de triângulos e 50 bytes por facet (normal, 3 vértices, 2 bytes de
atributo). Triângulos degenerados (área zero) são descartados na conversão.

O filtro de tamanho passou a ser **consciente do formato**: a estimativa por
modelo é calculada nos três formatos (`84 + 50 × triângulos` para o STL
binário), e tanto o popup quanto a página usam o mesmo número — então
"filtrar por 500 KB" significa a mesma coisa antes e depois de trocar o formato.

## Service worker (`background.js`)

O deep link do popup (`popup.html?url=...`) precisa achar a aba alvo. Sem a
permissão `tabs`, `tab.url` chega vazio — e adicionar essa permissão mostraria
"ler seu histórico de navegação" na loja.

A solução: o service worker pergunta às próprias content scripts o
`location.href` delas (`chrome.tabs.sendMessage(tabId, {type: 'MDL_WHERE'})`).
Nenhuma permissão extra, nenhuma leitura de histórico.
