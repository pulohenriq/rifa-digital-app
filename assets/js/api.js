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

  /* Ações que podem ser repetidas sem efeito colateral: se o Worker falhar,
     são refeitas na hora direto no Apps Script. As demais (reservar, enviar
     comprovante, confirmar…) nunca são repetidas automaticamente, para não
     duplicar nada; a pessoa tenta de novo e a nova tentativa já vai direto. */
  const SEGURAS = new Set(['ping', 'config', 'status', 'consultarPedido', 'login', 'logout', 'dashboard',
    'listarPedidos', 'listarPagos', 'limparCache', 'liberarExpirados']);
  let usarReservaAte = 0;

  function baseAtual() {
    return cfg.API_URL_RESERVA && Date.now() < usarReservaAte ? cfg.API_URL_RESERVA : cfg.API_URL;
  }

  async function executar(base, metodo, action, dados, opc) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, opc.timeout || 20000) : null;

    let url = base;
    const init = { method: metodo, redirect: 'follow', cache: 'no-store', signal: ctrl ? ctrl.signal : undefined };
    if (metodo === 'GET') {
      const q = new URLSearchParams(Object.assign({ action: action }, dados || {}));
      q.set('_', String(Date.now()));   // evita cache intermediário do navegador
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

  async function chamar(metodo, action, dados, opc) {
    opc = opc || {};
    if (!urlConfigurada()) {
      throw new ErroApi('O endereço da API ainda não foi configurado em assets/js/config.js.', 'CONFIG_SITE');
    }
    const base = baseAtual();
    try {
      return await executar(base, metodo, action, dados, opc);
    } catch (e) {
      const reserva = cfg.API_URL_RESERVA;
      const falhaDoCaminho = e.codigo === 'REDE' || e.codigo === 'RESPOSTA';
      if (!falhaDoCaminho || !reserva || base === reserva) throw e;
      usarReservaAte = Date.now() + 10 * 60 * 1000;          // próximos 10 min direto no Apps Script
      if (metodo === 'GET' || SEGURAS.has(action)) return executar(reserva, metodo, action, dados, opc);
      throw e;
    }
  }

  global.Api = {
    get: function (action, dados, opc) { return chamar('GET', action, dados, opc); },
    post: function (action, dados, opc) { return chamar('POST', action, dados, opc); },
    ErroApi: ErroApi,
    urlConfigurada: urlConfigurada
  };
})(window);
