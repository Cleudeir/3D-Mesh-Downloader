/**
 * 3D Mesh Downloader - background.js (service worker)
 *
 * O popup precisa encontrar a aba alvo de um deep link. Sem a permissao
 * "tabs", `tab.url` chega vazio - entao em vez de ler a URL pelo navegador,
 * perguntamos as proprias content scripts, que conhecem o `location.href`
 * da pagina em que estao.
 *
 * Isso mantem a extensao sem a permissao "tabs" (que mostraria "ler seu
 * historico de navegacao" na loja).
 */
'use strict';

async function findTabByUrl(fragment) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (e) {
    return null;
  }

  let best = null;
  for (const tab of tabs) {
    if (tab.id == null) continue;
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'MDL_WHERE' });
      if (!res || !res.url) continue;
      const score = scoreMatch(String(fragment), res.url);
      if (score > 0 && (!best || score > best.score)) best = { id: tab.id, score };
    } catch (e) {
      // aba sem content script (ou aba restrita)
    }
  }

  return best ? best.id : null;
}

/**
 * Quanto uma URL da aba "casa" com a URL pedida.
 *
 * O deep link pode envelhecer: um SPA troca a rota (ex.: /generate/x ->
 * /segmentation/x) e a URL guardada deixa de ser substring da atual. Por isso
 * a comparacao vai do mais forte ao mais fraco, e o melhor candidato vence.
 */
function scoreMatch(wantedRaw, actualRaw) {
  let wanted;
  let actual;
  try {
    wanted = new URL(wantedRaw);
    actual = new URL(actualRaw);
  } catch (e) {
    return actualRaw.indexOf(wantedRaw) !== -1 ? 50 : 0;
  }

  if (wanted.origin !== actual.origin) return 0;

  const wp = wanted.pathname.replace(/\/+$/, '');
  const ap = actual.pathname.replace(/\/+$/, '');
  if (wp === ap) return 100;

  const wSeg = wp.split('/').filter(Boolean);
  const aSeg = ap.split('/').filter(Boolean);
  const wLast = wSeg[wSeg.length - 1] || '';
  const aLast = aSeg[aSeg.length - 1] || '';

  // mesmo id/slug do modelo, mesmo que a rota tenha mudado
  if (wLast && wLast === aLast) return 80;

  // um caminho conteudo no outro
  if (wp && (ap.indexOf(wp + '/') === 0 || wp.indexOf(ap + '/') === 0)) return 60;

  // o trecho final aparece em qualquer posicao do caminho da aba
  if (wLast && aSeg.indexOf(wLast) !== -1) return 40;

  return 0;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || typeof request !== 'object') return false;

  if (request.type === 'MDL_FIND_TAB' && request.url) {
    findTabByUrl(String(request.url)).then((tabId) => {
      sendResponse({ tabId: tabId });
    });
    return true;
  }

  return false;
});
