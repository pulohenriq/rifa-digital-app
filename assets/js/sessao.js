/**
 * Sessão do administrador — compartilhada pelo painel (admin.html) e pelo
 * sorteio (sorteio.html).
 *
 * A senha nunca fica guardada: ela vai uma única vez para o servidor, que
 * devolve uma "sessão" temporária (6 h a partir do último uso). É essa
 * sessão que fica neste navegador. Em computador de uso coletivo, use "Sair".
 */
(function (global) {
  'use strict';

  const CHAVE = 'rifa:sessao-admin';
  const SEIS_HORAS = 6 * 3600 * 1000;
  const ouvintes = [];

  function ler() {
    try {
      const s = JSON.parse(localStorage.getItem(CHAVE) || 'null');
      if (!s || !s.sessao || Date.parse(s.expira) <= Date.now()) return null;
      return s;
    } catch (e) { return null; }
  }
  function gravar(s) { try { localStorage.setItem(CHAVE, JSON.stringify(s)); } catch (e) { /* segue */ } }
  function apagar() { try { localStorage.removeItem(CHAVE); } catch (e) { /* segue */ } }
  function avisarExpirou(msg) { ouvintes.forEach(function (fn) { try { fn(msg); } catch (e) { /* segue */ } }); }

  const Sessao = {
    atual: ler,

    async entrar(nome, senha) {
      const r = await Api.post('login', { nome: nome, senha: senha }, { timeout: 30000 });
      gravar({ sessao: r.sessao, nome: r.nome, expira: r.expira_em });
      return r;
    },

    async sair() {
      const s = ler();
      apagar();
      if (s) { try { await Api.post('logout', { sessao: s.sessao }); } catch (e) { /* já saiu localmente */ } }
    },

    /** Chama uma ação administrativa já com a sessão. */
    async chamar(action, dados, opc) {
      const s = ler();
      if (!s) {
        avisarExpirou('Faça login para continuar.');
        throw new Api.ErroApi('Faça login para continuar.', 'NAO_AUTORIZADO');
      }
      try {
        const r = await Api.post(action, Object.assign({}, dados || {}, { sessao: s.sessao }), opc);
        s.expira = new Date(Date.now() + SEIS_HORAS).toISOString();   // o servidor também renovou
        gravar(s);
        return r;
      } catch (e) {
        if (e.codigo === 'NAO_AUTORIZADO' || e.codigo === 'SESSAO_EXPIRADA') { apagar(); avisarExpirou(e.message); }
        throw e;
      }
    },

    aoExpirar(fn) { ouvintes.push(fn); },

    /**
     * Liga um formulário de login com campos #lgNome, #lgSenha, #lgErro e
     * botão de envio #lgBotao. Chama aoEntrar(sessao) quando der certo.
     */
    ligarFormulario(form, aoEntrar) {
      const $ = function (s) { return form.querySelector(s); };
      const ultimoNome = (function () { try { return localStorage.getItem('rifa:admin-nome') || ''; } catch (e) { return ''; } })();
      if (ultimoNome && !$('#lgNome').value) $('#lgNome').value = ultimoNome;
      form.addEventListener('submit', async function (ev) {
        ev.preventDefault();
        const nome = $('#lgNome').value.trim();
        const senha = $('#lgSenha').value;
        const erro = $('#lgErro');
        erro.hidden = true;
        if (!nome || !senha) { erro.textContent = 'Informe seu nome e a senha.'; erro.hidden = false; return; }
        const btn = $('#lgBotao');
        btn.classList.add('carregando'); btn.disabled = true;
        try {
          await Sessao.entrar(nome, senha);
          try { localStorage.setItem('rifa:admin-nome', nome); } catch (e) { /* segue */ }
          $('#lgSenha').value = '';
          aoEntrar(ler());
        } catch (e) {
          erro.textContent = e.message; erro.hidden = false;
          $('#lgSenha').select();
        } finally {
          btn.classList.remove('carregando'); btn.disabled = false;
        }
      });
    }
  };

  global.Sessao = Sessao;
})(window);