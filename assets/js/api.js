/**
 * Cliente da API da rifa (Google Apps Script).
 * Compartilhado pelas páginas do comprador, do painel e do sorteio.
 *
 *   Api.get('status')                         → leitura pública
 *   Api.post('criarPedido', { numeros, ... }) → ações
 *
 * O POST vai com Content-Type text/plain: é uma "requisição simples" e
 * o navegador não faz a checagem prévia de CORS, que o Apps Script não atende.
 */
(function (global) {
  'use strict';

  const cfg = global.RIFA_CONFIG || {};

  class ErroApi extends Error {
    constructor(mensagem, codigo, dados) {
      super(mensagem);
      this.name = 'ErroApi';
      this.codigo = codigo || 'ERRO';
      this.dados = dados || null;
    }
  }

  function urlConfigurada() {
    return typeof cfg.API_URL === 'string' && /^https?:\/\//.test(cfg.API_URL) && !/COLE_AQUI/.test(cfg.API_URL);
  }

  async function chamar(metodo, action, dados, opc) {
    opc = opc || {};
    if (!urlConfigurada()) {
      throw new ErroApi('O endereço da API ainda não foi configurado em assets/js/config.js.', 'CONFIG_SITE');
    }
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, opc.timeout || 20000) : null;

    let url = cfg.API_URL;
    const init = { method: metodo, redirect: 'follow', cache: 'no-store', signal: ctrl ? ctrl.signal : undefined };
    if (metodo === 'GET') {
      const q = new URLSearchParams(Object.assign({ action: action }, dados || {}));
      q.set('_', String(Date.now()));   // evita cache intermediário
      url += (url.indexOf('?') >= 0 ? '&' : '?') + q.toString();
    } else {
      init.headers = { 'Content-Type': 'text/plain;charset=utf-8' };
      init.body = JSON.stringify(Object.assign({ action: action }, dados || {}));
    }

    let resp;
    try {
      resp = await fetch(url, init);
    } catch (e) {
      throw new ErroApi(
        e && e.name === 'AbortError'
          ? 'O servidor demorou para responder. Tente de novo.'
          : 'Sem conexão com o servidor. Confira sua internet e tente de novo.',
        'REDE');
    } finally {
      if (timer) clearTimeout(timer);
    }

    let json;
    try {
      json = await resp.json();
    } catch (e) {
      // Costuma acontecer quando a implantação não está como "Qualquer pessoa"
      throw new ErroApi('Resposta inesperada do servidor. Confira se o App da Web está publicado para "Qualquer pessoa".', 'RESPOSTA');
    }
    if (!json || json.ok !== true) {
      throw new ErroApi((json && json.erro) || 'Não foi possível concluir a operação.', json && json.codigo, json && json.dados);
    }
    return json.data;
  }

  global.Api = {
    get: function (action, dados, opc) { return chamar('GET', action, dados, opc); },
    post: function (action, dados, opc) { return chamar('POST', action, dados, opc); },
    ErroApi: ErroApi,
    urlConfigurada: urlConfigurada
  };
})(window);