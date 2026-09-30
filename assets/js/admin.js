/* =====================================================================
   admin.js — painel da tesouraria
   ---------------------------------------------------------------------
   Todas as ações passam pelo servidor, que confere a sessão e as regras.
   Este código só organiza a tela.
   ===================================================================== */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const brl = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const listaHumana = nums => { const a = nums.map(String); return a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' e ' + a[a.length - 1]; };
  const plural = (n, um, varios) => n === 1 ? um : varios.replace('#', n);
  const dataHora = iso => iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  const fmtTel = t => {
    const d = String(t || '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
    if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
    if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return d;
  };
  const formatarTempo = ms => {
    const s = Math.max(0, Math.round(ms / 1000));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  };

  const ST = {
    AGUARDANDO: 'AGUARDANDO_PAGAMENTO', COMPROVANTE: 'COMPROVANTE_ENVIADO',
    CONFIRMADO: 'PAGAMENTO_CONFIRMADO', EXPIRADO: 'EXPIRADO', CANCELADO: 'CANCELADO'
  };
  const NOME_STATUS = {
    AGUARDANDO_PAGAMENTO: 'Aguardando pagamento', COMPROVANTE_ENVIADO: 'Para conferir',
    PAGAMENTO_CONFIRMADO: 'Confirmado', EXPIRADO: 'Prazo encerrado', CANCELADO: 'Cancelado'
  };
  const NOME_FORMA = { PIX_MANUAL: 'Pix', DINHEIRO: 'Dinheiro', CARTAO: 'Cartão', TRANSFERENCIA: 'Transferência', OUTRO: 'Outro' };

  function toast(msg, ms = 4200) {
    const el = document.createElement('div');
    el.className = 'toast'; el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.classList.add('saindo'); setTimeout(() => el.remove(), 220); }, ms);
  }
  async function copiar(texto) {
    try { await navigator.clipboard.writeText(texto); return true; }
    catch (e) {
      const ta = document.createElement('textarea'); ta.value = texto; document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch (_) { /* segue */ }
      ta.remove(); return ok;
    }
  }

  /* ------------------------------------------------------------------
     Estado
     ------------------------------------------------------------------ */
  const A = {
    cfg: null,
    aba: 'resumo',
    filtro: ST.COMPROVANTE,
    busca: '',
    pedidos: [],
    vistos: null,            // pedidos em conferência já exibidos (para realçar os novos)
    qtdConferir: null,
    offset: 0,
    grade: { ini: 0, fim: -1, letras: [], celulas: [] },
    sel: new Set(),
    timers: {}
  };
  const agoraServidor = () => Date.now() + A.offset;
  const siteUrl = caminho => new URL(caminho, location.href).href;
  const linkPedido = p => siteUrl('index.html?pedido=' + encodeURIComponent(p.pedido_id) + '&t=' + encodeURIComponent(p.token_pedido));

  /* ------------------------------------------------------------------
     Entrada e sessão
     ------------------------------------------------------------------ */
  function mostrarLogin(msg) {
    pararTimers();
    $('#telaPainel').hidden = true;
    $('#telaLogin').hidden = false;
    const e = $('#lgErro');
    if (msg) { e.textContent = msg; e.hidden = false; } else e.hidden = true;
    setTimeout(() => ($('#lgNome').value ? $('#lgSenha') : $('#lgNome')).focus(), 50);
  }

  async function entrarPainel() {
    const s = Sessao.atual();
    if (!s) return mostrarLogin();
    $('#telaLogin').hidden = true;
    $('#telaPainel').hidden = false;
    $('#topoUsuario').textContent = 'Conectado como ' + s.nome;
    try {
      A.cfg = await Api.get('config');
      $('#topoRifa').textContent = A.cfg.nome_rifa;
      document.title = 'Painel · ' + A.cfg.nome_rifa;
    } catch (e) { /* o resto do painel ainda funciona */ }
    trocarAba((location.hash || '#resumo').slice(1));
    atualizarResumo();
    A.timers.ciclo = setInterval(() => { if (!document.hidden) cicloAtualizacao(); }, 30000);
    A.timers.relogio = setInterval(tickPrazos, 1000);
  }

  function pararTimers() { Object.values(A.timers).forEach(t => { clearInterval(t); clearTimeout(t); }); A.timers = {}; }

  function cicloAtualizacao() {
    atualizarResumo();
    if (A.aba === 'pedidos' && !$('#dlgAcao').open && !$('.ped-mais[open]')) carregarPedidos();
    if (A.aba === 'numeros') carregarGrade();
  }

  Sessao.aoExpirar(msg => mostrarLogin(msg));
  Sessao.ligarFormulario($('#formLogin'), entrarPainel);

  /* ------------------------------------------------------------------
     Abas
     ------------------------------------------------------------------ */
  const ABAS = { resumo: ['#abaResumo', '#secResumo'], pedidos: ['#abaPedidos', '#secPedidos'], numeros: ['#abaNumeros', '#secNumeros'] };
  function trocarAba(nome) {
    if (!ABAS[nome]) nome = 'resumo';
    A.aba = nome;
    Object.entries(ABAS).forEach(([k, [aba, sec]]) => {
      $(aba).setAttribute('aria-selected', String(k === nome));
      $(sec).hidden = k !== nome;
    });
    history.replaceState(null, '', '#' + nome);
    if (nome === 'pedidos') carregarPedidos();
    if (nome === 'numeros') carregarGrade();
    atualizarBarraSelecao();
  }
  $('#abaResumo').addEventListener('click', () => trocarAba('resumo'));
  $('#abaPedidos').addEventListener('click', () => trocarAba('pedidos'));
  $('#abaNumeros').addEventListener('click', () => trocarAba('numeros'));

  /* ------------------------------------------------------------------
     Resumo
     ------------------------------------------------------------------ */
  async function atualizarResumo() {
    let d;
    try { d = await Sessao.chamar('dashboard'); } catch (e) { if (e.codigo !== 'NAO_AUTORIZADO' && e.codigo !== 'SESSAO_EXPIRADA') $('#resumoAtualizado').textContent = 'Não foi possível atualizar: ' + e.message; return; }
    const v = d.valores, n = d.numeros, p = d.pedidos;
    $('#vArrecadado').textContent = brl(v.arrecadado);
    $('#vPagantes').textContent = `${plural(d.compradores_pagantes, '1 comprador', '# compradores')} com pagamento confirmado`;
    $('#vConferir').textContent = brl(v.a_conferir);
    $('#vConferirQtd').textContent = p.COMPROVANTE_ENVIADO ? plural(p.COMPROVANTE_ENVIADO, '1 pedido esperando você', '# pedidos esperando você') : 'Nenhum pedido esperando';
    $('#vConferirBtn').classList.toggle('tem', p.COMPROVANTE_ENVIADO > 0);
    $('#vAguardando').textContent = brl(v.aguardando_pagamento);
    $('#vAguardandoQtd').textContent = plural(p.AGUARDANDO_PAGAMENTO || 0, '1 reserva dentro do prazo', '# reservas dentro do prazo');

    const aVenda = (n.total - n.fora_de_venda) || 1;
    $('#nTexto').textContent = `${n.pagos} de ${n.total - n.fora_de_venda} números vendidos (${String(d.percentual_vendido).replace('.', ',')}%). Potencial total: ${brl(v.potencial_total)}.`;
    $('#nBarraP').style.width = (n.pagos / aVenda * 100) + '%';
    $('#nBarraR').style.width = (n.reservados / aVenda * 100) + '%';
    $('#nPagos').textContent = n.pagos; $('#nReservados').textContent = n.reservados;
    $('#nLivres').textContent = n.disponiveis; $('#nFora').textContent = n.fora_de_venda;
    $('#mExpirados').textContent = d.expirados_aguardando_limpeza
      ? `${plural(d.expirados_aguardando_limpeza, '1 reserva vencida ainda aparece', '# reservas vencidas ainda aparecem')} na planilha. O sistema limpa a cada 5 minutos.`
      : 'Nenhuma reserva vencida pendente. O sistema faz isso sozinho a cada 5 minutos.';

    const alertas = [];
    if (d.status_rifa !== 'ABERTA') alertas.push(`<div class="alerta aviso-cfg"><strong>As vendas não estão abertas (${esc(d.status_rifa)}).</strong>Para abrir, mude status_rifa para ABERTA na aba CONFIG.</div>`);
    if (d.problemas_config.length) alertas.push(`<div class="alerta erro-cfg"><strong>Problemas na configuração que impedem vender</strong><ul>${d.problemas_config.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`);
    const avisos = d.avisos_config.filter(x => !/status_rifa/.test(x));
    if (avisos.length) alertas.push(`<div class="alerta aviso-cfg"><strong>Avisos</strong><ul>${avisos.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`);
    $('#alertasConfig').innerHTML = alertas.join('');
    $('#resumoAtualizado').textContent = 'Atualizado às ' + new Date(d.atualizado_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + '. O painel se atualiza a cada 30 segundos.';

    const qtd = p.COMPROVANTE_ENVIADO || 0;
    if (A.qtdConferir !== null && qtd > A.qtdConferir) toast(qtd - A.qtdConferir === 1 ? 'Chegou um comprovante novo para conferir.' : `Chegaram ${qtd - A.qtdConferir} comprovantes novos para conferir.`, 6000);
    A.qtdConferir = qtd;
    const badge = $('#badgeConferir');
    badge.hidden = !qtd; badge.textContent = qtd;
    document.title = (qtd ? `(${qtd}) ` : '') + 'Painel · ' + (A.cfg ? A.cfg.nome_rifa : 'rifa');
  }

  $('#vConferirBtn').addEventListener('click', () => { definirFiltro(ST.COMPROVANTE); trocarAba('pedidos'); });
  $('#btnLiberar').addEventListener('click', async ev => {
    const b = ev.currentTarget; b.classList.add('carregando');
    try {
      const r = await Sessao.chamar('liberarExpirados');
      toast(r.numeros_liberados || r.pedidos_expirados
        ? `${plural(r.pedidos_expirados, '1 pedido encerrado', '# pedidos encerrados')} e ${plural(r.numeros_liberados, '1 número liberado', '# números liberados')}.`
        : 'Não havia reservas vencidas.');
      atualizarResumo();
    } catch (e) { toast(e.message); } finally { b.classList.remove('carregando'); }
  });
  $('#btnCache').addEventListener('click', async ev => {
    const b = ev.currentTarget; b.classList.add('carregando');
    try { await Sessao.chamar('limparCache'); toast('Pronto. A configuração da planilha já vale no site.'); atualizarResumo(); }
    catch (e) { toast(e.message); } finally { b.classList.remove('carregando'); }
  });

  /* ------------------------------------------------------------------
     Pedidos
     ------------------------------------------------------------------ */
  function definirFiltro(f) {
    A.filtro = f;
    $$('.filtros button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.filtro === f)));
  }

  async function carregarPedidos() {
    const info = $('#pedidosInfo');
    try {
      const r = await Sessao.chamar('listarPedidos', { status: A.busca ? '' : A.filtro, busca: A.busca, limite: 300 });
      A.offset = Date.parse(r.agora) - Date.now();
      const novos = new Set();
      if (A.vistos) r.pedidos.forEach(p => { if (p.status === ST.COMPROVANTE && !A.vistos.has(p.pedido_id)) novos.add(p.pedido_id); });
      A.vistos = A.vistos || new Set();
      r.pedidos.forEach(p => { if (p.status === ST.COMPROVANTE) A.vistos.add(p.pedido_id); });
      A.pedidos = r.pedidos;
      info.textContent = A.busca
        ? `${plural(r.total, '1 pedido encontrado', '# pedidos encontrados')} para "${A.busca}", em qualquer situação.`
        : (r.total > r.pedidos.length ? `Mostrando os ${r.pedidos.length} mais recentes de ${r.total}.` : '');
      renderPedidos(novos);
    } catch (e) {
      if (e.codigo !== 'NAO_AUTORIZADO' && e.codigo !== 'SESSAO_EXPIRADA') info.textContent = 'Não foi possível carregar os pedidos: ' + e.message;
    }
  }

  const VAZIO = {
    COMPROVANTE_ENVIADO: 'Nenhum comprovante esperando conferência. Quando alguém enviar, ele aparece aqui.',
    AGUARDANDO_PAGAMENTO: 'Nenhuma reserva aguardando pagamento agora.',
    PAGAMENTO_CONFIRMADO: 'Nenhum pagamento confirmado ainda.',
    EXPIRADO: 'Nenhum pedido com prazo encerrado.',
    CANCELADO: 'Nenhum pedido cancelado.',
    '': 'Nenhum pedido ainda.'
  };

  function renderPedidos(novos) {
    const ul = $('#listaPedidos');
    if (!A.pedidos.length) { ul.innerHTML = `<li class="vazio-lista">${esc(A.busca ? 'Nada encontrado com essa busca.' : VAZIO[A.filtro])}</li>`; return; }
    // comprovantes para conferir: o mais antigo primeiro (quem pagou antes é atendido antes)
    const itens = A.filtro === ST.COMPROVANTE && !A.busca
      ? [...A.pedidos].sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0)) : A.pedidos;
    ul.innerHTML = itens.map(p => cardPedido(p, novos && novos.has(p.pedido_id))).join('');
    tickPrazos();
  }

  function cardPedido(p, novo) {
    const tel = p.telefone
      ? `<a href="https://wa.me/${esc(p.telefone)}" target="_blank" rel="noopener">${esc(fmtTel(p.telefone))}</a>` : 'sem telefone';
    const meta = [tel, p.congregacao ? esc(p.congregacao) : '', 'pedido feito em ' + esc(dataHora(p.data))].filter(Boolean).join(', ');
    const nums = `<div class="linha-bilhetes">${p.numeros.map(n => `<span class="mini${p.status === ST.CONFIRMADO ? ' pago' : ''}">${n}</span>`).join('')}</div>`;

    let comprovante = '';
    if (p.comprovante_url) {
      comprovante = `<div class="ped-comprovante"><a href="${esc(p.comprovante_url)}" target="_blank" rel="noopener">Abrir comprovante no Drive</a>`
        + (p.status === ST.COMPROVANTE ? `<span class="nota">Confira no extrato se entrou ${brl(p.valor_total)}.</span>` : '') + '</div>';
    }
    if (p.status === ST.AGUARDANDO && p.expira_em) {
      comprovante += `<div class="ped-comprovante"><span class="ped-prazo" data-expira="${esc(p.expira_em)}"></span></div>`;
    }

    const b = (acao, rotulo, cls = 'secundario') => `<button type="button" class="btn ${cls}" data-acao="${acao}" data-id="${esc(p.pedido_id)}">${rotulo}</button>`;
    let acoes = '';
    if (p.status === ST.COMPROVANTE) acoes = b('confirmar', 'Confirmar pagamento', 'primario') + b('recusar', 'Recusar');
    else if (p.status === ST.AGUARDANDO) acoes = b('confirmar', 'Confirmar pagamento') + b('recusar', 'Cancelar reserva');
    else if (p.status === ST.EXPIRADO || p.status === ST.CANCELADO) acoes = b('confirmar', 'Confirmar mesmo assim');

    const mais = `<details class="ped-mais"><summary>Mais opções</summary><div class="ped-mais-corpo">
        ${p.telefone ? `<a class="btn-link" target="_blank" rel="noopener" href="${esc(linkWhats(p, 'geral'))}">Mandar mensagem no WhatsApp</a>` : ''}
        <button type="button" class="btn-link" data-acao="link" data-id="${esc(p.pedido_id)}">Copiar link do pedido (para a pessoa)</button>
        ${p.status !== ST.CANCELADO ? `<button type="button" class="btn-link perigo" data-acao="cancelar" data-id="${esc(p.pedido_id)}">Cancelar pedido</button>` : ''}
        ${p.observacao ? `<p class="ped-historico"><strong>Histórico:</strong>\n${esc(p.observacao.split(' | ').join('\n'))}</p>` : ''}
        <p class="nota">Código ${esc(p.pedido_id)}${p.data_confirmacao ? ', confirmado em ' + esc(dataHora(p.data_confirmacao)) : ''}${p.email ? ', ' + esc(p.email) : ''}</p>
      </div></details>`;

    return `<li class="pedido ${esc(p.status)}${novo ? ' novo' : ''}">
      <div class="ped-topo"><div><div class="ped-nome">${esc(p.nome)}</div><p class="ped-meta">${meta}</p></div>
        <span class="selo-status ${esc(p.status)}">${esc(NOME_STATUS[p.status] || p.status)}</span></div>
      <div class="ped-linha">${nums}<div class="ped-valor"><strong>${brl(p.valor_total)}</strong><span>${esc(NOME_FORMA[p.forma_pagamento] || p.forma_pagamento)}, ${plural(p.quantidade, '1 número', '# números')}</span></div></div>
      ${comprovante}
      <div class="ped-acoes">${acoes}${mais}</div>
    </li>`;
  }

  function tickPrazos() {
    $$('[data-expira]').forEach(el => {
      const rest = Date.parse(el.dataset.expira) - agoraServidor();
      el.classList.toggle('vencido', rest <= 0);
      el.textContent = rest > 0 ? `Reserva vence em ${formatarTempo(rest)}` : 'Prazo vencido: a reserva será liberada automaticamente';
    });
  }

  $$('.filtros button').forEach(b => b.addEventListener('click', () => {
    definirFiltro(b.dataset.filtro);
    if (A.busca) { A.busca = ''; $('#busca').value = ''; }
    carregarPedidos();
  }));
  $('#busca').addEventListener('input', e => {
    clearTimeout(A.timers.busca);
    A.timers.busca = setTimeout(() => { A.busca = e.target.value.trim(); carregarPedidos(); }, 450);
  });

  /* ------------------------------------------------------------------
     Mensagens de WhatsApp prontas
     ------------------------------------------------------------------ */
  function linkWhats(p, tipo, motivo) {
    const primeiro = String(p.nome || '').split(' ')[0];
    const rifa = A.cfg ? A.cfg.nome_rifa : 'rifa';
    const nums = listaHumana(p.numeros);
    const txt = {
      confirmado: `Olá, ${primeiro}! Confirmamos o seu pagamento da ${rifa}. ${p.numeros.length === 1 ? 'Seu número' : 'Seus números'}: ${nums}. Boa sorte!`,
      novoComprovante: `Olá, ${primeiro}! Não conseguimos confirmar o pagamento do pedido ${p.pedido_id} (números ${nums}): ${motivo}. Os números continuam guardados para você. Envie um novo comprovante por aqui: ${linkPedido(p)}`,
      recusado: `Olá, ${primeiro}! Não conseguimos confirmar o pagamento do pedido ${p.pedido_id} (números ${nums}): ${motivo}. Os números voltaram para a venda. Se quiser participar, é só escolher de novo: ${siteUrl('index.html')}`,
      cancelado: `Olá, ${primeiro}! O pedido ${p.pedido_id} da ${rifa} (números ${nums}) foi cancelado: ${motivo}.`,
      aguardando: `Olá, ${primeiro}! Seu pedido ${p.pedido_id} com os números ${nums} aguarda o pagamento de ${brl(p.valor_total)}. Para pagar ou enviar o comprovante: ${linkPedido(p)}`,
      geral: p.status === ST.AGUARDANDO
        ? `Olá, ${primeiro}! Seu pedido ${p.pedido_id} com os números ${nums} aguarda o pagamento de ${brl(p.valor_total)}. Para pagar ou enviar o comprovante: ${linkPedido(p)}`
        : `Olá, ${primeiro}! Sobre o seu pedido ${p.pedido_id} da ${rifa} (números ${nums}):`
    }[tipo];
    return 'https://wa.me/' + p.telefone + '?text=' + encodeURIComponent(txt);
  }

  /* ------------------------------------------------------------------
     Janela de ação genérica
     ------------------------------------------------------------------ */
  const dlg = $('#dlgAcao');
  let acaoAtual = null;

  function abrirJanela({ titulo, corpo, botao, perigo = false, executar }) {
    acaoAtual = executar;
    $('#acTitulo').textContent = titulo;
    $('#acCorpo').innerHTML = corpo;
    $('#acErro').hidden = true;
    const b = $('#acConfirmar');
    b.hidden = false; b.textContent = botao; b.className = 'btn ' + (perigo ? 'perigo' : 'primario');
    $('[data-fechar].btn-link', dlg).textContent = 'Voltar';
    dlg.showModal();
    const campo = $('#acCorpo textarea, #acCorpo input:not([type=radio]):not([type=checkbox])');
    setTimeout(() => (campo || b).focus(), 50);
  }
  /* troca o conteúdo da janela por uma tela de "feito", com próximos passos */
  function janelaConcluida(html) {
    acaoAtual = null;
    $('#acCorpo').innerHTML = html;
    $('#acConfirmar').hidden = true;
    $('[data-fechar].btn-link', dlg).textContent = 'Fechar';
  }

  $('#formAcao').addEventListener('submit', async ev => {
    ev.preventDefault();
    if (!acaoAtual) { dlg.close(); return; }
    const b = $('#acConfirmar');
    $('#acErro').hidden = true;
    b.classList.add('carregando'); b.disabled = true;
    try {
      await acaoAtual($('#acCorpo'));
    } catch (e) {
      $('#acErro').textContent = e.message; $('#acErro').hidden = false;
    } finally {
      b.classList.remove('carregando'); b.disabled = false;
    }
  });
  $$('[data-fechar]', dlg).forEach(b => b.addEventListener('click', () => dlg.close()));
  dlg.addEventListener('close', () => { acaoAtual = null; });

  const resumoPedido = p => `<div class="resumo-acao"><strong>${esc(p.nome)}</strong>, ${brl(p.valor_total)}
    <div class="linha-bilhetes">${p.numeros.map(n => `<span class="mini">${n}</span>`).join('')}</div></div>`;
  const erroValidacao = msg => new Api.ErroApi(msg, 'VALIDACAO');
  const depoisDeMudar = () => { carregarPedidos(); atualizarResumo(); if (A.aba === 'numeros') carregarGrade(); };

  /* Confirmar pagamento */
  function janelaConfirmar(p) {
    const forcar = p.status === ST.EXPIRADO || p.status === ST.CANCELADO;
    abrirJanela({
      titulo: 'Confirmar pagamento',
      corpo: resumoPedido(p) +
        (p.comprovante_url ? `<p><a href="${esc(p.comprovante_url)}" target="_blank" rel="noopener">Abrir o comprovante</a> e conferir no extrato do banco se entrou ${brl(p.valor_total)}.</p>`
          : `<p>Esta pessoa não enviou comprovante. Confirme só se o valor de ${brl(p.valor_total)} já entrou na conta.</p>`) +
        (forcar ? '<p><strong>Este pedido está com o prazo encerrado.</strong> Os números voltam para a pessoa se ainda estiverem livres; se algum já foi de outra pessoa, o sistema avisa e não confirma.</p>' : '') +
        '<label class="campo"><span>Observação <small>(opcional)</small></span><textarea id="acObs" rows="2" maxlength="300" placeholder="Ex.: conferido no extrato às 14h"></textarea></label>',
      botao: 'Confirmar pagamento',
      executar: async corpo => {
        const r = await Sessao.chamar('confirmarPagamento', { pedido_id: p.pedido_id, observacao: $('#acObs', corpo).value, forcar });
        depoisDeMudar();
        toast('Pagamento de ' + r.pedido.nome + ' confirmado.');
        janelaConcluida(`<p><strong>Pagamento confirmado.</strong> ${plural(p.numeros.length, 'O número', 'Os números')} ${esc(listaHumana(p.numeros))} ${p.numeros.length === 1 ? 'já concorre' : 'já concorrem'} no sorteio.</p>` +
          (p.telefone ? `<p><a class="btn whats" target="_blank" rel="noopener" href="${esc(linkWhats(r.pedido, 'confirmado'))}">Avisar ${esc(p.nome.split(' ')[0])} pelo WhatsApp</a></p>` : ''));
      }
    });
  }

  /* Recusar comprovante ou cancelar reserva */
  const MOTIVOS = ['Comprovante ilegível', 'Valor diferente do pedido', 'Pagamento não encontrado no extrato'];
  function janelaRecusar(p) {
    const temComprovante = p.status === ST.COMPROVANTE;
    abrirJanela({
      titulo: temComprovante ? 'Recusar comprovante' : 'Cancelar reserva',
      corpo: resumoPedido(p) +
        `<label class="campo"><span>Motivo <small>(a pessoa vê este texto)</small></span><textarea id="acMotivo" rows="2" maxlength="300"></textarea></label>
         <p class="nota">Sugestões: ${MOTIVOS.map(m => `<button type="button" class="btn-link" data-motivo="${esc(m)}">${esc(m)}</button>`).join(' ')}</p>` +
        (temComprovante ? `<fieldset class="opcoes"><legend>O que fazer com os números?</legend>
          <label class="opcao"><input type="radio" name="modo" value="NOVO_COMPROVANTE" checked><span>Manter os números e pedir outro comprovante<small>A pessoa ganha um novo prazo de ${A.cfg ? A.cfg.prazo_reserva_minutos : 30} minutos.</small></span></label>
          <label class="opcao"><input type="radio" name="modo" value="LIBERAR"><span>Cancelar o pedido e liberar os números<small>Eles voltam para a venda na hora.</small></span></label>
        </fieldset>` : '<p>Os números voltam para a venda na hora.</p>'),
      botao: temComprovante ? 'Recusar' : 'Cancelar reserva',
      perigo: true,
      executar: async corpo => {
        const motivo = $('#acMotivo', corpo).value.trim();
        if (motivo.length < 3) throw erroValidacao('Escreva o motivo. A pessoa vai ver esse texto.');
        const modo = temComprovante ? $('input[name=modo]:checked', corpo).value : 'LIBERAR';
        const r = await Sessao.chamar('recusarPagamento', { pedido_id: p.pedido_id, motivo, acao: modo });
        depoisDeMudar();
        const tipo = modo === 'NOVO_COMPROVANTE' ? 'novoComprovante' : 'recusado';
        janelaConcluida(`<p><strong>${modo === 'NOVO_COMPROVANTE' ? 'Pedido devolvido para novo comprovante.' : 'Pedido cancelado e números liberados.'}</strong></p>` +
          (p.telefone ? `<p><a class="btn whats" target="_blank" rel="noopener" href="${esc(linkWhats(r.pedido, tipo, motivo))}">Avisar ${esc(p.nome.split(' ')[0])} pelo WhatsApp</a></p>` : ''));
      }
    });
  }

  /* Cancelar qualquer pedido (inclusive pago) */
  function janelaCancelar(p) {
    const pago = p.status === ST.CONFIRMADO;
    abrirJanela({
      titulo: 'Cancelar pedido',
      corpo: resumoPedido(p) +
        `<label class="campo"><span>Motivo <small>(a pessoa vê este texto)</small></span><textarea id="acMotivo" rows="2" maxlength="300"></textarea></label>` +
        (pago ? `<label class="opcao" style="margin-top:14px"><input type="checkbox" id="acPago"><span>Este pedido já foi pago. Confirmo que o valor de ${brl(p.valor_total)} será devolvido.<small>Os números saem do sorteio e voltam para a venda.</small></span></label>`
          : '<p>Os números voltam para a venda na hora.</p>'),
      botao: 'Cancelar pedido',
      perigo: true,
      executar: async corpo => {
        const motivo = $('#acMotivo', corpo).value.trim();
        if (motivo.length < 3) throw erroValidacao('Escreva o motivo do cancelamento.');
        if (pago && !$('#acPago', corpo).checked) throw erroValidacao('Marque a confirmação da devolução para cancelar um pedido pago.');
        const r = await Sessao.chamar('cancelarPedido', { pedido_id: p.pedido_id, motivo, confirmar_pago: pago });
        depoisDeMudar();
        janelaConcluida('<p><strong>Pedido cancelado.</strong> Os números voltaram para a venda.</p>' +
          (p.telefone ? `<p><a class="btn whats" target="_blank" rel="noopener" href="${esc(linkWhats(r.pedido, 'cancelado', motivo))}">Avisar ${esc(p.nome.split(' ')[0])} pelo WhatsApp</a></p>` : ''));
      }
    });
  }

  $('#acCorpo').addEventListener('click', e => {
    const m = e.target.closest('[data-motivo]');
    if (m) { const ta = $('#acMotivo'); ta.value = m.dataset.motivo; ta.focus(); $('#acErro').hidden = true; }
  });
  $('#acCorpo').addEventListener('input', () => { $('#acErro').hidden = true; });

  $('#listaPedidos').addEventListener('click', async e => {
    const b = e.target.closest('[data-acao]');
    if (!b) return;
    const p = A.pedidos.find(x => x.pedido_id === b.dataset.id);
    if (!p) return;
    if (b.dataset.acao === 'confirmar') janelaConfirmar(p);
    else if (b.dataset.acao === 'recusar') janelaRecusar(p);
    else if (b.dataset.acao === 'cancelar') janelaCancelar(p);
    else if (b.dataset.acao === 'link') toast((await copiar(linkPedido(p))) ? 'Link do pedido copiado. Envie só para a própria pessoa.' : 'Não consegui copiar o link.');
  });

  /* ------------------------------------------------------------------
     Números: grade, venda presencial e bloqueio
     ------------------------------------------------------------------ */
  const G = A.grade;
  const NOME_LETRA = { D: 'livre', R: 'reservado', P: 'pago', X: 'fora de venda' };

  async function carregarGrade() {
    try {
      const st = await Api.get('status');
      if (st.inicial !== G.ini || st.final !== G.fim) construirGrade(st);
      const perdidos = [];
      for (let i = 0; i < st.s.length; i++) {
        const l = st.s.charAt(i), n = G.ini + i;
        if (A.sel.has(n) && l !== 'D' && l !== 'X') { A.sel.delete(n); perdidos.push(n); }
        if (l !== G.letras[i] || perdidos.includes(n)) { G.letras[i] = l; pintar(i); }
      }
      if (perdidos.length) toast(`${listaHumana(perdidos)} ${perdidos.length === 1 ? 'foi reservado' : 'foram reservados'} pelo site e ${perdidos.length === 1 ? 'saiu' : 'saíram'} da seleção.`);
      atualizarBarraSelecao();
    } catch (e) { toast('Não foi possível atualizar os números: ' + e.message); }
  }
  function construirGrade(st) {
    G.ini = st.inicial; G.fim = st.final; G.letras = []; G.celulas = [];
    const frag = document.createDocumentFragment();
    for (let n = st.inicial; n <= st.final; n++) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'bil'; b.dataset.n = n; b.textContent = n;
      frag.appendChild(b); G.celulas.push(b); G.letras.push('');
    }
    const g = $('#gradeAdmin'); g.textContent = ''; g.appendChild(frag);
  }
  function pintar(i) {
    const b = G.celulas[i]; if (!b) return;
    const n = G.ini + i, l = G.letras[i] || 'X', sel = A.sel.has(n);
    b.className = 'bil ' + l.toLowerCase() + (sel ? ' s' : '');
    b.setAttribute('aria-pressed', String(sel));
    b.setAttribute('aria-label', `Número ${n}: ${sel ? 'selecionado, ' : ''}${NOME_LETRA[l]}`);
  }

  $('#gradeAdmin').addEventListener('click', e => {
    const b = e.target.closest('.bil'); if (!b) return;
    const n = Number(b.dataset.n), l = G.letras[n - G.ini];
    if (l === 'R' || l === 'P') {           // mostra o pedido desse número
      A.busca = String(n); $('#busca').value = String(n);
      definirFiltro(''); trocarAba('pedidos');
      return;
    }
    if (A.sel.has(n)) A.sel.delete(n); else A.sel.add(n);
    pintar(n - G.ini);
    atualizarBarraSelecao();
  });

  function atualizarBarraSelecao() {
    const nums = [...A.sel].sort((a, b) => a - b);
    const barra = $('#barraSel');
    const mostrar = A.aba === 'numeros' && nums.length > 0;
    barra.hidden = !mostrar;
    document.body.classList.toggle('com-selecao', mostrar);
    if (!mostrar) return;
    const livres = nums.filter(n => G.letras[n - G.ini] === 'D');
    const fora = nums.filter(n => G.letras[n - G.ini] === 'X');
    const valor = A.cfg ? ', ' + brl(livres.length * A.cfg.valor_numero) : '';
    $('#selTexto').textContent = `${plural(nums.length, '1 número selecionado', '# números selecionados')}: ${listaHumana(nums)}${fora.length ? '' : valor}`;
    $('#btnVendaManual').disabled = $('#btnBloquear').disabled = !(livres.length === nums.length);
    $('#btnDesbloquear').disabled = !(fora.length === nums.length);
  }
  function limparSelecao() { const nums = [...A.sel]; A.sel.clear(); nums.forEach(n => pintar(n - G.ini)); atualizarBarraSelecao(); }
  $('#btnLimparSel').addEventListener('click', limparSelecao);

  $('#btnVendaManual').addEventListener('click', () => {
    const nums = [...A.sel].sort((a, b) => a - b);
    const total = A.cfg ? brl(nums.length * A.cfg.valor_numero) : '';
    abrirJanela({
      titulo: 'Registrar venda presencial',
      corpo: `<div class="resumo-acao">${plural(nums.length, '1 número', '# números')}${total ? ', total de <strong>' + total + '</strong>' : ''}
          <div class="linha-bilhetes">${nums.map(n => `<span class="mini">${n}</span>`).join('')}</div></div>
        <p class="nota">Use quando a pessoa pagou pessoalmente. O pedido já entra confirmado e os números passam a concorrer.</p>
        <label class="campo"><span>Nome do comprador</span><input id="vmNome" maxlength="80" autocomplete="off"></label>
        <label class="campo"><span>WhatsApp <small>(opcional)</small></span><input id="vmTel" type="tel" inputmode="tel" autocomplete="off"></label>
        <label class="campo"><span>Congregação <small>(opcional)</small></span><input id="vmCong" maxlength="80" autocomplete="off"></label>
        <label class="campo"><span>Como pagou</span><select id="vmForma">
          <option value="DINHEIRO">Dinheiro</option><option value="PIX_MANUAL">Pix recebido na hora</option>
          <option value="CARTAO">Cartão</option><option value="TRANSFERENCIA">Transferência</option><option value="OUTRO">Outro</option></select></label>
        <label class="campo"><span>Observação <small>(opcional)</small></span><input id="vmObs" maxlength="200" autocomplete="off"></label>`,
      botao: 'Registrar venda',
      executar: async corpo => {
        const nome = $('#vmNome', corpo).value.trim();
        if (nome.length < 3) throw erroValidacao('Informe o nome do comprador.');
        const r = await Sessao.chamar('registrarVendaManual', {
          numeros: nums, nome, telefone: $('#vmTel', corpo).value, congregacao: $('#vmCong', corpo).value,
          forma_pagamento: $('#vmForma', corpo).value, observacao: $('#vmObs', corpo).value
        });
        limparSelecao(); depoisDeMudar();
        janelaConcluida(`<p><strong>Venda registrada para ${esc(r.pedido.nome)}.</strong> ${plural(nums.length, 'O número', 'Os números')} ${esc(listaHumana(nums))} ${nums.length === 1 ? 'já concorre' : 'já concorrem'} no sorteio.</p>` +
          (r.pedido.telefone ? `<p><a class="btn whats" target="_blank" rel="noopener" href="${esc(linkWhats(r.pedido, 'confirmado'))}">Enviar os números pelo WhatsApp</a></p>` : ''));
      }
    });
  });

  function janelaBloqueio(bloquear) {
    const nums = [...A.sel].sort((a, b) => a - b);
    abrirJanela({
      titulo: bloquear ? 'Tirar números da venda' : 'Devolver números para a venda',
      corpo: `<div class="resumo-acao">${plural(nums.length, '1 número', '# números')}<div class="linha-bilhetes">${nums.map(n => `<span class="mini">${n}</span>`).join('')}</div></div>` +
        (bloquear ? '<p>Eles deixam de aparecer como livres no site e não entram no sorteio. Útil para números de cortesia ou reservados pela organização.</p><label class="campo"><span>Motivo <small>(opcional, fica no registro)</small></span><input id="blMotivo" maxlength="200"></label>'
          : '<p>Eles voltam a aparecer como livres no site.</p>'),
      botao: bloquear ? 'Tirar da venda' : 'Devolver para a venda',
      executar: async corpo => {
        const r = await Sessao.chamar('alterarBloqueio', { numeros: nums, bloquear, motivo: bloquear ? $('#blMotivo', corpo).value : '' });
        limparSelecao(); carregarGrade(); atualizarResumo();
        dlg.close();
        toast(r.recusados.length
          ? `${plural(r.alterados, '1 número alterado', '# números alterados')}. Não foi possível alterar ${listaHumana(r.recusados)} (mudaram de situação).`
          : `${plural(r.alterados, '1 número', '# números')} ${bloquear ? 'fora da venda' : 'de volta à venda'}.`);
      }
    });
  }
  $('#btnBloquear').addEventListener('click', () => janelaBloqueio(true));
  $('#btnDesbloquear').addEventListener('click', () => janelaBloqueio(false));

  /* ------------------------------------------------------------------
     Sair e início
     ------------------------------------------------------------------ */
  $('#btnSair').addEventListener('click', async () => { await Sessao.sair(); mostrarLogin(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#telaPainel').hidden) cicloAtualizacao(); });

  if (!Api.urlConfigurada()) {
    $('#telaLogin').hidden = false;
    $('#formLogin').innerHTML = '<h1>Painel da rifa</h1><p class="caixa-erro">O endereço da API ainda não foi configurado em assets/js/config.js.</p>';
  } else if (Sessao.atual()) entrarPainel();
  else mostrarLogin();
})();