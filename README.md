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

### Opções de exportação

| Opção | Padrão | Efeito |
|---|---|---|
| Aplicar transformações do objeto | ligado | Exporta em espaço de mundo (`matrixWorld`), com posição/rotação/escala |
| Exportar normais (`vn`) | ligado | Usa o atributo de normal; se faltar, calcula normal planar e expande os vértices |
| Exportar UVs (`vt`) | ligado | Exporta o atributo `uv` quando existir |
| Expandir `InstancedMesh` | ligado | Uma malha por instância, aplicando a matriz de cada uma |
| Exportar materiais (`.mtl`) | ligado | Gera `newmtl`, `Kd`, `Pr`, `Pm` e `map_Kd` |
| Unir tudo em um único `.obj` | ligado | **1 `.obj` + 1 `.mtl`** em vez de N downloads (contorna o limite do Chrome) |

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
| `InstancedMesh` | exporta só a geometria base | expande uma malha por instância |
| `SkinnedMesh` | exporta pose bind | exporta a pose deformada (skinning) |
| Nº de downloads | 1 por malha (Chrome corta ~10) | 1 `.obj` + 1 `.mtl` |
| Nome do arquivo | `mesh.name` cru | saneado e único |
| Sobrevive a `__THREE_DEVTOOLS__` da página | não (era sobrescrito) | sim |
| Avisos | `alert()` | status no popup |

---

## Testes

```bash
npm test
```

A suíte roda o `src/injected.js` **real** dentro de um contexto `vm` do Node com DOM
mockado (`test/harness.js`) e cenas Three.js simuladas (`test/mock-three.js`).

Cobre: captura de cena, transformações (com e sem), normais (atributo e planar),
UVs, expansão de instâncias, skinning, materiais, modo por-malha, índices das faces
e robustez (página sem cena, página que define o próprio `__THREE_DEVTOOLS__`).

```
44 passed, 0 failed
```

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
