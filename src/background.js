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

  for (const tab of tabs) {
    if (tab.id == null) continue;
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'MDL_WHERE' });
      if (res && res.url && res.url.indexOf(fragment) !== -1) return tab.id;
    } catch (e) {
      // aba sem content script (ou aba restrita)
    }
  }

  return null;
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
