/* =====================================================================
   sorteio.js — palco do sorteio
   ---------------------------------------------------------------------
   A lógica de animação (fita, contagem, roleta, telão e comemoração) é
   a do código original. O que mudou:
   • os participantes vêm da API: só números PAGOS com pedido CONFIRMADO;
   • cada resultado é registrado no LOG da planilha (com fila, se a
     internet oscilar);
   • a última lista baixada fica salva neste aparelho como plano B.
   ===================================================================== */
(() => {
  'use strict';

  /* ------------------------------------------------------------------
     Utilidades
     ------------------------------------------------------------------ */
  const VIS = 5, CENTRO = 2;   // linhas visíveis na fita e posição central
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, ' ').trim().toUpperCase();
  const reduzMov = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const dataHora = iso => iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';

  /* Sorteio justo: números aleatórios criptográficos, sem viés de módulo */
  function randInt(n) {
    if (n <= 1) return 0;
    const c = window.crypto || window.msCrypto;
    if (!c || !c.getRandomValues) return Math.floor(Math.random() * n);
    const lim = Math.floor(0x100000000 / n) * n, buf = new Uint32Array(1);
    let x; do { c.getRandomValues(buf); x = buf[0]; } while (x >= lim);
    return x % n;
  }

  const LS = {
    ler(k, pad) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : pad; } catch (e) { return pad; } },
    gravar(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* segue */ } }
  };
  const CHAVE_LISTA = 'rifa:sorteio:lista';
  const CHAVE_PROGRESSO = 'rifa:sorteio:progresso';
  const CHAVE_FILA = 'rifa:sorteio:fila-log';

  function toast(msg, ms = 4200) {
    const el = document.createElement('div');
    el.className = 'toast'; el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.classList.add('saindo'); setTimeout(() => el.remove(), 220); }, ms);
  }

  /* ------------------------------------------------------------------
     Estado
     ------------------------------------------------------------------ */
  const CORES = ['#941b1d', '#6a1314', '#b5512c', '#8a6a2b', '#5b6e3f', '#6d3350'];
  const NOMES_COR = ['Vinho', 'Bordô', 'Terracota', 'Ocre', 'Oliva', 'Ameixa'];
  const CFG_PADRAO = { titulo: '', vencedores: 1, suplentes: 0, unico: false, usaPremios: false, premios: '', duracao: 10, cor: CORES[0], estilo: 'fita' };

  let lista = null;          // { titulo, numeros, hash_lista, gerado_em, inconsistencias, origem }
  let entradas = [];         // { numero, nome, cong, chave }
  let cfg = { ...CFG_PADRAO };
  let sorteios = [];         // { entry, evId }
  let janela = [], girando = false, sessaoSalva = null;

  const chaveComprador = e => e.chave;

  function pool() {
    const nums = new Set(sorteios.map(s => s.entry.numero));
    const gan = cfg.unico ? new Set(sorteios.map(s => chaveComprador(s.entry))) : null;
    return entradas.filter(e => !nums.has(e.numero) && !(gan && gan.has(chaveComprador(e))));
  }

  function salvar() {
    const gan = sorteios.length ? sorteios.map(s => ({ numero: s.entry.numero, evId: s.evId }))
      : ((sessaoSalva && sessaoSalva.ganhadores) || []);
    LS.gravar(CHAVE_PROGRESSO, { cfg, ganhadores: gan, hash: lista ? lista.hash_lista : '' });
  }

  /* ------------------------------------------------------------------
     Telas
     ------------------------------------------------------------------ */
  const TELAS = ['telaLogin', 'telaCarregando', 'telaFalha', 'telaRegras', 'telaPalco'];
  function mostrar(id) {
    TELAS.forEach(t => { $('#' + t).hidden = t !== id; });
    window.scrollTo(0, 0);
  }
  function aplicarCor() { document.documentElement.style.setProperty('--marca', cfg.cor); }

  /* ------------------------------------------------------------------
     Lista de participantes
     ------------------------------------------------------------------ */
  function usarLista(l) {
    lista = l;
    entradas = l.numeros.map(x => ({
      numero: x.numero,
      nome: x.nome,
      cong: x.congregacao || '',
      chave: x.comprador || norm(x.nome)
    }));
  }

  async function carregarLista() {
    mostrar('telaCarregando');
    try {
      const r = await Sessao.chamar('listarPagos', {}, { timeout: 30000 });
      const l = { ...r, origem: 'api', baixada_em: new Date().toISOString() };
      LS.gravar(CHAVE_LISTA, l);
      prepararRegras(l);
    } catch (e) {
      if (e.codigo === 'NAO_AUTORIZADO' || e.codigo === 'SESSAO_EXPIRADA') return;   // o login aparece
      const copia = LS.ler(CHAVE_LISTA, null);
      $('#falhaTexto').textContent = e.message + (copia ? ` Há uma cópia salva neste aparelho, baixada em ${dataHora(copia.baixada_em)} (${copia.total} bilhetes).` : '');
      $('#btnUsarCopia').hidden = !copia;
      mostrar('telaFalha');
    }
  }

  function usarCopia() {
    const copia = LS.ler(CHAVE_LISTA, null);
    if (!copia) return;
    prepararRegras({ ...copia, origem: 'copia' });
  }

  function prepararRegras(l) {
    usarLista(l);
    const salvo = LS.ler(CHAVE_PROGRESSO, null);
    cfg = { ...CFG_PADRAO, titulo: l.titulo || 'Sorteio da rifa' };
    sessaoSalva = null;
    if (salvo) {
      cfg = { ...cfg, ...(salvo.cfg || {}) };
      if (salvo.ganhadores && salvo.ganhadores.length) sessaoSalva = salvo;
    }
    sorteios = [];
    aplicarCor();
    montarRegras();
    mostrar('telaRegras');
    processarFila();
  }

  /* ------------------------------------------------------------------
     Tela de regras
     ------------------------------------------------------------------ */
  function montarRegras() {
    $('#titulo').value = cfg.titulo;
    $('#topoTitulo').textContent = cfg.titulo;
    $('#unico').checked = cfg.unico;
    $('#usaPremios').checked = cfg.usaPremios;
    $('#premios').value = cfg.premios;
    $('#boxPremios').hidden = !cfg.usaPremios;
    $$('.stepper').forEach(atualizarStepper);
    $('#cores').innerHTML = CORES.map((c, i) => `<button type="button" class="cor" data-cor="${c}" style="background:${c}" aria-label="Cor ${NOMES_COR[i]}" aria-pressed="${c === cfg.cor}"></button>`).join('');
    $$('#estilos .estilo-btn').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.estilo === cfg.estilo)));

    const ret = $('#retomar');
    if (sessaoSalva) {
      const total = (cfg.vencedores || 0) + (cfg.suplentes || 0);
      $('#retomarTexto').innerHTML = `<strong>Sorteio em andamento neste aparelho:</strong> ${sessaoSalva.ganhadores.length} de ${total} números já sorteados.`;
      ret.hidden = false;
    } else ret.hidden = true;

    montarParticipantes();
    renderConcorrem();
  }

  function montarParticipantes() {
    const compr = new Set(entradas.map(chaveComprador)).size;
    $('#concorrem').textContent = `Concorrem ${entradas.length} bilhetes pagos de ${compr} ${compr === 1 ? 'comprador' : 'compradores'}.`;
    $('#listaInfo').textContent = lista.origem === 'copia'
      ? `Usando a cópia salva neste aparelho em ${dataHora(lista.baixada_em)}. Pagamentos confirmados depois disso não estão na lista.`
      : `Lista conferida às ${new Date(lista.baixada_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}, direto da planilha.`;
    const h = String(lista.hash_lista || '');
    $('#impressao').innerHTML = h ? `Impressão digital da lista: <code>${esc(h.match(/.{1,4}/g).join(' '))}</code>. Leia em voz alta antes de começar: ela fica registrada junto com cada resultado.` : '';
    let avisos = '';
    if (lista.origem === 'copia') avisos += '<div class="aviso forte"><h3>Sem conexão com a planilha</h3><p>Os resultados ficam guardados neste aparelho e são registrados na planilha quando a internet voltar.</p></div>';
    if (lista.inconsistencias && lista.inconsistencias.length) {
      avisos += `<div class="aviso forte"><h3>${lista.inconsistencias.length === 1 ? 'Um número pago ficou de fora' : lista.inconsistencias.length + ' números pagos ficaram de fora'}</h3>
        <p>Na aba NUMEROS eles estão como PAGO, mas o pedido não está confirmado: ${lista.inconsistencias.map(x => esc(x.numero) + ' (' + esc(x.motivo) + ')').join('; ')}. Resolva no painel antes de sortear, se for o caso.</p></div>`;
    }
    if (!entradas.length) avisos += '<div class="aviso forte"><h3>Nenhum número pago</h3><p>Confirme os pagamentos no painel antes de sortear.</p></div>';
    $('#listaAvisos').innerHTML = avisos;
    $('#tabParticipantes').innerHTML = `<thead><tr><th class="n">Número</th><th>Comprador</th><th>Congregação</th></tr></thead><tbody>` +
      entradas.map(e => `<tr><td class="n">${e.numero}</td><td>${esc(e.nome)}</td><td>${esc(e.cong)}</td></tr>`).join('') + '</tbody>';
  }

  function atualizarStepper(el) {
    const campo = el.dataset.campo, min = +el.dataset.min, max = +el.dataset.max;
    el.querySelector('output').textContent = cfg[campo];
    el.querySelector('[data-d="-1"]').disabled = cfg[campo] <= min;
    el.querySelector('[data-d="1"]').disabled = cfg[campo] >= max;
  }

  function renderConcorrem() {
    const total = cfg.vencedores + cfg.suplentes;
    const p = $('#concorremRodape');
    const compr = new Set(entradas.map(chaveComprador)).size;
    const limite = cfg.unico ? compr : entradas.length;
    if (total > limite) {
      p.textContent = cfg.unico
        ? `Com "um prêmio por comprador", só há ${compr} compradores para os ${total} sorteios pedidos.`
        : `Só há ${entradas.length} bilhetes concorrendo, menos que os ${total} sorteios pedidos.`;
      p.classList.add('alerta');
    } else {
      p.textContent = `${total === 1 ? 'Será feito 1 sorteio' : `Serão feitos ${total} sorteios`} entre ${entradas.length} bilhetes.`;
      p.classList.remove('alerta');
    }
  }
  function aoMudarRegra() { renderConcorrem(); salvar(); }

  /* ------------------------------------------------------------------
     Palco
     ------------------------------------------------------------------ */
  function slot(e) {
    return `<div class="slot"><div class="tk so-numero"><div class="tk-so-num">${e.numero}</div></div></div>`;
  }
  function tkPequeno(e) {
    const cong = e.cong ? esc(e.cong) : '<span class="sem">Congregação não informada</span>';
    return `<div class="tk"><div class="tk-num">${e.numero}</div><div class="tk-corpo"><div class="tk-nome">${esc(e.nome)}</div><div class="tk-cong">${cong}</div></div></div>`;
  }
  function premiosLista() { return cfg.premios.split('\n').map(s => s.trim()).filter(Boolean); }
  function rotulo(i) {
    if (i < cfg.vencedores) {
      const premio = cfg.usaPremios ? (premiosLista()[i] || '') : '';
      return { curto: `${i + 1}º vencedor`, titulo: premio || `${i + 1}º vencedor`, tipo: 'Vencedor', premio };
    }
    const j = i - cfg.vencedores + 1;
    return { curto: `Suplente ${j}`, titulo: `Suplente ${j}`, tipo: 'Suplente', premio: '' };
  }

  function fitaEstatica(itens) {
    const fita = $('#fita');
    fita.style.transition = 'none';
    fita.style.transform = 'translateY(0)';
    fita.innerHTML = itens.map(slot).join('');
  }
  function amostra(n) {
    const base = pool().length ? pool() : entradas;
    return Array.from({ length: n }, () => base[randInt(base.length)]);
  }

  function desenharRoleta() {
    const p = pool();
    const svg = $('#roletaSvg');
    const n = Math.max(p.length, 1);
    const cx = 150, cy = 150, r = 140;
    const cores2 = ['#941b1d', '#6a1314', '#b5512c', '#8c4a3f', '#a8302c', '#7a2a3a'];
    let html = '';
    p.forEach((e, i) => {
      const a0 = (i / n) * 2 * Math.PI - Math.PI / 2;
      const a1 = ((i + 1) / n) * 2 * Math.PI - Math.PI / 2;
      const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
      const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
      const large = (a1 - a0) > Math.PI ? 1 : 0;
      const meio = (a0 + a1) / 2;
      const tx = cx + (r * .65) * Math.cos(meio), ty = cy + (r * .65) * Math.sin(meio);
      html += n === 1
        ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${cores2[0]}" opacity=".85"></circle>`
        : `<path d="M${cx},${cy} L${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 ${large} 1 ${x1.toFixed(1)},${y1.toFixed(1)} Z" fill="${cores2[i % cores2.length]}" opacity=".85"></path>`;
      if (n <= 60) html += `<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" font-size="${n > 30 ? 9 : 13}" font-weight="800" font-family="Archivo, Arial, sans-serif" text-anchor="middle" dominant-baseline="middle" fill="#fff">${e.numero}</text>`;
    });
    svg.innerHTML = html;
    svg.style.transition = 'none';
    svg.style.transform = 'rotate(0deg)';
    void svg.offsetWidth;
  }

  function irParaPalco() {
    sessaoSalva = null;
    $('#palcoTitulo').textContent = cfg.titulo || 'Sorteio da rifa';
    document.title = cfg.titulo || 'Sorteio da rifa';
    aplicarCor();
    mostrar('telaPalco');
    $('#reel').classList.toggle('ativo', cfg.estilo === 'fita');
    $('#contagemBox').classList.toggle('ativo', cfg.estilo === 'contagem');
    $('#roletaBox').classList.toggle('ativo', cfg.estilo === 'roleta');

    const ultimo = sorteios.length ? sorteios[sorteios.length - 1].entry : null;
    if (cfg.estilo === 'fita') {
      janela = sorteios.length ? [...amostra(CENTRO), ultimo, ...amostra(VIS - CENTRO - 1)] : amostra(VIS);
      fitaEstatica(janela);
      $('#reel').classList.toggle('parado', sorteios.length === 0);
      $('#reel').classList.toggle('parou', sorteios.length > 0);
    } else if (cfg.estilo === 'contagem') {
      $('#contagemNum').textContent = cfg.duracao;
      $('#contagemProg').style.strokeDashoffset = 0;
      $('#contagemResultado').classList.toggle('ativo', !!ultimo);
      $('#contagemResultado').innerHTML = ultimo ? tkPequeno(ultimo) : '';
    } else {
      desenharRoleta();
      $('#roletaResultado').classList.toggle('ativo', !!ultimo);
      $('#roletaResultado').innerHTML = ultimo ? tkPequeno(ultimo) : '';
    }
    atualizarPalco();
  }

  /* começo e fim comuns às três animações */
  function iniciarRodada() {
    if (girando) return null;
    const p = pool();
    if (!p.length || sorteios.length >= cfg.vencedores + cfg.suplentes) return null;
    girando = true;
    $('#btnSortear').disabled = true;
    const total = cfg.vencedores + cfg.suplentes;
    const r0 = rotulo(sorteios.length);
    cabecalho(sorteios.length, r0.premio ? `${r0.curto}, sorteio ${sorteios.length + 1} de ${total}` : `Sorteio ${sorteios.length + 1} de ${total}`);
    return p;
  }
  function concluirRodada(vencedor) {
    const i = sorteios.length;
    const r = rotulo(i);
    const evId = enfileirarLog('SORTEADO', i, vencedor, r);
    sorteios.push({ entry: vencedor, evId });
    girando = false;
    $('#anuncio').textContent = `Sorteado: número ${vencedor.numero}, ${vencedor.nome}${vencedor.cong ? ', ' + vencedor.cong : ''}.`;
    salvar();
    atualizarPalco();
    festejar(vencedor);
  }

  function sortear() {
    if (cfg.estilo === 'contagem') return sortearContagem();
    if (cfg.estilo === 'roleta') return sortearRoleta();
    return sortearFita();
  }

  async function sortearFita() {
    const p = iniciarRodada(); if (!p) return;
    const reel = $('#reel'); reel.classList.remove('parado', 'parou');
    const vencedor = p[randInt(p.length)];
    const dur = cfg.duracao;
    const n = Math.min(400, Math.max(40, Math.round(dur * 9)));
    const alvo = n - 3;
    const itens = janela.slice();
    while (itens.length < n) {
      const i = itens.length;
      if (i === alvo) { itens.push(vencedor); continue; }
      let e, t = 0;
      do { e = p[randInt(p.length)]; t++; } while (p.length > 1 && (e === vencedor || e === itens[i - 1]) && t < 8);
      itens.push(e);
    }
    const fita = $('#fita');
    fita.style.transition = 'none';
    fita.style.transform = 'translateY(0)';
    fita.innerHTML = itens.map(slot).join('');
    void fita.offsetHeight;
    const linha = fita.firstElementChild.offsetHeight;
    fita.style.transition = `transform ${reduzMov ? .01 : dur}s cubic-bezier(.12,.62,.12,1)`;
    fita.style.transform = `translateY(${-(alvo - CENTRO) * linha}px)`;
    await fimTransicao(fita, reduzMov ? .01 : dur);
    janela = itens.slice(alvo - CENTRO, alvo - CENTRO + VIS);
    fitaEstatica(janela);
    fita.children[CENTRO].firstElementChild.classList.add('venceu');
    reel.classList.add('parou');
    concluirRodada(vencedor);
  }

  async function sortearContagem() {
    const p = iniciarRodada(); if (!p) return;
    const vencedor = p[randInt(p.length)];
    const dur = cfg.duracao;
    $('#contagemResultado').classList.remove('ativo');
    $('#contagemResultado').innerHTML = '';
    const circ = 2 * Math.PI * 52;
    const prog = $('#contagemProg');
    prog.style.strokeDasharray = circ;
    prog.style.transition = 'none';
    prog.style.strokeDashoffset = 0;
    const numEl = $('#contagemNum');
    let restante = dur;
    numEl.textContent = restante;
    void prog.offsetWidth;
    prog.style.transition = `stroke-dashoffset ${dur}s linear`;
    prog.style.strokeDashoffset = circ;
    await new Promise(res => {
      const t = setInterval(() => {
        restante -= 1;
        numEl.textContent = restante > 0 ? p[randInt(p.length)].numero : vencedor.numero;
        if (restante <= 0) { clearInterval(t); res(); }
      }, 1000);
    });
    numEl.textContent = vencedor.numero;
    $('#contagemResultado').innerHTML = tkPequeno(vencedor);
    $('#contagemResultado').classList.add('ativo');
    concluirRodada(vencedor);
  }

  async function sortearRoleta() {
    const p = iniciarRodada(); if (!p) return;
    desenharRoleta();
    $('#roletaResultado').classList.remove('ativo');
    $('#roletaResultado').innerHTML = '';
    const idx = randInt(p.length);
    const vencedor = p[idx];
    const dur = cfg.duracao;
    const svg = $('#roletaSvg');
    const fatia = 360 / p.length;
    const anguloFinal = 6 * 360 + (360 - (idx * fatia + fatia / 2));
    svg.style.transition = `transform ${reduzMov ? .01 : dur}s cubic-bezier(.12,.62,.12,1)`;
    svg.style.transform = `rotate(${anguloFinal}deg)`;
    await new Promise(res => setTimeout(res, (reduzMov ? 0 : dur * 1000) + 100));
    $('#roletaResultado').innerHTML = tkPequeno(vencedor);
    $('#roletaResultado').classList.add('ativo');
    concluirRodada(vencedor);
  }

  function cabecalho(i, sub) {
    const r = rotulo(Math.max(0, Math.min(i, cfg.vencedores + cfg.suplentes - 1)));
    $('#rodadaTitulo').textContent = r.titulo;
    $('#rodadaSub').textContent = sub || '';
  }
  function sorteado(i) {
    const s = sorteios[i]; if (!s) return '';
    const e = s.entry;
    return `Número ${e.numero}, ${e.nome}${e.cong ? ', ' + e.cong : ''}`;
  }

  function atualizarPalco() {
    const feitos = sorteios.length, total = cfg.vencedores + cfg.suplentes, restam = pool().length;
    const btn = $('#btnSortear');
    $('#concorrendo').textContent = restam ? `${restam} bilhetes concorrendo` : '';
    if (feitos === 0) {
      const r = rotulo(0);
      cabecalho(0, r.premio ? `${r.curto}, sorteio 1 de ${total}` : `Sorteio 1 de ${total}`);
      btn.textContent = 'Sortear'; btn.disabled = girando || !restam;
    } else if (feitos >= total || restam === 0) {
      cabecalho(feitos - 1, `${sorteado(feitos - 1)}. ${feitos >= total ? 'Sorteio concluído.' : 'Não há mais bilhetes elegíveis.'}`);
      btn.textContent = feitos >= total ? 'Sorteio concluído' : 'Sortear'; btn.disabled = true;
    } else {
      cabecalho(feitos - 1, sorteado(feitos - 1));
      btn.textContent = `Sortear ${rotulo(feitos).curto}`; btn.disabled = girando;
    }
    renderResultado();
  }

  function renderResultado() {
    const fila = LS.ler(CHAVE_FILA, []);
    const pendentes = new Set(fila.map(x => x.id));
    const ul = $('#resLista');
    ul.innerHTML = sorteios.map((s, i) => {
      const r = rotulo(i);
      const pend = pendentes.has(s.evId);
      return `<li class="res-item"><div class="res-rotulo"><strong>${esc(r.curto)}</strong>${r.premio ? `<span class="res-premio">${esc(r.premio)}</span>` : ''}
        <span class="res-reg${pend ? ' pendente' : ''}">${pend ? 'registrando…' : 'registrado na planilha'}</span></div>${tkPequeno(s.entry)}</li>`;
    }).join('');
    if (ul.lastElementChild) ul.lastElementChild.scrollIntoView({ block: 'nearest' });
    $('#resVazio').hidden = sorteios.length > 0;
    $('#resAcoes').hidden = sorteios.length === 0;
    $('#resRegistro').textContent = fila.length
      ? `${fila.length === 1 ? '1 registro aguarda' : fila.length + ' registros aguardam'} a conexão com a planilha. Eles ficam guardados neste aparelho e são enviados sozinhos.`
      : '';
  }

  const fimTransicao = (el, dur) => new Promise(res => {
    let ok = false;
    const fim = () => { if (ok) return; ok = true; el.removeEventListener('transitionend', h); res(); };
    const h = e => { if (e.target === el && e.propertyName === 'transform') fim(); };
    el.addEventListener('transitionend', h);
    setTimeout(fim, dur * 1000 + 600);
  });

  function anularUltimo() {
    if (girando || !sorteios.length) return;
    const i = sorteios.length - 1;
    const s = sorteios[i];
    if (!confirm(`Anular o último sorteio (número ${s.entry.numero}, ${s.entry.nome})? O número volta a concorrer. A anulação fica registrada na planilha.`)) return;
    sorteios.pop();
    enfileirarLog('ANULADO', i, s.entry, rotulo(i));
    salvar();
    irParaPalco();
  }

  /* ------------------------------------------------------------------
     Registro no LOG da planilha (com fila para quando a internet cair)
     ------------------------------------------------------------------ */
  let processando = false;
  function enfileirarLog(evento, i, entry, r) {
    const id = Date.now().toString(36) + randInt(1e6).toString(36);
    const fila = LS.ler(CHAVE_FILA, []);
    fila.push({ id, evento, numero: entry.numero, ordem: i + 1, rotulo: r.curto, premio: r.premio, hash_lista: lista ? lista.hash_lista : '' });
    LS.gravar(CHAVE_FILA, fila);
    setTimeout(processarFila, 50);
    return id;
  }
  async function processarFila() {
    if (processando) return;
    processando = true;
    try {
      let fila = LS.ler(CHAVE_FILA, []);
      while (fila.length) {
        const ev = fila[0];
        try {
          await Sessao.chamar('registrarSorteio', ev, { timeout: 20000 });
        } catch (e) {
          if (e.codigo === 'REDE' || e.codigo === 'OCUPADO' || e.codigo === 'INTERNO' || e.codigo === 'NAO_AUTORIZADO' || e.codigo === 'SESSAO_EXPIRADA') break;  // tenta depois
          toast(`Não foi possível registrar o número ${ev.numero} na planilha: ${e.message}`, 7000);   // erro definitivo: descarta
        }
        fila = LS.ler(CHAVE_FILA, []).filter(x => x.id !== ev.id);
        LS.gravar(CHAVE_FILA, fila);
        if (!$('#telaPalco').hidden) renderResultado();
      }
    } finally {
      processando = false;
      if (!$('#telaPalco').hidden) renderResultado();
    }
  }
  setInterval(() => { if (LS.ler(CHAVE_FILA, []).length && Sessao.atual()) processarFila(); }, 30000);
  window.addEventListener('online', processarFila);

  /* ------------------------------------------------------------------
     Exportar
     ------------------------------------------------------------------ */
  function textoResultado() {
    const quando = new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
    const linhas = sorteios.map((s, i) => {
      const r = rotulo(i);
      return `${r.curto}${r.premio ? ' (' + r.premio + ')' : ''}: número ${s.entry.numero}, ${s.entry.nome}${s.entry.cong ? ', ' + s.entry.cong : ''}`;
    });
    return `${cfg.titulo}\nResultado em ${quando}\nImpressão digital da lista: ${lista ? lista.hash_lista : ''}\n\n${linhas.join('\n')}`;
  }
  function csvResultado() {
    const l = [['Ordem', 'Tipo', 'Prêmio', 'Número', 'Comprador', 'Congregação']];
    sorteios.forEach((s, i) => { const r = rotulo(i); l.push([i + 1, r.tipo, r.premio, s.entry.numero, s.entry.nome, s.entry.cong]); });
    return '\ufeff' + l.map(x => x.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
  }
  async function copiar() {
    const t = textoResultado(), b = $('#btnCopiar');
    try { await navigator.clipboard.writeText(t); }
    catch (e) {
      const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (_) { /* segue */ } ta.remove();
    }
    b.textContent = 'Copiado'; setTimeout(() => { b.textContent = 'Copiar resultado'; }, 1800);
  }
  function baixarCsv() {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csvResultado()], { type: 'text/csv;charset=utf-8' }));
    a.download = 'resultado-sorteio.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ------------------------------------------------------------------
     Comemoração do ganhador
     ------------------------------------------------------------------ */
  const festa = $('#festa'), cvConfete = $('#confetes');
  let confeteAtivo = null;

  function confetes(ms = 4200) {
    if (reduzMov) return;
    const ctx = cvConfete.getContext && cvConfete.getContext('2d');
    if (!ctx) return;
    cvConfete.width = innerWidth; cvConfete.height = innerHeight;
    const cores = ['#f4e6d8', '#d18a7c', '#941b1d', '#6a1314', '#e8c9a0'];
    const pecas = [];
    const nascer = (x, y, n, forca) => {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        pecas.push({
          x, y, vx: Math.cos(a) * forca * (.4 + Math.random()), vy: Math.sin(a) * forca * (.4 + Math.random()) - 6,
          l: 6 + Math.random() * 8, c: 3 + Math.random() * 5, cor: cores[(Math.random() * cores.length) | 0],
          rot: Math.random() * Math.PI, vr: -.2 + Math.random() * .4, vida: 1
        });
      }
    };
    nascer(cvConfete.width * .5, cvConfete.height * .42, 140, 13);
    setTimeout(() => nascer(0, cvConfete.height * .9, 90, 17), 180);
    setTimeout(() => nascer(cvConfete.width, cvConfete.height * .9, 90, 17), 300);
    cancelAnimationFrame(confeteAtivo);
    const t0 = performance.now();
    (function quadro(t) {
      ctx.clearRect(0, 0, cvConfete.width, cvConfete.height);
      let vivas = 0;
      for (const p of pecas) {
        p.vy += .30; p.vx *= .995; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        if (t - t0 > ms * .6) p.vida -= .012;
        if (p.y < cvConfete.height + 40 && p.vida > 0) {
          vivas++;
          ctx.save(); ctx.globalAlpha = Math.max(0, p.vida); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
          ctx.fillStyle = p.cor; ctx.fillRect(-p.l / 2, -p.c / 2, p.l, p.c); ctx.restore();
        }
      }
      if (vivas && t - t0 < ms) confeteAtivo = requestAnimationFrame(quadro);
      else ctx.clearRect(0, 0, cvConfete.width, cvConfete.height);
    })(t0);
  }

  function festejar(e) {
    const i = sorteios.length - 1;
    const r = rotulo(i);
    const total = cfg.vencedores + cfg.suplentes;
    const faltam = sorteios.length < total && pool().length > 0;
    $('#festaPremio').textContent = r.premio ? `${r.curto} · ${r.premio}` : r.curto;
    $('#festaChamada').textContent = r.tipo === 'Suplente' ? 'Parabéns, suplente!' : 'Parabéns!';
    $('#festaNum').textContent = e.numero;
    $('#festaNome').textContent = e.nome;
    $('#festaCong').innerHTML = e.cong ? `Congregação <strong>${esc(e.cong)}</strong>` : '<em>Congregação não informada</em>';
    $('#festaProximo').hidden = !faltam;
    $('#festaProximo').textContent = faltam ? `Sortear ${rotulo(sorteios.length).curto}` : '';
    $('#festaFechar').textContent = faltam ? 'Voltar ao palco' : 'Ver o resultado';
    festa.hidden = false;
    festa.classList.remove('saindo');
    setTimeout(() => confetes(), 300);
    setTimeout(() => ($('#festaProximo').hidden ? $('#festaFechar') : $('#festaProximo')).focus(), 1200);
  }

  function fecharFesta(depois) {
    festa.classList.add('saindo');
    setTimeout(() => {
      festa.hidden = true;
      festa.classList.remove('saindo');
      cancelAnimationFrame(confeteAtivo);
      const c = cvConfete.getContext && cvConfete.getContext('2d');
      if (c) c.clearRect(0, 0, cvConfete.width, cvConfete.height);
      if (depois) depois();
    }, 340);
  }
  $('#festaFechar').addEventListener('click', () => fecharFesta());
  $('#festaProximo').addEventListener('click', () => fecharFesta(() => sortear()));
  festa.addEventListener('click', ev => { if (ev.target === festa) fecharFesta(); });
  document.addEventListener('keydown', ev => { if (!festa.hidden && ev.key === 'Escape') fecharFesta(); });
  addEventListener('resize', () => { if (!festa.hidden) { cvConfete.width = innerWidth; cvConfete.height = innerHeight; } });

  /* ------------------------------------------------------------------
     Abertura em tela cheia (telão)
     ------------------------------------------------------------------ */
  const telao = $('#telao');
  function montarTelao() {
    const p = String(cfg.titulo || 'Sorteio').trim().split(/\s+/);
    const h = $('#telaoTitulo');
    const [em, span, b] = p.length >= 3 ? [p[0], p.slice(1, -1).join(' '), p[p.length - 1]] : p.length === 2 ? [p[0], p[1], ''] : [p[0], '', ''];
    h.innerHTML = `<em>${esc(em)}</em><span>${esc(span)}</span><b>${esc(b)}</b>`;
    h.classList.toggle('longo', Math.max(em.length, span.length, b.length) > 12);
    $('#telaoSelo').textContent = cfg.usaPremios && premiosLista()[0] ? 'Sorteio ao vivo · ' + premiosLista()[0] : 'Sorteio ao vivo';
  }
  function abrirTelao() {
    montarTelao();
    telao.classList.remove('saindo');
    telao.hidden = false;
    setTimeout(() => $('#btnIniciar').focus(), 900);
  }
  function fecharAbertura() {
    if (telao.hidden || telao.classList.contains('saindo')) return;
    irParaPalco();
    telao.classList.add('saindo');
    const fim = () => { telao.hidden = true; telao.classList.remove('saindo'); telao.removeEventListener('animationend', fim); };
    telao.addEventListener('animationend', fim);
    setTimeout(fim, 1400);
  }
  $('#btnIniciar').addEventListener('click', fecharAbertura);
  document.addEventListener('keydown', e => {
    if (!telao.hidden && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); fecharAbertura(); }
  });

  /* ------------------------------------------------------------------
     Eventos da tela de regras e do palco
     ------------------------------------------------------------------ */
  $('#titulo').addEventListener('input', e => { cfg.titulo = e.target.value; $('#topoTitulo').textContent = cfg.titulo; });
  $('#titulo').addEventListener('change', salvar);
  $$('.stepper').forEach(el => el.addEventListener('click', e => {
    const b = e.target.closest('button[data-d]'); if (!b) return;
    const campo = el.dataset.campo;
    cfg[campo] = Math.min(+el.dataset.max, Math.max(+el.dataset.min, cfg[campo] + (+b.dataset.d)));
    atualizarStepper(el); aoMudarRegra();
  }));
  $('#unico').addEventListener('change', e => { cfg.unico = e.target.checked; aoMudarRegra(); });
  $('#usaPremios').addEventListener('change', e => { cfg.usaPremios = e.target.checked; $('#boxPremios').hidden = !cfg.usaPremios; salvar(); });
  $('#premios').addEventListener('input', e => { cfg.premios = e.target.value; });
  $('#premios').addEventListener('change', salvar);
  $('#cores').addEventListener('click', e => {
    const b = e.target.closest('.cor'); if (!b) return;
    cfg.cor = b.dataset.cor; aplicarCor(); salvar();
    $$('#cores .cor').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  });
  $('#estilos').addEventListener('click', e => {
    const b = e.target.closest('.estilo-btn'); if (!b) return;
    cfg.estilo = b.dataset.estilo;
    $$('#estilos .estilo-btn').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    salvar();
  });

  $('#btnAtualizarLista').addEventListener('click', () => {
    if (sorteios.length) { toast('A lista não pode mudar com um sorteio em andamento.'); return; }
    carregarLista();
  });
  $('#btnRetomar').addEventListener('click', () => {
    const ignorados = [];
    sorteios = sessaoSalva.ganhadores.map(g => {
      const n = typeof g === 'object' ? g.numero : g;
      const entry = entradas.find(e => e.numero === n);
      if (!entry) ignorados.push(n);
      return entry ? { entry, evId: g.evId || '' } : null;
    }).filter(Boolean);
    if (ignorados.length) toast(`${ignorados.join(', ')} não ${ignorados.length === 1 ? 'está' : 'estão'} mais na lista de pagos e ${ignorados.length === 1 ? 'saiu' : 'saíram'} do resultado.`, 7000);
    irParaPalco();
  });
  $('#btnZerar').addEventListener('click', () => {
    if (!confirm('Começar do zero apaga o resultado salvo neste aparelho (os registros na planilha continuam). Continuar?')) return;
    sessaoSalva = null; $('#retomar').hidden = true; sorteios = []; salvar();
  });
  $('#btnIrSorteio').addEventListener('click', () => {
    cfg.titulo = $('#titulo').value.trim() || 'Sorteio da rifa';
    cfg.premios = $('#premios').value;
    if (!entradas.length) { alert('Não há números pagos para sortear.'); return; }
    if (sessaoSalva && !confirm('Já existe um sorteio em andamento neste aparelho. Começar um novo apaga o resultado anterior daqui (os registros na planilha continuam). Continuar?')) return;
    sorteios = []; sessaoSalva = null; salvar();
    abrirTelao();
  });
  $('#btnVoltar').addEventListener('click', () => {
    if (girando) return;
    if (document.fullscreenElement) document.exitFullscreen();
    montarRegras(); mostrar('telaRegras');
    if (sorteios.length) {
      sessaoSalva = { ganhadores: sorteios.map(s => ({ numero: s.entry.numero, evId: s.evId })) };
      $('#retomarTexto').innerHTML = `<strong>Sorteio em andamento:</strong> ${sorteios.length} de ${cfg.vencedores + cfg.suplentes} números já sorteados.`;
      $('#retomar').hidden = false;
    }
  });
  $('#btnSortear').addEventListener('click', sortear);
  $('#btnAnular').addEventListener('click', anularUltimo);
  $('#btnCopiar').addEventListener('click', copiar);
  $('#btnCsv').addEventListener('click', baixarCsv);
  $('#btnTelaCheia').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
  });
  $('#btnTentar').addEventListener('click', carregarLista);
  $('#btnUsarCopia').addEventListener('click', usarCopia);
  $('#btnUsarCopiaLogin').addEventListener('click', usarCopia);

  /* ------------------------------------------------------------------
     Início
     ------------------------------------------------------------------ */
  function mostrarLogin(msg) {
    if (!$('#telaPalco').hidden && girando) return;       // nunca interrompe uma animação
    mostrar('telaLogin');
    const e = $('#lgErro');
    if (msg) { e.textContent = msg; e.hidden = false; } else e.hidden = true;
    const copia = LS.ler(CHAVE_LISTA, null);
    $('#loginCopia').hidden = !copia;
    if (copia) $('#loginCopiaTexto').textContent = `Sem internet no local? Há uma lista salva neste aparelho em ${dataHora(copia.baixada_em)}, com ${copia.total} bilhetes pagos.`;
  }
  Sessao.aoExpirar(msg => {
    // durante o palco, a sessão expirada só atrasa o registro; o sorteio continua
    if (!$('#telaPalco').hidden || !$('#telaRegras').hidden) { toast('Sessão expirada: os registros ficam guardados até você entrar de novo.', 6000); return; }
    mostrarLogin(msg);
  });
  Sessao.ligarFormulario($('#formLogin'), () => carregarLista());

  if (!Api.urlConfigurada()) {
    mostrar('telaFalha');
    $('#falhaTexto').textContent = 'O endereço da API ainda não foi configurado em assets/js/config.js.';
    $('#btnTentar').hidden = true;
  } else if (Sessao.atual()) carregarLista();
  else mostrarLogin();
})();