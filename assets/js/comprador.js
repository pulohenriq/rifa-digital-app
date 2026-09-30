/* =====================================================================
   comprador.js — página pública da rifa
   ---------------------------------------------------------------------
   Fluxo: grade de números → seleção → dados → Pix → comprovante.
   O navegador só exibe e pede; preço, disponibilidade e prazo são
   sempre decididos pelo servidor.
   ===================================================================== */
(() => {
  'use strict';

  /* ------------------------------------------------------------------
     Utilidades
     ------------------------------------------------------------------ */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const brl = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const listaHumana = nums => {
    const a = nums.map(String);
    return a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' e ' + a[a.length - 1];
  };
  const plural = (n, um, varios) => n === 1 ? um : varios.replace('#', n);
  const reduzMov = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const ST = {
    AGUARDANDO: 'AGUARDANDO_PAGAMENTO', COMPROVANTE: 'COMPROVANTE_ENVIADO',
    CONFIRMADO: 'PAGAMENTO_CONFIRMADO', EXPIRADO: 'EXPIRADO', CANCELADO: 'CANCELADO'
  };
  const NOME_STATUS = {
    AGUARDANDO_PAGAMENTO: 'Aguardando pagamento', COMPROVANTE_ENVIADO: 'Em conferência',
    PAGAMENTO_CONFIRMADO: 'Pago', EXPIRADO: 'Prazo encerrado', CANCELADO: 'Cancelado'
  };
  const NOME_LETRA = { D: 'livre', R: 'reservado', P: 'pago', X: 'fora de venda' };
  const MSG_FECHADA = {
    NAO_INICIADA: 'As vendas ainda não começaram. Os números aparecem aqui para você conhecer a rifa.',
    PAUSADA: 'As vendas estão pausadas no momento.',
    ENCERRADA: 'As vendas foram encerradas. Obrigado a todos que participaram!',
    SORTEADA: 'Esta rifa já foi sorteada. Obrigado a todos que participaram!'
  };

  /* números aleatórios justos (mesma técnica do sorteio) */
  function randInt(n) {
    if (n <= 1) return 0;
    const lim = Math.floor(0x100000000 / n) * n, buf = new Uint32Array(1);
    let x; do { crypto.getRandomValues(buf); x = buf[0]; } while (x >= lim);
    return x % n;
  }

  const LS = {
    ler(k, pad) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : pad; } catch (e) { return pad; } },
    gravar(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* modo privado: segue sem salvar */ } }
  };

  async function copiar(texto) {
    try { await navigator.clipboard.writeText(texto); return true; }
    catch (e) {
      const ta = document.createElement('textarea');
      ta.value = texto; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch (_) { /* segue */ }
      ta.remove(); return ok;
    }
  }

  function toast(msg, ms = 4200) {
    const el = document.createElement('div');
    el.className = 'toast'; el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.classList.add('saindo'); setTimeout(() => el.remove(), 220); }, ms);
  }

  /* ------------------------------------------------------------------
     Estado
     ------------------------------------------------------------------ */
  const E = {
    cfg: null,
    statusRifa: 'PAUSADA',
    ini: 0, fim: -1,
    letras: [], celulas: [],
    sel: new Set(),
    meus: new Set(),
    offset: 0,                 // relógio do servidor − relógio do aparelho
    falhas: 0,
    // pedido aberto no painel
    pedido: null, token: null, pagamento: null, podeEnviar: false, etapa: null,
    arquivo: null,
    consultando: false,
    timers: {}
  };

  const agoraServidor = () => Date.now() + E.offset;
  function ajustarRelogio(iso) { const t = Date.parse(iso); if (t) E.offset = t - Date.now(); }
  const vendaAberta = () => E.statusRifa === 'ABERTA';

  /* ------------------------------------------------------------------
     Pedidos guardados neste aparelho
     ------------------------------------------------------------------ */
  const chavePedidos = () => 'rifa:' + (E.cfg ? E.cfg.id_rifa : 'x') + ':pedidos';
  const pedidosSalvos = () => LS.ler(chavePedidos(), []);
  const ativo = st => st === ST.AGUARDANDO || st === ST.COMPROVANTE;

  function salvarPedido(p, token) {
    const lista = pedidosSalvos().filter(x => x.id !== p.pedido_id);
    lista.unshift({ id: p.pedido_id, token, status: p.status, numeros: p.numeros, valor: p.valor_total, expira: p.expira_em, data: p.data });
    LS.gravar(chavePedidos(), lista.slice(0, 20));
    depoisDeMudarPedidos();
  }
  function atualizarSalvo(p) {
    const lista = pedidosSalvos();
    const x = lista.find(i => i.id === p.pedido_id);
    if (x) { x.status = p.status; x.numeros = p.numeros; x.expira = p.expira_em; x.valor = p.valor_total; LS.gravar(chavePedidos(), lista); }
    depoisDeMudarPedidos();
  }
  function esquecerPedido(id) {
    LS.gravar(chavePedidos(), pedidosSalvos().filter(x => x.id !== id));
    depoisDeMudarPedidos();
  }
  function depoisDeMudarPedidos() {
    const lista = pedidosSalvos();
    const antes = E.meus;
    E.meus = new Set();
    lista.filter(x => ativo(x.status) || x.status === ST.CONFIRMADO).forEach(x => (x.numeros || []).forEach(n => E.meus.add(n)));
    new Set([...antes, ...E.meus]).forEach(n => pintar(n - E.ini));
    $('#btnMeusPedidos').hidden = !lista.length;
    $('#legendaMeu').hidden = !E.meus.size;
    atualizarAviso();
  }
  const linkPedido = (id, token) => location.origin + location.pathname + '?pedido=' + encodeURIComponent(id) + '&t=' + encodeURIComponent(token);

  /* ------------------------------------------------------------------
     Início
     ------------------------------------------------------------------ */
  function mostrarTela(qual) {
    $('#telaCarregando').hidden = qual !== 'carregando';
    $('#telaFalha').hidden = qual !== 'falha';
    $('#app').hidden = qual !== 'app';
    $('#rodape').hidden = qual !== 'app';
  }

  async function iniciar() {
    mostrarTela('carregando');
    try {
      const [cfg, st] = await Promise.all([Api.get('config'), Api.get('status')]);
      E.cfg = cfg;
      ajustarRelogio(cfg.agora);
      montarAbertura();
      construirGrade(st);
      aplicarStatus(st);
      mostrarTela('app');
      depoisDeMudarPedidos();
      atualizarCarrinho();
      await retomarPedido();
      agendarAtualizacao();
      E.timers.relogio = setInterval(tickRelogio, 1000);
    } catch (e) {
      $('#falhaTexto').textContent = e.message || 'Tente novamente em instantes.';
      $('#btnTentar').hidden = e.codigo === 'CONFIG_SITE';
      mostrarTela('falha');
    }
  }

  function montarAbertura() {
    const c = E.cfg;
    document.title = c.nome_rifa;
    $('#topoNome').textContent = c.nome_recebedor || 'Rifa online';
    $('#nomeRifa').textContent = c.nome_rifa;
    $('#descRifa').textContent = c.descricao || '';
    $('#descRifa').hidden = !c.descricao;
    $('#preco').textContent = brl(c.valor_numero);
    $('#notaReserva').textContent = `Ao reservar, os números ficam guardados para você por ${c.prazo_reserva_minutos} minutos enquanto você paga.`;
    $('#fEmailOpc').hidden = !!c.email_obrigatorio;
    $('#fEmail').required = !!c.email_obrigatorio;
    if (c.whatsapp_contato) {
      const a = $('#lnkWhats');
      a.href = linkWhats('Olá! Tenho uma dúvida sobre a ' + c.nome_rifa + '.');
      a.hidden = false;
    }
    $('#irPara').min = c.numero_inicial; $('#irPara').max = c.numero_final;
  }

  function linkWhats(texto) {
    return 'https://wa.me/' + E.cfg.whatsapp_contato + '?text=' + encodeURIComponent(texto);
  }

  /* ------------------------------------------------------------------
     Grade
     ------------------------------------------------------------------ */
  function construirGrade(st) {
    E.ini = st.inicial; E.fim = st.final;
    E.celulas = []; E.letras = [];
    const frag = document.createDocumentFragment();
    for (let n = st.inicial; n <= st.final; n++) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'bil'; b.dataset.n = n; b.textContent = n;
      frag.appendChild(b); E.celulas.push(b); E.letras.push('');
    }
    const g = $('#grade'); g.textContent = ''; g.appendChild(frag);
  }

  function pintar(i) {
    const b = E.celulas[i];
    if (!b) return;
    const n = E.ini + i, l = E.letras[i] || 'X', sel = E.sel.has(n), meu = E.meus.has(n);
    b.className = 'bil ' + (sel ? 's' : l.toLowerCase()) + (meu ? ' meu' : '');
    b.setAttribute('aria-pressed', sel ? 'true' : 'false');
    b.setAttribute('aria-label', 'Número ' + n + ': ' + (sel ? 'selecionado' : NOME_LETRA[l]) + (meu ? ', do seu pedido' : ''));
    if (l === 'D') b.removeAttribute('aria-disabled'); else b.setAttribute('aria-disabled', 'true');
  }

  function aplicarStatus(st) {
    if (st.inicial !== E.ini || st.final !== E.fim) { construirGrade(st); }
    ajustarRelogio(st.agora);
    const perdidos = [];
    for (let i = 0; i < st.s.length; i++) {
      const l = st.s.charAt(i), n = E.ini + i;
      if (l !== 'D' && E.sel.has(n)) { E.sel.delete(n); perdidos.push(n); }
      if (l !== E.letras[i] || perdidos[perdidos.length - 1] === n) { E.letras[i] = l; pintar(i); }
    }
    if (perdidos.length) {
      toast(perdidos.length === 1
        ? `O número ${perdidos[0]} acabou de ser reservado por outra pessoa e saiu da sua seleção.`
        : `Os números ${listaHumana(perdidos)} acabaram de ser reservados por outras pessoas e saíram da sua seleção.`, 6000);
      atualizarCarrinho();
    }
    atualizarProgresso(st.contagem);
    atualizarStatusRifa(st.status_rifa);
    const h = new Date(agoraServidor()).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const at = $('#atualizacao');
    at.classList.remove('offline');
    at.textContent = `Situação atualizada às ${h}. A grade se atualiza sozinha.`;
  }

  function atualizarProgresso(c) {
    const total = (c.D + c.R + c.P) || 1;
    $('#progPago').style.width = (c.P / total * 100) + '%';
    $('#progReserva').style.width = (c.R / total * 100) + '%';
    let txt = `${c.P} de ${c.D + c.R + c.P} números vendidos`;
    if (c.R) txt += `, ${c.R} ${c.R === 1 ? 'reservado' : 'reservados'} agora`;
    $('#progTexto').textContent = txt;
    $('#gradeVazia').hidden = c.D > 0;
  }

  function atualizarStatusRifa(st) {
    E.statusRifa = st;
    const faixa = $('#faixaFechada');
    faixa.hidden = st === 'ABERTA';
    faixa.textContent = MSG_FECHADA[st] || '';
    $('#carrinho').hidden = st !== 'ABERTA' && !E.sel.size;
    $('.ferramentas .sorte').hidden = st !== 'ABERTA';
    atualizarCarrinho();
  }

  function alternar(n) {
    const i = n - E.ini, l = E.letras[i];
    if (l !== 'D') {
      toast(l === 'R' ? `O ${n} está reservado. Se não for pago no prazo, ele volta a ficar livre.`
        : l === 'P' ? `O ${n} já foi vendido.` : `O ${n} não está à venda.`);
      return;
    }
    if (!vendaAberta()) { toast(MSG_FECHADA[E.statusRifa] || 'As vendas não estão abertas.'); return; }
    if (E.sel.has(n)) E.sel.delete(n);
    else {
      if (E.sel.size >= E.cfg.max_por_pedido) { toast(`Você pode escolher até ${E.cfg.max_por_pedido} números por pedido.`); return; }
      E.sel.add(n);
    }
    pintar(i);
    atualizarCarrinho();
  }

  function escolherParaMim() {
    if (!vendaAberta()) return;
    const qtd = Number($('#sorteQtd').textContent);
    const livres = [];
    E.letras.forEach((l, i) => { if (l === 'D' && !E.sel.has(E.ini + i)) livres.push(E.ini + i); });
    const cabe = Math.min(qtd, livres.length, E.cfg.max_por_pedido - E.sel.size);
    if (cabe <= 0) {
      toast(livres.length ? `Você já está no limite de ${E.cfg.max_por_pedido} números.` : 'Não há números livres para escolher.');
      return;
    }
    const escolhidos = [];
    for (let k = 0; k < cabe; k++) {
      const j = k + randInt(livres.length - k);
      [livres[k], livres[j]] = [livres[j], livres[k]];
      escolhidos.push(livres[k]);
    }
    escolhidos.sort((a, b) => a - b).forEach(n => { E.sel.add(n); pintar(n - E.ini); });
    atualizarCarrinho();
    toast(escolhidos.length === 1 ? `Escolhemos o ${escolhidos[0]} para você.` : `Escolhemos ${listaHumana(escolhidos)} para você.`);
  }

  function irPara() {
    const n = Number($('#irPara').value);
    if (!Number.isInteger(n) || n < E.ini || n > E.fim) { toast(`Digite um número de ${E.ini} a ${E.fim}.`); return; }
    const b = E.celulas[n - E.ini];
    if ($('#soLivres').checked && E.letras[n - E.ini] !== 'D' && !E.sel.has(n)) { $('#soLivres').checked = false; $('#grade').classList.remove('so-livres'); }
    b.scrollIntoView({ block: 'center', behavior: reduzMov ? 'auto' : 'smooth' });
    b.classList.remove('piscar'); void b.offsetWidth; b.classList.add('piscar');
    b.focus({ preventScroll: true });
  }

  /* ------------------------------------------------------------------
     Atualização periódica (pausa quando a aba está em segundo plano)
     ------------------------------------------------------------------ */
  function agendarAtualizacao(ms) {
    clearTimeout(E.timers.poll);
    const base = Math.max(3, E.cfg.intervalo_atualizacao_seg || 8) * 1000;
    E.timers.poll = setTimeout(atualizarGrade, ms ?? (E.falhas ? Math.min(60000, base * 2 ** E.falhas) : base));
  }
  async function atualizarGrade() {
    if (document.hidden) { E.esperandoVisivel = true; return; }
    try {
      aplicarStatus(await Api.get('status', {}, { timeout: 15000 }));
      E.falhas = 0;
    } catch (e) {
      E.falhas = Math.min(E.falhas + 1, 5);
      const at = $('#atualizacao');
      at.classList.add('offline');
      at.textContent = 'Sem conexão no momento. Tentando atualizar de novo…';
    }
    agendarAtualizacao();
  }
  const atualizarAgora = () => { clearTimeout(E.timers.poll); atualizarGrade(); };
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && E.esperandoVisivel) { E.esperandoVisivel = false; atualizarAgora(); }
  });

  /* ------------------------------------------------------------------
     Carrinho
     ------------------------------------------------------------------ */
  function atualizarCarrinho() {
    if (!E.cfg) return;
    const nums = [...E.sel].sort((a, b) => a - b);
    const q = nums.length;
    $('#carrinhoQtd').textContent = q ? plural(q, '1 número escolhido', '# números escolhidos') : 'Nenhum número escolhido';
    $('#carrinhoTotal').textContent = brl(q * E.cfg.valor_numero);
    $('#btnReservar').disabled = !q || !vendaAberta();
    $('#carrinho').classList.toggle('tem', q > 0);
    if (!q) { $('#carrinho').classList.remove('aberto'); $('#btnCarrinhoAbrir').setAttribute('aria-expanded', 'false'); }
    $('#carrinhoVazio').hidden = q > 0;
    $('#btnLimpar').hidden = q < 2;
    $('#chips').innerHTML = nums.map(n => `<li><button type="button" data-n="${n}" aria-label="Tirar o ${n}">${n} <span aria-hidden="true">×</span></button></li>`).join('');
    if (E.statusRifa !== 'ABERTA') $('#carrinho').hidden = !q;
  }

  /* ------------------------------------------------------------------
     Checkout: etapas
     ------------------------------------------------------------------ */
  const dlg = $('#checkout');
  const PASSO = { dados: 1, pix: 2, comprovante: 3, final: 3 };

  function mostrarEtapa(etapa, finalConcluida) {
    E.etapa = etapa;
    $$('[data-etapa]', dlg).forEach(s => { s.hidden = s.dataset.etapa !== etapa; });
    const atual = PASSO[etapa];
    $$('#passos li').forEach(li => {
      const p = Number(li.dataset.passo);
      const feito = p < atual || (!!finalConcluida && p <= atual);
      li.classList.toggle('feito', feito);
      if (p === atual && !feito) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    });
    $('.painel-corpo', dlg).scrollTop = 0;
  }

  function abrirPainel() {
    if (!dlg.open) { if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', ''); }
  }
  function fecharPainel() {
    pararVigia();
    if (dlg.open) { if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open'); }
  }

  function abrirCheckout() {
    if (!E.sel.size || !vendaAberta()) return;
    const salvo = LS.ler('rifa:comprador', {});
    $('#fNome').value = $('#fNome').value || salvo.nome || '';
    $('#fTel').value = $('#fTel').value || salvo.telefone || '';
    $('#fEmail').value = $('#fEmail').value || salvo.email || '';
    $('#fCong').value = $('#fCong').value || salvo.congregacao || '';
    limparErrosForm();
    montarResumoSelecao();
    E.pedido = null;
    mostrarEtapa('dados');
    abrirPainel();
    setTimeout(() => ($('#fNome').value ? $('#btnConfirmar') : $('#fNome')).focus(), 60);
  }

  function montarResumoSelecao() {
    const nums = [...E.sel].sort((a, b) => a - b);
    $('#ckResumo').innerHTML =
      `<p><strong>${plural(nums.length, '1 número', '# números')}</strong>, total de <strong>${brl(nums.length * E.cfg.valor_numero)}</strong></p>` +
      `<div class="linha-bilhetes">${nums.map(n => `<span class="mini">${n}</span>`).join('')}</div>`;
  }

  /* máscara simples de telefone */
  function formatarTel(v) {
    let d = v.replace(/\D/g, '');
    if (d.startsWith('55') && d.length > 11) d = d.slice(2);
    d = d.slice(0, 11);
    if (d.length <= 2) return d ? '(' + d : '';
    if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
    if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  }

  function erroCampo(id, msg) {
    const c = $('#' + id);
    c.classList.add('invalido');
    let d = c.querySelector('.dica-erro');
    if (!d) { d = document.createElement('span'); d.className = 'dica-erro'; c.appendChild(d); }
    d.textContent = msg;
    c.querySelector('input').setAttribute('aria-invalid', 'true');
  }
  function limparErrosForm() {
    $$('#formDados .campo').forEach(c => {
      c.classList.remove('invalido');
      const d = c.querySelector('.dica-erro'); if (d) d.remove();
      c.querySelector('input').removeAttribute('aria-invalid');
    });
    $('#ckErro').hidden = true;
  }

  async function enviarDados(ev) {
    ev.preventDefault();
    limparErrosForm();
    const nome = $('#fNome').value.trim().replace(/\s+/g, ' ');
    const tel = $('#fTel').value.replace(/\D/g, '');
    const email = $('#fEmail').value.trim();
    const cong = $('#fCong').value.trim();
    let primeiro = null;
    if (nome.length < 3) { erroCampo('cNome', 'Informe o nome completo.'); primeiro = primeiro || '#fNome'; }
    if (tel.length < 10 || tel.length > 13) { erroCampo('cTel', 'Informe o WhatsApp com DDD.'); primeiro = primeiro || '#fTel'; }
    if ((E.cfg.email_obrigatorio && !email) || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))) {
      erroCampo('cEmail', email ? 'Confira o e-mail.' : 'Informe seu e-mail.'); primeiro = primeiro || '#fEmail';
    }
    if (primeiro) { $(primeiro).focus(); return; }
    if (!E.sel.size) { mostrarErroCk('Sua seleção ficou vazia. Volte à grade e escolha os números.'); return; }

    const btn = $('#btnConfirmar');
    btn.classList.add('carregando'); btn.disabled = true;
    try {
      const r = await Api.post('criarPedido', {
        numeros: [...E.sel].sort((a, b) => a - b),
        nome, telefone: tel, email, congregacao: cong, forma_pagamento: 'PIX_MANUAL'
      }, { timeout: 30000 });
      LS.gravar('rifa:comprador', { nome, telefone: $('#fTel').value, email, congregacao: cong });
      E.sel.clear();
      atualizarCarrinho();
      salvarPedido(r.pedido, r.token);
      E.token = r.token;
      mostrarPedido({ pedido: r.pedido, pagamento: r.pagamento, pode_enviar_comprovante: true });
      atualizarAgora();
    } catch (e) {
      tratarErroPedido(e);
    } finally {
      btn.classList.remove('carregando'); btn.disabled = false;
    }
  }

  function mostrarErroCk(html) { const el = $('#ckErro'); el.innerHTML = html; el.hidden = false; el.scrollIntoView({ block: 'nearest' }); }

  function tratarErroPedido(e) {
    if (e.codigo === 'INDISPONIVEL' && e.dados && e.dados.indisponiveis) {
      const perdidos = e.dados.indisponiveis;
      perdidos.forEach(n => { E.sel.delete(n); pintar(n - E.ini); });
      atualizarCarrinho(); montarResumoSelecao(); atualizarAgora();
      mostrarErroCk(esc(`${perdidos.length === 1 ? 'O número ' + perdidos[0] + ' foi reservado' : 'Os números ' + listaHumana(perdidos) + ' foram reservados'} por outra pessoa enquanto você preenchia. ` +
        (E.sel.size ? 'Tiramos da sua seleção; confira e reserve de novo.' : 'Feche esta janela e escolha outros números.')));
      return;
    }
    if (e.dados && e.dados.campo) {
      const mapa = { nome: 'cNome', telefone: 'cTel', email: 'cEmail' };
      if (mapa[e.dados.campo]) { erroCampo(mapa[e.dados.campo], e.message); return; }
    }
    if (e.codigo === 'LIMITE' && /telefone/i.test(e.message)) {
      const pend = pedidosSalvos().find(x => x.status === ST.AGUARDANDO);
      mostrarErroCk(esc(e.message) + (pend ? ` <button type="button" class="btn-link" data-abrir-pedido="${esc(pend.id)}">Abrir meu pedido pendente</button>` : ''));
      return;
    }
    if (e.codigo === 'RIFA_FECHADA') atualizarAgora();
    mostrarErroCk(esc(e.message));
  }

  /* ------------------------------------------------------------------
     Pedido: decide qual tela mostrar pela situação
     ------------------------------------------------------------------ */
  function mostrarPedido(resp, opc = {}) {
    const p = resp.pedido;
    E.pedido = p;
    if (resp.pagamento) E.pagamento = resp.pagamento;
    E.podeEnviar = !!resp.pode_enviar_comprovante;
    ajustarRelogio(p.agora);
    atualizarSalvo(p);
    pararVigia();

    if (p.status === ST.AGUARDANDO) {
      montarPix();
      if (E.etapa !== 'comprovante' || !dlg.open) mostrarEtapa('pix');
    } else if (p.status === ST.COMPROVANTE) {
      montarFinal('conferindo'); mostrarEtapa('final'); vigiarPedido();
    } else if (p.status === ST.CONFIRMADO) {
      montarFinal('confirmado'); mostrarEtapa('final', true);
    } else if (p.status === ST.EXPIRADO) {
      montarFinal('expirado'); mostrarEtapa('final');
    } else {
      montarFinal('cancelado'); mostrarEtapa('final');
    }
    if (opc.abrir !== false) abrirPainel();
  }

  async function consultar(id, token) {
    return Api.post('consultarPedido', { pedido_id: id, token }, { timeout: 20000 });
  }

  async function abrirPedidoSalvo(id) {
    const x = pedidosSalvos().find(i => i.id === id);
    if (!x) return;
    try {
      const r = await consultar(x.id, x.token);
      E.token = x.token;
      E.pagamento = null;
      mostrarPedido(r);
    } catch (e) {
      if (e.codigo === 'NAO_ENCONTRADO') { esquecerPedido(id); toast('Esse pedido não foi encontrado e saiu da lista.'); }
      else toast(e.message);
    }
  }

  async function retomarPedido() {
    const q = new URLSearchParams(location.search);
    const id = q.get('pedido'), t = q.get('t');
    if (id && t) {
      history.replaceState(null, '', location.pathname);   // tira o token da barra de endereço
      try {
        const r = await consultar(id, t);
        salvarPedido(r.pedido, t);
        E.token = t;
        mostrarPedido(r);
      } catch (e) {
        toast(e.codigo === 'NAO_ENCONTRADO' ? 'Não encontramos esse pedido. Confira o link.' : e.message, 6000);
      }
      return;
    }
    // atualiza em silêncio o pedido em andamento mais recente
    const emAndamento = pedidosSalvos().find(x => ativo(x.status));
    if (emAndamento) {
      try { atualizarSalvo((await consultar(emAndamento.id, emAndamento.token)).pedido); }
      catch (e) { if (e.codigo === 'NAO_ENCONTRADO') esquecerPedido(emAndamento.id); }
    }
  }

  async function consultarPedidoAtual() {
    if (!E.pedido || E.consultando || Date.now() - (E.ultimaConsulta || 0) < 8000) return;
    E.consultando = true;
    E.ultimaConsulta = Date.now();
    try { mostrarPedido(await consultar(E.pedido.pedido_id, E.token), { abrir: false }); }
    catch (e) { /* tenta de novo no próximo ciclo */ }
    finally { E.consultando = false; }
  }

  /* Aviso no topo da página para pedido em andamento */
  function atualizarAviso() {
    const x = pedidosSalvos().find(i => ativo(i.status));
    const box = $('#avisoPedido');
    if (!x || (x.status === ST.AGUARDANDO && Date.parse(x.expira) <= agoraServidor())) { box.hidden = true; return; }
    box.hidden = false;
    box.dataset.id = x.id;
    box.classList.toggle('conferindo', x.status === ST.COMPROVANTE);
    const nums = listaHumana(x.numeros || []);
    if (x.status === ST.AGUARDANDO) {
      box.querySelector('p').innerHTML = `Seu pedido com ${esc(plural((x.numeros || []).length, 'o número', 'os números'))} <strong>${esc(nums)}</strong> aguarda pagamento. Faltam <strong data-contagem-aviso>${formatarTempo(Date.parse(x.expira) - agoraServidor())}</strong>.`;
      $('#btnAvisoAbrir').textContent = 'Continuar pagamento';
    } else {
      box.querySelector('p').innerHTML = `Recebemos o comprovante do pedido com <strong>${esc(nums)}</strong>. A organização está conferindo.`;
      $('#btnAvisoAbrir').textContent = 'Ver pedido';
    }
  }

  const formatarTempo = ms => {
    const s = Math.max(0, Math.round(ms / 1000));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  };

  /* relógio de 1 em 1 segundo: contagem do Pix e do aviso */
  function tickRelogio() {
    const aviso = $('[data-contagem-aviso]');
    if (aviso) {
      const x = pedidosSalvos().find(i => i.id === $('#avisoPedido').dataset.id);
      const rest = x ? Date.parse(x.expira) - agoraServidor() : 0;
      if (rest <= 0) atualizarAviso(); else aviso.textContent = formatarTempo(rest);
    }
    if (!E.pedido || E.pedido.status !== ST.AGUARDANDO) return;
    const exp = Date.parse(E.pedido.expira_em);
    const rest = exp - agoraServidor();
    const total = E.cfg.prazo_reserva_minutos * 60000;
    $('#pxTempo').textContent = formatarTempo(rest);
    $('#pxBarra').style.width = Math.max(0, Math.min(100, rest / total * 100)) + '%';
    $('#pxRelogio').classList.toggle('urgente', rest < 3 * 60000);
    if (rest <= 0) consultarPedidoAtual();
  }

  /* ------------------------------------------------------------------
     Pix
     ------------------------------------------------------------------ */
  function montarPix() {
    const p = E.pedido, pg = E.pagamento || {};
    $('#pxValor').textContent = brl(p.valor_total);
    $('#pxCodigo').value = pg.copia_e_cola || '';
    $('#pxChave').textContent = pg.chave || '';
    $('#pxRecebedor').textContent = [pg.nome_recebedor, pg.cidade].filter(Boolean).join(', ');
    $('#pxNumeros').textContent = listaHumana(p.numeros);
    $('#pxPedido').textContent = p.pedido_id;
    if (pg.copia_e_cola) desenharQr(pg.copia_e_cola);
    tickRelogio();
  }

  function desenharQr(texto) {
    const cv = $('#pxQr'), img = $('#pxQrImg');
    if (typeof window.qrcode === 'function') {
      try {
        const qr = window.qrcode(0, 'M');
        qr.addData(texto); qr.make();
        const n = qr.getModuleCount(), margem = 4, tam = n + margem * 2;
        const escala = Math.max(4, Math.floor(600 / tam));
        cv.width = cv.height = tam * escala;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.fillStyle = '#2e1512';
        for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
          if (qr.isDark(r, c)) ctx.fillRect((c + margem) * escala, (r + margem) * escala, escala, escala);
        }
        cv.hidden = false; img.hidden = true;
        return;
      } catch (e) { /* cai para o serviço externo */ }
    }
    // reserva: serviço gratuito de QR Code (só é usado se a biblioteca local falhar)
    img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=12&data=' + encodeURIComponent(texto);
    img.hidden = false; cv.hidden = true;
  }

  /* ------------------------------------------------------------------
     Comprovante: prepara (comprime) e envia em Base64
     ------------------------------------------------------------------ */
  const LIMITE = 5 * 1024 * 1024;

  function lerDataURL(arquivo) {
    return new Promise((ok, falha) => {
      const r = new FileReader();
      r.onload = () => ok(r.result);
      r.onerror = () => falha(new Error('Não consegui ler o arquivo.'));
      r.readAsDataURL(arquivo);
    });
  }
  function carregarImagem(url) {
    return new Promise((ok, falha) => {
      const img = new Image();
      img.onload = () => ok(img);
      img.onerror = () => falha(new Error('imagem não decodificada'));
      img.src = url;
    });
  }
  async function comprimir(arquivo, maxLado, qualidade) {
    const url = URL.createObjectURL(arquivo);
    try {
      const img = await carregarImagem(url);
      const w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) throw new Error('imagem vazia');
      const k = Math.min(1, maxLado / Math.max(w, h));
      const cv = document.createElement('canvas');
      cv.width = Math.round(w * k); cv.height = Math.round(h * k);
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);   // PNG transparente vira fundo branco
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      return cv.toDataURL('image/jpeg', qualidade);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function prepararArquivo(f) {
    const nome = f.name || 'comprovante';
    const ehPdf = f.type === 'application/pdf' || /\.pdf$/i.test(nome);
    const ehHeic = /hei[cf]/i.test(f.type) || /\.hei[cf]$/i.test(nome);
    if (ehPdf) {
      if (f.size > LIMITE) throw new Error('O PDF passa de 5 MB. Envie um print da tela do comprovante.');
      return { nome, tipo: 'application/pdf', base64: await lerDataURL(f), previa: null, tamanho: f.size };
    }
    if (!/^image\//.test(f.type) && !ehHeic) throw new Error('Escolha uma imagem (foto ou print) ou um PDF.');
    try {
      const dataUrl = await comprimir(f, 1800, 0.82);
      return { nome: nome.replace(/\.[^.]+$/, '') + '.jpg', tipo: 'image/jpeg', base64: dataUrl, previa: dataUrl, tamanho: Math.round((dataUrl.length - 23) * 3 / 4) };
    } catch (e) {
      // o navegador não abriu a imagem (ex.: HEIC fora do iPhone): envia o original
      if (f.size > LIMITE) throw new Error('Não consegui abrir essa imagem e ela passa de 5 MB. Tire um print da tela do comprovante e envie o print.');
      return { nome, tipo: ehHeic ? 'image/heic' : f.type, base64: await lerDataURL(f), previa: null, tamanho: f.size };
    }
  }

  function prepararEtapaComprovante(texto) {
    E.arquivo = null;
    $('#cpArquivo').value = '';
    $('#cpPrevia').hidden = true;
    $('#cpErro').hidden = true;
    $('#cpRotulo').textContent = 'Escolher foto ou PDF';
    $('#btnEnviar').disabled = true;
    $('#cpTexto').textContent = texto || 'Uma foto ou print da tela do comprovante do Pix. Pode ser imagem ou PDF.';
    $('#btnVoltarPix').hidden = !(E.pedido && E.pedido.status === ST.AGUARDANDO);
    mostrarEtapa('comprovante');
  }

  async function aoEscolherArquivo(ev) {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    $('#cpErro').hidden = true;
    $('#cpRotulo').textContent = 'Preparando o arquivo…';
    $('#btnEnviar').disabled = true;
    try {
      E.arquivo = await prepararArquivo(f);
      const img = $('#cpImg');
      img.hidden = !E.arquivo.previa;
      if (E.arquivo.previa) img.src = E.arquivo.previa;
      $('#cpInfo').textContent = `${f.name} (${(E.arquivo.tamanho / 1024).toFixed(0)} KB)`;
      $('#cpPrevia').hidden = false;
      $('#cpRotulo').textContent = 'Trocar arquivo';
      $('#btnEnviar').disabled = false;
    } catch (e) {
      E.arquivo = null;
      $('#cpRotulo').textContent = 'Escolher foto ou PDF';
      const box = $('#cpErro'); box.textContent = e.message; box.hidden = false;
    }
  }

  async function enviarComprovante() {
    if (!E.arquivo || !E.pedido) return;
    const btn = $('#btnEnviar');
    btn.classList.add('carregando'); btn.disabled = true;
    $('#cpErro').hidden = true;
    try {
      const r = await Api.post('enviarComprovante', {
        pedido_id: E.pedido.pedido_id, token: E.token,
        arquivo: { nome: E.arquivo.nome, tipo: E.arquivo.tipo, base64: E.arquivo.base64 }
      }, { timeout: 90000 });
      E.arquivo = null;
      mostrarPedido({ pedido: r.pedido, pode_enviar_comprovante: true });
      atualizarAgora();
    } catch (e) {
      const box = $('#cpErro');
      box.innerHTML = esc(e.message) + (e.codigo === 'EXPIRADO' && E.cfg.whatsapp_contato
        ? ` <a href="${esc(linkWhats('Olá! Paguei o pedido ' + E.pedido.pedido_id + ' da ' + E.cfg.nome_rifa + ' depois do prazo.'))}" target="_blank" rel="noopener">Falar com a organização</a>` : '');
      box.hidden = false;
      btn.disabled = false;
    } finally {
      btn.classList.remove('carregando');
    }
  }

  /* vigia um pedido em conferência enquanto o painel está aberto */
  function vigiarPedido() {
    pararVigia();
    E.timers.vigia = setInterval(() => { if (dlg.open && !document.hidden) consultarPedidoAtual(); }, 25000);
  }
  function pararVigia() { clearInterval(E.timers.vigia); }

  /* ------------------------------------------------------------------
     Telas finais
     ------------------------------------------------------------------ */
  const ICONES = {
    ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    espera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    alerta: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 7.5v5.5"/><circle cx="12" cy="16.6" r=".6" fill="currentColor"/><circle cx="12" cy="12" r="8.5"/></svg>'
  };

  function montarFinal(tipo) {
    const p = E.pedido, c = E.cfg;
    const bilhetes = `<div class="linha-bilhetes">${p.numeros.map(n => `<span class="mini${tipo === 'confirmado' ? ' pago' : ''}">${n}</span>`).join('')}</div>`;
    const whats = c.whatsapp_contato
      ? `<a class="btn whats cheio" target="_blank" rel="noopener" href="${esc(linkWhats('Olá! Sobre o pedido ' + p.pedido_id + ' da ' + c.nome_rifa + '.'))}">Falar com a organização</a>` : '';
    const voltar = '<button type="button" class="btn-link" data-acao="fechar">Voltar para a rifa</button>';
    const copiarLink = '<button type="button" class="btn secundario cheio" data-copiar-link>Copiar link do pedido</button>';
    let html = '';

    if (tipo === 'conferindo') {
      html = `<div class="final-selo espera">${ICONES.espera}</div>
        <h2>Comprovante recebido</h2>
        <p>A organização vai conferir o pagamento. Quando for confirmado, esta tela muda sozinha. Você também pode voltar depois pelo link do pedido.</p>
        ${bilhetes}
        <p class="nota">Pedido ${esc(p.pedido_id)}, total de ${brl(p.valor_total)}.</p>
        <div class="acoes-final">${copiarLink}
          <button type="button" class="btn secundario cheio" data-acao="reenviar">Enviar outro comprovante</button>${whats}${voltar}</div>`;
    } else if (tipo === 'confirmado') {
      html = `<div class="final-selo ok">${ICONES.ok}</div>
        <h2>Pagamento confirmado</h2>
        <p>${plural(p.numeros.length, 'Seu número está', 'Seus números estão')} garantido${p.numeros.length === 1 ? '' : 's'} no sorteio. Boa sorte!</p>
        ${bilhetes}
        ${p.mensagem_final ? `<p class="mensagem">${esc(p.mensagem_final)}</p>` : ''}
        <div class="acoes-final">
          ${p.link_grupo ? `<a class="btn primario cheio" target="_blank" rel="noopener" href="${esc(p.link_grupo)}">Entrar no grupo</a>` : ''}
          ${copiarLink}${voltar}</div>`;
    } else if (tipo === 'expirado') {
      html = `<div class="final-selo alerta">${ICONES.alerta}</div>
        <h2>O prazo da reserva acabou</h2>` +
        (E.podeEnviar
          ? `<p>Se você já pagou, envie o comprovante agora: seus números ainda estão livres.</p>${bilhetes}
             <div class="acoes-final"><button type="button" class="btn primario cheio" data-acao="reenviar">Enviar comprovante</button>${whats}${voltar}</div>`
          : `<p>Os números voltaram para a venda e podem ter sido escolhidos por outra pessoa. Se você já pagou, fale com a organização e informe o pedido ${esc(p.pedido_id)}.</p>
             <div class="acoes-final">${whats}<button type="button" class="btn primario cheio" data-acao="fechar">Escolher números de novo</button></div>`);
    } else {
      html = `<div class="final-selo alerta">${ICONES.alerta}</div>
        <h2>Pedido cancelado</h2>
        ${p.motivo ? `<p class="mensagem">${esc(p.motivo)}</p>` : ''}
        <p>Os números deste pedido voltaram para a venda.</p>
        <div class="acoes-final">${whats}<button type="button" class="btn primario cheio" data-acao="fechar">Voltar para a rifa</button></div>`;
    }
    $('#finalBox').className = 'final' + (tipo === 'confirmado' ? ' celebra' : '');
    $('#finalBox').innerHTML = html;
  }

  /* ------------------------------------------------------------------
     Meus pedidos
     ------------------------------------------------------------------ */
  const dlgPedidos = $('#dlgPedidos');

  function renderMeusPedidos() {
    const lista = pedidosSalvos();
    $('#mpLista').innerHTML = lista.length ? lista.map(x => `
      <li data-id="${esc(x.id)}">
        <div class="lp-topo"><strong>${plural((x.numeros || []).length, '1 número', '# números')}, ${brl(x.valor)}</strong>
          <span class="selo-status ${esc(x.status)}">${esc(NOME_STATUS[x.status] || x.status)}</span></div>
        <p class="lp-nums">${esc(listaHumana(x.numeros || []))}</p>
        <div class="lp-acoes">
          <button type="button" class="btn-link" data-abrir-pedido="${esc(x.id)}">Abrir</button>
          <button type="button" class="btn-link" data-esquecer="${esc(x.id)}">Tirar deste aparelho</button>
        </div>
      </li>`).join('') : '<li>Nenhum pedido feito neste aparelho.</li>';
  }

  async function abrirMeusPedidos() {
    renderMeusPedidos();
    dlgPedidos.showModal();
    // atualiza até 5 pedidos que ainda podem mudar
    for (const x of pedidosSalvos().filter(i => ativo(i.status)).slice(0, 5)) {
      try { atualizarSalvo((await consultar(x.id, x.token)).pedido); renderMeusPedidos(); } catch (e) { /* segue */ }
    }
  }

  /* ------------------------------------------------------------------
     Eventos
     ------------------------------------------------------------------ */
  $('#grade').addEventListener('click', e => {
    const b = e.target.closest('.bil'); if (b) alternar(Number(b.dataset.n));
  });
  $('#soLivres').addEventListener('change', e => $('#grade').classList.toggle('so-livres', e.target.checked));
  $('#irPara').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); irPara(); } });
  $('#irPara').addEventListener('change', irPara);
  function mudarQtdSorte(d) {
    const o = $('#sorteQtd');
    const n = Math.min(E.cfg ? E.cfg.max_por_pedido : 50, Math.max(1, Number(o.textContent) + d));
    o.textContent = n;
    $('#btnSorte').textContent = n === 1 ? 'Escolher 1 para mim' : `Escolher ${n} para mim`;
  }
  $('#sorteMenos').addEventListener('click', () => mudarQtdSorte(-1));
  $('#sorteMais').addEventListener('click', () => mudarQtdSorte(1));
  $('#btnSorte').addEventListener('click', escolherParaMim);

  $('#chips').addEventListener('click', e => {
    const b = e.target.closest('button[data-n]'); if (!b) return;
    const n = Number(b.dataset.n); E.sel.delete(n); pintar(n - E.ini); atualizarCarrinho();
  });
  $('#btnLimpar').addEventListener('click', () => {
    const nums = [...E.sel]; E.sel.clear(); nums.forEach(n => pintar(n - E.ini)); atualizarCarrinho();
  });
  $('#btnCarrinhoAbrir').addEventListener('click', () => {
    if (!E.sel.size || matchMedia('(min-width: 980px)').matches) return;
    const aberto = $('#carrinho').classList.toggle('aberto');
    $('#btnCarrinhoAbrir').setAttribute('aria-expanded', String(aberto));
  });
  $('#btnReservar').addEventListener('click', abrirCheckout);

  $('#fTel').addEventListener('input', e => { e.target.value = formatarTel(e.target.value); });
  $('#formDados').addEventListener('input', e => {        // some com o aviso do campo assim que a pessoa corrige
    const c = e.target.closest('.campo');
    if (c && c.classList.contains('invalido')) {
      c.classList.remove('invalido');
      const d = c.querySelector('.dica-erro'); if (d) d.remove();
      e.target.removeAttribute('aria-invalid');
    }
  });
  $('#formDados').addEventListener('submit', enviarDados);
  $('#ckFechar').addEventListener('click', fecharPainel);
  dlg.addEventListener('close', () => { pararVigia(); atualizarAviso(); });

  $('#btnCopiarCodigo').addEventListener('click', async () => {
    const ok = await copiar($('#pxCodigo').value);
    const b = $('#btnCopiarCodigo');
    b.textContent = ok ? 'Código copiado' : 'Selecione e copie o código acima';
    setTimeout(() => { b.textContent = 'Copiar código Pix'; }, 2200);
  });
  $('#pxCodigo').addEventListener('focus', e => e.target.select());
  $('#btnCopiarChave').addEventListener('click', async () => toast((await copiar($('#pxChave').textContent)) ? 'Chave Pix copiada.' : 'Não consegui copiar. Selecione a chave e copie.'));
  $('#btnIrComprovante').addEventListener('click', () => prepararEtapaComprovante());
  $('#btnVoltarPix').addEventListener('click', () => mostrarEtapa('pix'));
  $('#cpArquivo').addEventListener('change', aoEscolherArquivo);
  $('#btnEnviar').addEventListener('click', enviarComprovante);

  // ações criadas dinamicamente (telas finais, mensagens de erro)
  document.addEventListener('click', async e => {
    const alvo = e.target.closest('[data-copiar-link], [data-acao], [data-abrir-pedido], [data-esquecer]');
    if (!alvo) return;
    if (alvo.hasAttribute('data-copiar-link')) {
      if (E.pedido && E.token) toast((await copiar(linkPedido(E.pedido.pedido_id, E.token))) ? 'Link do pedido copiado. Guarde em lugar seguro.' : 'Não consegui copiar o link.');
    } else if (alvo.dataset.acao === 'fechar') {
      fecharPainel();
    } else if (alvo.dataset.acao === 'reenviar') {
      prepararEtapaComprovante(E.pedido && E.pedido.status === ST.COMPROVANTE
        ? 'Envie outro arquivo se o anterior estava errado ou ilegível. Ele substitui o que você mandou.' : undefined);
    } else if (alvo.dataset.abrirPedido) {
      if (dlgPedidos.open) dlgPedidos.close();
      abrirPedidoSalvo(alvo.dataset.abrirPedido);
    } else if (alvo.dataset.esquecer) {
      esquecerPedido(alvo.dataset.esquecer); renderMeusPedidos();
    }
  });

  $('#btnAvisoAbrir').addEventListener('click', () => abrirPedidoSalvo($('#avisoPedido').dataset.id));
  $('#btnMeusPedidos').addEventListener('click', abrirMeusPedidos);
  $('#mpFechar').addEventListener('click', () => dlgPedidos.close());
  $('#btnTentar').addEventListener('click', iniciar);
  $('#btnCompartilhar').addEventListener('click', async () => {
    const url = location.origin + location.pathname;
    if (navigator.share) { try { await navigator.share({ title: E.cfg.nome_rifa, text: 'Escolha seus números da ' + E.cfg.nome_rifa, url }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    toast((await copiar(url)) ? 'Link da rifa copiado.' : url);
  });

  iniciar();
})();