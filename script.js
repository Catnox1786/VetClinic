// =============================================================================
// VETCLINIC — script.js (Supabase)
// Backend: Supabase Auth + PostgreSQL + Row Level Security (RLS).
// O navegador usa somente a chave publicável; permissões reais vivem no banco.
// =============================================================================

const SUPABASE_URL = 'https://cbsoxblizzeujfogpgsg.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_6lN5xVzTcZwWfhAdNmk_pA_I9GkZzDS';
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

const K = {
  DOCS:'vc_docs_v3', PATU:'vc_patu_v3', PATS:'vc_pats_v4', PROCS:'vc_procs_v2',
  APTS:'vc_appointments_v1', HIST:'vc_history_v1', VACC:'vc_vaccines_v1', REVS:'vc_reviews_v1',
  DSES:'vc_dses_v3', PSES:'vc_pses_v3', DEXP:'vc_dexp', PEXP:'vc_pexp', RATD:'vc_ratd', RATP:'vc_ratp', THEME:'vc_theme'
};
const DB_KEY_RESOURCE = {
  [K.PATS]:'patients', [K.PROCS]:'procedures', [K.APTS]:'appointments',
  [K.HIST]:'history', [K.VACC]:'vaccines', [K.REVS]:'reviews'
};
const MUTABLE_RESOURCE_KEYS = new Set([K.PATS,K.PROCS,K.APTS,K.HIST,K.VACC]);
const RESOURCE_ID_FIELD = { patients:'na', procedures:'id', appointments:'id', history:'id', vaccines:'id' };
const RESOURCE_TABLE = { patients:'pacientes', procedures:'procedimentos', appointments:'agendamentos', history:'historico', vaccines:'vacinas' };
const dbCache = {};
const dbSyncQueues = {};
let dbReady = false;
let dbOnline = false;
let currentSession = null;

function cloneData(value){ return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
const ls=(k,d)=> DB_KEY_RESOURCE[k] ? cloneData(Object.prototype.hasOwnProperty.call(dbCache,k)?dbCache[k]:d) : (()=>{try{return JSON.parse(localStorage.getItem(k)||JSON.stringify(d));}catch{return d;}})();
function applyServerData(data){ const safe=data&&typeof data==='object'?data:{}; Object.entries(DB_KEY_RESOURCE).forEach(([key,res])=>dbCache[key]=cloneData(Array.isArray(safe[res])?safe[res]:[])); }

function supaError(error, fallback='Falha ao acessar o Supabase.') {
  const err = new Error(error?.message || fallback); err.original=error; return err;
}
function toISODateMaybe(v){ if(!v)return null; if(/^\d{4}-\d{2}-\d{2}$/.test(v))return v; const m=String(v).match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m?`${m[3]}-${m[2]}-${m[1]}`:null; }
function payloadBase(row){ return row && row.payload && typeof row.payload==='object' ? cloneData(row.payload) : {}; }
function mapPatient(row){ return {...payloadBase(row), na:Number(row.na), nome:row.nome||'', especie:row.especie||'', raca:row.raca||'', idade:row.idade||'', dono:row.dono||'', donoTel:row.dono_tel||'', sintomas:row.sintomas||'', foto:row.foto||'', dataConsulta:payloadBase(row).dataConsulta || (row.data_consulta?fmtDate(row.data_consulta):'')}; }
function mapProcedure(row){ return {...payloadBase(row), id:Number(row.id), na:row.na==null?null:Number(row.na), proc:row.procedimento||payloadBase(row).proc||'', status:row.status||'', date:row.data||'', time:row.horario?String(row.horario).slice(0,5):''}; }
function mapAppointment(row){ return {...payloadBase(row), id:Number(row.id), na:row.na==null?null:Number(row.na), tutor:row.tutor||'', phone:row.telefone||'', pet:row.pet||'', service:row.servico||'', status:row.status||'', date:row.data_preferida||'', time:row.horario?String(row.horario).slice(0,5):'', message:row.mensagem||''}; }
function mapHistory(row){ return {...payloadBase(row), id:Number(row.id), na:Number(row.na), type:row.tipo_evento||'', date:row.data_evento||'', desc:row.descricao||''}; }
function mapVaccine(row){ return {...payloadBase(row), id:Number(row.id), na:Number(row.na), name:row.nome_vacina||'', date:row.data_aplicacao||'', next:row.proxima_data||'', status:row.status||''}; }
function mapReview(row){ return {user_id:row.user_id||null,name:row.nome||'',rating:Number(row.rating??row.nota??0),text:row.texto||'',updatedAt:new Date(row.updated_at||row.atualizado_em||0).getTime()}; }

async function getOwnProfile(){
  const {data:{session},error:sErr}=await sb.auth.getSession(); if(sErr)throw supaError(sErr);
  if(!session)return null;
  const {data,error}=await sb.from('perfis').select('id,email,nome,tipo,foto').eq('id',session.user.id).single();
  if(error)throw supaError(error,'Não foi possível carregar o perfil.');
  return { session, profile:data };
}
function makeCurrentSession(authSession, profile){ return { role:profile.tipo==='medico'?'doc':'pat', user:{id:profile.id,email:profile.email,name:profile.nome,photo:profile.foto||''}, access_token:authSession?.access_token||'' }; }

async function loadBootstrapData(){
  const reviewsRpc=await sb.rpc('avaliacoes_publicas'); if(reviewsRpc.error)throw supaError(reviewsRpc.error);
  const reviews=(reviewsRpc.data||[]).map(mapReview);
  const own=await getOwnProfile();
  if(!own)return {session:null,data:{reviews}};
  currentSession=makeCurrentSession(own.session,own.profile);
  const queries=await Promise.all([
    sb.from('pacientes').select('*').order('na'), sb.from('procedimentos').select('*').order('data'),
    sb.from('agendamentos').select('*').order('criado_em',{ascending:false}), sb.from('historico').select('*').order('data_evento',{ascending:false}),
    sb.from('vacinas').select('*').order('proxima_data',{ascending:false})
  ]);
  const bad=queries.find(q=>q.error); if(bad)throw supaError(bad.error);
  return {session:currentSession,data:{patients:(queries[0].data||[]).map(mapPatient),procedures:(queries[1].data||[]).map(mapProcedure),appointments:(queries[2].data||[]).map(mapAppointment),history:(queries[3].data||[]).map(mapHistory),vaccines:(queries[4].data||[]).map(mapVaccine),reviews}};
}

function rowForResource(resource,item){
  if(resource==='patients') return {na:item.na,nome:item.nome||'',especie:item.especie||'',raca:item.raca||'',idade:item.idade||'',dono:item.dono||'',dono_tel:item.donoTel||'',sintomas:item.sintomas||'',foto:item.foto||null,data_consulta:toISODateMaybe(item.dataConsulta),payload:item};
  if(resource==='procedures') return {id:item.id,na:item.na??null,procedimento:item.proc||'',status:item.status||'agendado',data:item.date||null,horario:item.time||null,payload:item};
  if(resource==='appointments') return {id:item.id,na:item.na??null,tutor:item.tutor||'',telefone:item.phone||'',pet:item.pet||'',servico:item.service||'',status:item.status||'recebido',data_preferida:item.date||null,horario:item.time||null,mensagem:item.message||'',payload:item};
  if(resource==='history') return {id:item.id,na:item.na,tipo_evento:item.type||'Registro',data_evento:item.date||null,descricao:item.desc||'',payload:item};
  if(resource==='vaccines') return {id:item.id,na:item.na,nome_vacina:item.name||'',data_aplicacao:item.date||null,proxima_data:item.next||null,status:item.status||'',payload:item};
  throw new Error('Recurso inválido.');
}

async function apiRequest(action, options={}){
  const body=options.body||{};
  if(action==='bootstrap') return {ok:true,...await loadBootstrapData()};
  if(action==='logout'){ const {error}=await sb.auth.signOut(); if(error)throw supaError(error); return {ok:true}; }
  if(action==='login'){
    if(body.role==='doc'){
      const {data:valid,error:vErr}=await sb.rpc('validar_chave_clinica',{p_codigo:body.clinic_key||''});
      if(vErr||valid!==true)throw new Error('Chave da clínica incorreta.');
    }
    const {data,error}=await sb.auth.signInWithPassword({email:body.email,password:body.password}); if(error)throw supaError(error,'E-mail ou senha inválidos.');
    const own=await getOwnProfile(); if(!own){await sb.auth.signOut();throw new Error('Perfil não encontrado.');}
    const expected=body.role==='doc'?'medico':'tutor'; if(own.profile.tipo!==expected){await sb.auth.signOut();throw new Error('Esta conta não pertence a esta área.');}
    const result=await loadBootstrapData(); return {ok:true,session:result.session,data:result.data};
  }
  if(action==='register'){
    let doctorToken='';
    if(body.role==='doc'){
      const {data,error}=await sb.rpc('iniciar_cadastro_medico',{p_codigo:body.clinic_key||''}); if(error)throw supaError(error,'Chave da clínica incorreta.'); doctorToken=data;
    }
    const meta={nome:body.name,role:body.role==='doc'?'medico':'tutor'}; if(doctorToken)meta.doctor_token=doctorToken;
    const {data,error}=await sb.auth.signUp({email:body.email,password:body.password,options:{data:meta}}); if(error)throw supaError(error,'Não foi possível criar a conta.');
    if(!data.session) return {ok:true,session:null,needs_confirmation:true};
    const own=await getOwnProfile(); const result=await loadBootstrapData(); return {ok:true,session:result.session,data:result.data};
  }
  if(action==='mutate'){
    if(!currentSession||currentSession.role!=='doc')throw new Error('Operação restrita ao médico.');
    const resource=body.resource, table=RESOURCE_TABLE[resource]; if(!table)throw new Error('Recurso inválido.');
    const upsert=(body.upsert||[]).map(i=>rowForResource(resource,i));
    if(upsert.length){ const {error}=await sb.from(table).upsert(upsert,{onConflict:RESOURCE_ID_FIELD[resource]}); if(error)throw supaError(error); }
    const del=body.delete||[]; if(del.length){ const {error}=await sb.from(table).delete().in(RESOURCE_ID_FIELD[resource],del); if(error)throw supaError(error); }
    return {ok:true};
  }
  if(action==='review_save'){
    const own=await getOwnProfile(); if(!own||own.profile.tipo!=='tutor')throw new Error('Entre como tutor para avaliar.');
    const row={user_id:own.profile.id,nome:own.profile.nome,nota:Number(body.rating),texto:String(body.text||'').trim(),atualizado_em:new Date().toISOString()};
    const {error}=await sb.from('avaliacoes').upsert(row,{onConflict:'user_id'}); if(error)throw supaError(error);
    const r=await sb.rpc('avaliacoes_publicas'); if(r.error)throw supaError(r.error); return {ok:true,reviews:(r.data||[]).map(mapReview)};
  }
  if(action==='profile_update'){
    const own=await getOwnProfile(); if(!own)throw new Error('Sua sessão expirou.');
    if(body.new_password){
      const chk=await sb.auth.signInWithPassword({email:own.profile.email,password:body.old_password||''}); if(chk.error)throw new Error('Senha atual incorreta.');
      const up=await sb.auth.updateUser({password:body.new_password}); if(up.error)throw supaError(up.error,'Não foi possível alterar a senha.');
    }
    const patch={nome:String(body.name||'').trim()}; if(Object.prototype.hasOwnProperty.call(body,'photo'))patch.foto=body.photo||null;
    const {data,error}=await sb.from('perfis').update(patch).eq('id',own.profile.id).select('id,email,nome,tipo,foto').single(); if(error)throw supaError(error);
    return {ok:true,user:{id:data.id,email:data.email,name:data.nome,photo:data.foto||''}};
  }
  if(action==='patient_claim'){
    const {data,error}=await sb.rpc('reivindicar_paciente',{p_na:Number(body.na),p_telefone:String(body.phone||'')}); if(error)throw supaError(error); const result=await loadBootstrapData(); return {ok:true,claimed:data,data:result.data,session:result.session};
  }
  if(action==='patient_phone_update'){
    const {data,error}=await sb.rpc('atualizar_telefone_paciente',{p_na:Number(body.na),p_telefone:String(body.phone||'')}); if(error)throw supaError(error); return {ok:true,updated:data};
  }
  if(action==='availability'){
    const {data,error}=await sb.rpc('disponibilidade_vetclinic'); if(error)throw supaError(error); return {ok:true,occupied:(data||[]).map(x=>({date:x.data,time:x.horario}))};
  }
  if(action==='appointment_create'){
    const {data,error}=await sb.rpc('criar_agendamento_vetclinic',{p_tutor:body.tutor,p_telefone:body.phone,p_pet:body.pet,p_na:body.na||null,p_servico:body.service,p_data:body.date,p_horario:body.time||null,p_mensagem:body.message||''}); if(error)throw supaError(error); return {ok:true,appointment:data};
  }
  throw new Error('Ação não suportada no Supabase.');
}

function diffResource(resource,before,after){ const k=RESOURCE_ID_FIELD[resource], oldMap=new Map((before||[]).map(i=>[String(i?.[k]),i])), newMap=new Map((after||[]).map(i=>[String(i?.[k]),i])),upsert=[],remove=[]; for(const [key,item] of newMap){const old=oldMap.get(key);if(!old||JSON.stringify(old)!==JSON.stringify(item))upsert.push(item);} for(const key of oldMap.keys())if(!newMap.has(key))remove.push(key); return {upsert,delete:remove}; }
async function mutateDatabaseKey(k,before,after){ const resource=DB_KEY_RESOURCE[k]; if(!resource||!MUTABLE_RESOURCE_KEYS.has(k))return; if(!currentSession||currentSession.role!=='doc')throw new Error('Operação restrita ao médico.'); const delta=diffResource(resource,before,after); if(!delta.upsert.length&&!delta.delete.length)return; await apiRequest('mutate',{method:'POST',body:{resource,upsert:delta.upsert,delete:delta.delete}}); }
function queueDatabaseSync(k,before,after){ const b=cloneData(before),a=cloneData(after); dbSyncQueues[k]=(dbSyncQueues[k]||Promise.resolve()).catch(()=>{}).then(()=>mutateDatabaseKey(k,b,a)).catch(async err=>{console.error('[VetClinic/Supabase]',err);showToast(err.message||'Não foi possível salvar no banco.');try{await refreshSecureBootstrap();}catch(_){}}); return dbSyncQueues[k]; }
const ss=(k,v)=>{ if(DB_KEY_RESOURCE[k]){const before=cloneData(dbCache[k]||[]);dbCache[k]=cloneData(v);if(MUTABLE_RESOURCE_KEYS.has(k))queueDatabaseSync(k,before,v);return;}localStorage.setItem(k,JSON.stringify(v)); };
const getPs=()=>ls(K.PATS,[]); const savePs=v=>ss(K.PATS,v); const getPrs=()=>ls(K.PROCS,[]); const savePrs=v=>ss(K.PROCS,v); const getApts=()=>ls(K.APTS,[]); const saveApts=v=>ss(K.APTS,v); const getHist=()=>ls(K.HIST,[]); const saveHist=v=>ss(K.HIST,v); const getVacc=()=>ls(K.VACC,[]); const saveVacc=v=>ss(K.VACC,v); const getReviews=()=>ls(K.REVS,[]);
function clearLegacySensitiveStorage(){ [K.DOCS,K.PATU,K.DSES,K.PSES,K.DEXP,K.PEXP,K.RATD,K.RATP,K.PATS,K.PROCS,K.APTS,K.HIST,K.VACC,K.REVS].forEach(k=>localStorage.removeItem(k)); }
async function refreshSecureBootstrap(){ const result=await apiRequest('bootstrap');currentSession=result.session||null;applyServerData(result.data||{});dbOnline=true;dbReady=true;clearLegacySensitiveStorage();return result; }
async function initDatabase(){ try{await refreshSecureBootstrap();return true;}catch(err){console.error('[VetClinic/Supabase] Falha de conexão:',err);dbOnline=false;dbReady=true;Object.keys(DB_KEY_RESOURCE).forEach(k=>{if(!dbCache[k])dbCache[k]=[];});return false;} }

// =============================================================================
// SEÇÃO 6 — SEGURANÇA: SANITIZAÇÃO DE TEXTO
// Remove tags HTML perigosas de qualquer texto digitado pelo usuário.
// Isso previne ataques XSS (injeção de código malicioso via campos de texto).
// =============================================================================

// Converte caracteres especiais HTML em entidades seguras
function sanitizar(texto) {
  const div = document.createElement('div');
  div.textContent = texto;
  return div.innerHTML;
}


// Aceita somente imagens locais geradas pelo sistema. Evita src arbitrário vindo de dados antigos.
function safeImageSrc(src) {
  if (typeof src !== 'string' || src.length > 900000) return '';
  return /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(src) ? src : '';
}

function normalizeProfileUser(user = {}) {
  const email = String(user.email || '').trim();
  const fallback = email.includes('@') ? email.split('@')[0] : 'Usuário';
  const name = String(user.name || '').trim() || fallback;
  return { ...user, name, email };
}

function profileInitials(user) {
  const name = normalizeProfileUser(user).name;
  return name.split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase();
}

// Valida se um e-mail tem formato válido
function validarEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Valida se um telefone tem uma quantidade razoável de dígitos (aceita
// qualquer formatação: (16) 99999-8888, 16999998888, +55 16 99999-8888etc.)
function validarTelefone(tel) {
  const digitos = tel.replace(/\D/g, '');
  return digitos.length >= 8 && digitos.length <= 13;
}


// =============================================================================
// SEÇÃO 7 — VALIDAÇÃO DE SENHA
// Regras: mínimo 8 caracteres, 1 maiúscula, 1 caractere especial (@_-.)
// Retorna uma mensagem de erro ou null se a senha for válida.
// =============================================================================
function validatePwd(p) {
  if (p.length < 12)          return 'Senha deve ter pelo menos 12 caracteres.';
  if (!/[A-Z]/.test(p))       return 'Deve conter pelo menos uma letra maiúscula.';
  if (!/[a-z]/.test(p))       return 'Deve conter pelo menos uma letra minúscula.';
  if (!/[0-9]/.test(p))       return 'Deve conter pelo menos um número.';
  if (!/[^A-Za-z0-9]/.test(p)) return 'Deve conter pelo menos um caractere especial.';
  return null;
}


// =============================================================================
// SEÇÃO 8 — FUNÇÕES DE INTERFACE (mensagens, toast, scroll)
// Funções auxiliares para exibir mensagens de erro/sucesso e notificações.
// =============================================================================

// Exibe uma mensagem de erro ou sucesso dentro de um elemento HTML
function showMsg(id, txt, type) {
  document.getElementById(id).innerHTML =
    `<div class="auth-msg-box ${type}">${sanitizar(txt)}</div>`;
}

// Exibe mensagem dentro do modal de edição de perfil
function showMMsg(txt, type) {
  document.getElementById('edit-msg').innerHTML =
    `<div class="modal-msg ${type}">${sanitizar(txt)}</div>`;
}

// Exibe uma notificação temporária no canto inferior direito (toast)
function showToast(msg) {
  const t = document.getElementById('toast');
  document.getElementById('toast-text').textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

// Faz a página rolar suavemente até uma seção pelo seletor CSS (ex: '#servicos')
function scrollTo(sel) {
  document.querySelector(sel)?.scrollIntoView({ behavior: 'smooth' });
  return false;
}


// =============================================================================
// SEÇÃO 9 — TEMA CLARO / ESCURO
// Alterna entre o tema claro (sol) e escuro (lua).
// A preferência é salva no localStorage e aplicada automaticamente ao carregar.
// =============================================================================

// SVG do ícone de sol (tema claro)
const SUN = '<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>';

// SVG do ícone de lua (tema escuro)
const MOON = '<path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>';

// Estado atual do tema (true = escuro, false = claro)
let dark = localStorage.getItem(K.THEME) === 'dark';

// Aplica o tema atual ao HTML e atualiza todos os ícones de tema na página
function applyTheme() {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  localStorage.setItem(K.THEME, dark ? 'dark' : 'light');
  const ico = dark ? MOON : SUN;
  ['nav-theme-icon', 'app-theme-icon', 'pat-theme-icon'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = ico;
  });
}

// Alterna entre claro e escuro ao clicar no botão de tema
function toggleTheme() {
  dark = !dark;
  applyTheme();
}


// =============================================================================
// SEÇÃO 10 — GERENCIAMENTO DE TELAS
// Controla qual tela principal está visível (site público, app médico, portal tutor).
// =============================================================================

// Esconde todas as telas e exibe apenas a indicada pelo id
function showScreen(id) {
  ['website-screen', 'app-screen', 'patient-screen'].forEach(s =>
    document.getElementById(s).classList.remove('active')
  );
  document.getElementById(id).classList.add('active');
  // Rola para o topo ao trocar de tela
  window.scrollTo(0, 0);
}


// =============================================================================
// SEÇÃO 11 — MENU DE NAVEGAÇÃO MOBILE (site público)
// Controla a abertura e fechamento do menu hambúrguer na versão mobile.
// =============================================================================

// Estado de abertura do menu mobile
let mobileNavOpen = false;

// Abre ou fecha o menu mobile ao clicar no botão hambúrguer
function toggleMobileNav() {
  mobileNavOpen = !mobileNavOpen;
  document.getElementById('mobile-nav').classList.toggle('open', mobileNavOpen);
}


// =============================================================================
// SEÇÃO 12 — MODAL DO SISTEMA (janela de login que sobe do rodapé)
// Controla a abertura e fechamento do modal de acesso ao sistema,
// e qual painel está visível dentro dele (seleção de papel, login médico, login tutor).
// =============================================================================

// Abre o modal do sistema e exibe a tela de seleção de papel (médico ou tutor)
function openSystemModal() {
  if (!dbReady) return showToast('Conectando ao servidor...');
  if (!dbOnline) return showToast('Supabase indisponível. Confira sua conexão com a internet.');
  document.getElementById('system-modal-bg').classList.add('open');
  showRolePanel();
}

// Fecha o modal do sistema
function closeSystemModal() {
  document.getElementById('system-modal-bg').classList.remove('open');
}

// Exibe o painel de seleção de papel (médico ou tutor)
function showRolePanel() {
  document.getElementById('sm-role').style.display     = '';
  document.getElementById('sm-doc-auth').style.display = 'none';
  document.getElementById('sm-pat-auth').style.display = 'none';
}

// Exibe o formulário de login/cadastro conforme o papel escolhido ('doc' ou 'pat')
function showAuthPanel(role) {
  document.getElementById('sm-role').style.display     = 'none';
  document.getElementById('sm-doc-auth').style.display = role === 'doc' ? '' : 'none';
  document.getElementById('sm-pat-auth').style.display = role === 'pat' ? '' : 'none';
}


// =============================================================================
// SEÇÃO 13 — AUTENTICAÇÃO DO MÉDICO VETERINÁRIO
// Login, registro e logout do médico. Inclui verificação da senha da clínica,
// hash de senha, rate limiting e criação de sessão com token.
// =============================================================================

// Alterna entre as abas "Entrar" e "Criar conta" no formulário do médico
function switchDocTab(tab) {
  document.querySelectorAll('#sm-doc-auth .auth-tab-modal').forEach((el, i) =>
    el.classList.toggle('active', tab === (i === 0 ? 'login' : 'register'))
  );
  document.getElementById('doc-login-panel').style.display    = tab === 'login'    ? '' : 'none';
  document.getElementById('doc-register-panel').style.display = tab === 'register' ? '' : 'none';
  ['doc-login-msg', 'doc-reg-msg'].forEach(id => document.getElementById(id).innerHTML = '');
}

// A chave da clínica e as senhas são verificadas exclusivamente no servidor.
async function doDocLogin() {
  const email = document.getElementById('doc-login-email').value.trim().toLowerCase();
  const password = document.getElementById('doc-login-pwd').value;
  const clinicKey = document.getElementById('doc-login-key').value;
  if (!email || !password || !clinicKey) return showMsg('doc-login-msg','Preencha todos os campos.','err');
  if (!validarEmail(email)) return showMsg('doc-login-msg','E-mail inválido.','err');
  try {
    const result = await apiRequest('login', { method:'POST', body:{ role:'doc', email, password, clinic_key:clinicKey } });
    currentSession = result.session;
    applyServerData(result.data || {});
    closeSystemModal();
    enterDocApp(currentSession.user);
  } catch (err) { showMsg('doc-login-msg', err.message, 'err'); }
}

async function doDocRegister() {
  const name = document.getElementById('doc-reg-name').value.trim();
  const email = document.getElementById('doc-reg-email').value.trim().toLowerCase();
  const password = document.getElementById('doc-reg-pwd').value;
  const clinicKey = document.getElementById('doc-reg-key').value;
  if (!name || !email || !password || !clinicKey) return showMsg('doc-reg-msg','Preencha todos os campos.','err');
  if (!validarEmail(email)) return showMsg('doc-reg-msg','E-mail inválido.','err');
  const pwdErr = validatePwd(password); if (pwdErr) return showMsg('doc-reg-msg',pwdErr,'err');
  try {
    const result = await apiRequest('register', { method:'POST', body:{ role:'doc', name, email, password, clinic_key:clinicKey } });
    if (!result.session) { showMsg('doc-reg-msg','Conta criada. Confirme o e-mail enviado pelo Supabase e depois entre.','ok'); return; }
    currentSession = result.session;
    applyServerData(result.data || {});
    showMsg('doc-reg-msg','Conta criada com segurança. Entrando...','ok');
    setTimeout(() => { closeSystemModal(); enterDocApp(currentSession.user); }, 450);
  } catch (err) { showMsg('doc-reg-msg', err.message, 'err'); }
}

// Define o avatar (foto ou iniciais) em um elemento HTML
function setAv(el, user) {
  if (!el) return;
  const normalized = normalizeProfileUser(user);
  const safePhoto = safeImageSrc(normalized.photo);
  if (safePhoto) { el.innerHTML = `<img src="${safePhoto}" alt="Foto de perfil"/>`; }
  else el.textContent = profileInitials(normalized);
}

// Atualiza os elementos de perfil sem reconstruir a tela atual.
// Isso preserva o pet consultado pelo tutor e a seção aberta pelo médico.
function updateProfileUI(user) {
  const normalized = normalizeProfileUser(user);
  if (normalized.role === 'doc' || currentSession?.role === 'doc') {
    setAv(document.getElementById('tb-av'), normalized);
    document.getElementById('tb-un').textContent = `Dr(a). ${normalized.name}`;
    setAv(document.getElementById('doc-pp-av'), normalized);
    document.getElementById('doc-pp-name').textContent = `Dr(a). ${normalized.name}`;
    document.getElementById('doc-pp-email').textContent = normalized.email;
  }
  if (normalized.role === 'pat' || currentSession?.role === 'pat') {
    setAv(document.getElementById('pat-tb-av'), normalized);
    document.getElementById('pat-tb-un').textContent = normalized.name;
    setAv(document.getElementById('pat-pp-av'), normalized);
    document.getElementById('pat-pp-name').textContent = normalized.name;
    document.getElementById('pat-pp-email').textContent = normalized.email;
  }
}

// Entra no painel do médico após login bem-sucedido
function enterDocApp(user) {
  user = normalizeProfileUser(user);
  showScreen('app-screen');
  updateProfileUI(user);
  updateSbCount();
  buildCalendar();
  buildTimeOpts();
  renderAppointments();
  populateClinicalPatientSelect();
  startReminderWatch();
}

// Encerra a sessão do médico e volta para o site público
async function doDocLogout() {
  try { await apiRequest('logout', { method:'POST', body:{} }); } catch (err) { console.warn(err); }
  currentSession = null;
  applyServerData({ reviews: getReviews() });
  closePanel('doc');
  stopReminderWatch();
  showScreen('website-screen');
  try { await refreshSecureBootstrap(); renderTestimonials(); } catch (_) {}
}


// =============================================================================
// AVALIAÇÕES DOS TUTORES
// Cada conta de tutor pode manter uma avaliação. Ao publicar novamente, a
// avaliação anterior é atualizada em vez de criar um depoimento duplicado.
// =============================================================================
let reviewRating = null;

function renderTestimonials() {
  const grid = document.getElementById('testimonials-grid');
  const empty = document.getElementById('testimonials-empty');
  if (!grid || !empty) return;

  const reviews = getReviews().slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  grid.innerHTML = '';
  empty.style.display = reviews.length ? 'none' : '';

  reviews.forEach(r => {
    const nota = Math.max(0, Math.min(5, Number(r.rating) || 0));
    const cheias = '★'.repeat(nota);
    const vazias = '☆'.repeat(5 - nota);
    const card = document.createElement('article');
    card.className = 'testimonial-card';
    card.innerHTML = `
      <div class="stars" aria-label="${nota} de 5 estrelas">${cheias}${vazias} <small>${nota}/5</small></div>
      <p>“${sanitizar(r.text)}”</p>
      <strong>${sanitizar(r.name || 'Tutor VetClinic')}</strong>
      <span>Tutor(a) VetClinic</span>`;
    grid.appendChild(card);
  });
}

function setReviewRating(value) {
  reviewRating = Math.max(0, Math.min(5, Number(value)));
  const score = document.getElementById('pat-review-score');
  if (score) score.textContent = `${reviewRating}/5`;

  document.querySelectorAll('#rating-picker [data-rating]').forEach(btn => {
    const val = Number(btn.dataset.rating);
    if (btn.classList.contains('rating-star')) btn.classList.toggle('active', reviewRating > 0 && val <= reviewRating);
    else btn.classList.toggle('active', reviewRating === 0);
  });
}

function loadTutorReview(user) {
  const review = getReviews().find(r => r.user_id === user.id);
  const text = document.getElementById('pat-review-text');
  const msg = document.getElementById('pat-review-msg');
  if (msg) msg.textContent = '';

  if (review) {
    setReviewRating(review.rating);
    if (text) text.value = review.text || '';
  } else {
    reviewRating = null;
    if (text) text.value = '';
    const score = document.getElementById('pat-review-score');
    if (score) score.textContent = 'Sem nota';
    document.querySelectorAll('#rating-picker [data-rating]').forEach(btn => btn.classList.remove('active'));
  }
}

async function saveTutorReview() {
  const user = currentSession && currentSession.role === 'pat' ? currentSession.user : null;
  const textEl = document.getElementById('pat-review-text');
  const msg = document.getElementById('pat-review-msg');
  if (!user) return showToast('Sua sessão expirou. Entre novamente.');
  if (reviewRating === null) { if (msg) msg.textContent = 'Escolha uma nota de 0 a 5.'; return; }
  const text = (textEl?.value || '').trim();
  if (!text) { if (msg) msg.textContent = 'Escreva um depoimento antes de publicar.'; return; }
  try {
    const result = await apiRequest('review_save', { method:'POST', body:{ rating:reviewRating, text } });
    dbCache[K.REVS] = cloneData(result.reviews || []);
    renderTestimonials();
    if (msg) msg.textContent = 'Avaliação salva!';
    showToast('Avaliação salva!');
  } catch (err) { if (msg) msg.textContent = err.message; showToast(err.message); }
}

function returnToWebsite() {
  closePanel('pat');
  renderTestimonials();
  showScreen('website-screen');
  setTimeout(() => document.getElementById('depoimentos')?.scrollIntoView({ behavior: 'smooth' }), 50);
}


// =============================================================================
// SEÇÃO 14 — AUTENTICAÇÃO DO TUTOR / PACIENTE
// Login, registro e logout do tutor. Mesma segurança aplicada ao médico.
// =============================================================================

// Alterna entre as abas "Entrar" e "Criar conta" no formulário do tutor
function switchPatTab(tab) {
  document.querySelectorAll('#sm-pat-auth .auth-tab-modal').forEach((el, i) =>
    el.classList.toggle('active', tab === (i === 0 ? 'login' : 'register'))
  );
  document.getElementById('pat-login-panel').style.display    = tab === 'login'    ? '' : 'none';
  document.getElementById('pat-register-panel').style.display = tab === 'register' ? '' : 'none';
  ['pat-login-msg', 'pat-reg-msg'].forEach(id => document.getElementById(id).innerHTML = '');
}

// Processa o login do tutor com segurança
async function doPatLogin() {
  const email = document.getElementById('pat-login-email').value.trim().toLowerCase();
  const password = document.getElementById('pat-login-pwd').value;
  if (!email || !password) return showMsg('pat-login-msg','Preencha todos os campos.','err');
  if (!validarEmail(email)) return showMsg('pat-login-msg','E-mail inválido.','err');
  try {
    const result = await apiRequest('login', { method:'POST', body:{ role:'pat', email, password } });
    currentSession = result.session;
    applyServerData(result.data || {});
    closeSystemModal();
    enterPatPortal(currentSession.user);
  } catch (err) { showMsg('pat-login-msg', err.message, 'err'); }
}

// Cadastro do tutor é processado pelo PHP com password_hash().
async function doPatRegister() {
  const name = document.getElementById('pat-reg-name').value.trim();
  const email = document.getElementById('pat-reg-email').value.trim().toLowerCase();
  const password = document.getElementById('pat-reg-pwd').value;
  if (!name || !email || !password) return showMsg('pat-reg-msg','Preencha todos os campos.','err');
  if (!validarEmail(email)) return showMsg('pat-reg-msg','E-mail inválido.','err');
  const pwdErr = validatePwd(password); if (pwdErr) return showMsg('pat-reg-msg',pwdErr,'err');
  try {
    const result = await apiRequest('register', { method:'POST', body:{ role:'pat', name, email, password } });
    if (!result.session) { showMsg('pat-reg-msg','Conta criada. Confirme o e-mail enviado pelo Supabase e depois entre.','ok'); return; }
    currentSession = result.session;
    applyServerData(result.data || {});
    showMsg('pat-reg-msg','Conta criada com segurança. Entrando...','ok');
    setTimeout(() => { closeSystemModal(); enterPatPortal(currentSession.user); }, 450);
  } catch (err) { showMsg('pat-reg-msg', err.message, 'err'); }
}

// Entra no portal do tutor após login bem-sucedido
function enterPatPortal(user) {
  user = normalizeProfileUser(user);
  showScreen('patient-screen');
  updateProfileUI(user);
  document.getElementById('pat-result').style.display = 'none';
  document.getElementById('pat-na-in').value          = '';
  document.getElementById('pat-search-msg').innerHTML = '';
  loadTutorReview(user);
}

// Encerra a sessão do tutor e volta para o site público
async function doPatLogout() {
  try { await apiRequest('logout', { method:'POST', body:{} }); } catch (err) { console.warn(err); }
  currentSession = null;
  closePanel('pat');
  showScreen('website-screen');
  try { await refreshSecureBootstrap(); renderTestimonials(); } catch (_) {}
}


// =============================================================================
// SEÇÃO 15 — SIDEBAR DO APP DO MÉDICO (menu lateral)
// Controla a abertura e fechamento da barra lateral no painel do médico,
// especialmente útil em dispositivos móveis onde ela fica oculta por padrão.
// =============================================================================

// Estado de abertura da sidebar
let appSbOpen = false;

// Abre ou fecha a sidebar lateral do app do médico
function toggleAppSidebar() {
  appSbOpen = !appSbOpen;
  document.getElementById('app-sidebar').classList.toggle('open', appSbOpen);
}

// Fecha a sidebar ao clicar fora dela (apenas em telas pequenas)
function closeAppSidebar(e) {
  if (appSbOpen && window.innerWidth <= 768) {
    appSbOpen = false;
    document.getElementById('app-sidebar').classList.remove('open');
  }
}


// =============================================================================
// SEÇÃO 16 — NAVEGAÇÃO ENTRE SEÇÕES DO APP DO MÉDICO
// Controla qual seção está visível: Cadastrar Paciente, Banco de Dados ou Agenda.
// =============================================================================

// Exibe a seção escolhida ('cadastro', 'banco' ou 'agenda') e oculta as outras
function showSection(s) {
  ['cadastro', 'banco', 'agenda', 'solicitacoes', 'clinico'].forEach(sec => {
    document.getElementById('section-' + sec).style.display = sec === s ? '' : 'none';
    document.getElementById('nav-' + sec).classList.toggle('active', sec === s);
  });

  // Ações específicas ao entrar em cada seção
  if (s === 'banco') { renderTable(''); updateStats(); }
  if (s === 'agenda') buildCalendar();
  if (s === 'solicitacoes') renderAppointments();
  if (s === 'clinico') { populateClinicalPatientSelect(); renderClinicalArea(); }

  // Fecha a sidebar ao navegar (em mobile)
  appSbOpen = false;
  document.getElementById('app-sidebar').classList.remove('open');
}


// =============================================================================
// SEÇÃO 17 — HORÁRIOS DE PROCEDIMENTOS
// Preenche o seletor de horário com os slots disponíveis:
// 08:00 às 12:30 e 14:00 às 18:00 (excluindo o horário de almoço 12:30–14:00).
// =============================================================================
function buildTimeOpts() {
  const sel = document.getElementById('f-proc-time');
  sel.innerHTML = '<option value="">Selecione</option>';
  for (let h = 8; h <= 18; h++) {
    for (let m = 0; m < 60; m += 30) {
      if (h === 18 && m === 30) break; // não ultrapassa 18:00
      const t = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      if (t >= '12:30' && t < '14:00') continue; // pula horário de almoço
      sel.innerHTML += `<option value="${t}">${t}</option>`;
    }
  }
}


// =============================================================================
// SEÇÃO 18 — FOTO DO ANIMAL PACIENTE
// Lida com o upload da foto do animal no formulário de cadastro.
// A imagem é redimensionada/comprimida e convertida para base64 antes de
// ser salva junto com os dados do paciente.
// =============================================================================

// Redimensiona e comprime uma imagem antes de gerar o base64.
// Fotos de celular podem ter vários MB — sem isso, o localStorage estoura a
// cota silenciosamente (sem erro nenhum) e o salvamento simplesmente não
// acontece, dando a impressão de que "a foto não muda".
function comprimirImagem(file, maxDim = 480, qualidade = 0.82) {
  return new Promise((resolve, reject) => {
    if (!file.type || !file.type.startsWith('image/')) {
      reject(new Error('Arquivo selecionado não é uma imagem.'));
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      reject(new Error('A imagem deve ter no máximo 5 MB.'));
      return;
    }
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const escala = maxDim / Math.max(width, height);
          width  = Math.round(width * escala);
          height = Math.round(height * escala);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', qualidade));
      };
      img.onerror = () => reject(new Error('Não foi possível ler essa imagem.'));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
    reader.readAsDataURL(file);
  });
}

// Armazena temporariamente a foto do animal em base64 durante o cadastro
let photoData = null;

// Lê a imagem selecionada, comprime e exibe a pré-visualização no formulário
async function handlePetPhoto(input) {
  const f = input.files[0];
  if (!f) return;
  try {
    photoData = await comprimirImagem(f);
    document.getElementById('pp-placeholder').style.display = 'none';
    const img = document.getElementById('pp-preview');
    img.src = photoData;
    img.style.display = 'block';
  } catch (err) {
    showToast('Não foi possível carregar essa imagem. Tente outra foto.');
  }
}

// Retorna a data de hoje formatada no padrão brasileiro (DD/MM/AAAA)
const todayStr = () => new Date().toLocaleDateString('pt-BR');

const STATUS_LABELS = {
  agendado: 'Agendado',
  confirmado: 'Confirmado',
  atendimento: 'Em atendimento',
  concluido: 'Concluído',
  cancelado: 'Cancelado'
};

function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
}

function normalizeStatus(status, date, time) {
  if (status) return status;
  if (date && time && new Date(date + 'T' + time) < new Date()) return 'concluido';
  return 'agendado';
}

function statusBadge(status) {
  const safe = normalizeStatus(status);
  return `<span class="status-badge ${safe}">${STATUS_LABELS[safe] || 'Agendado'}</span>`;
}

function getPatientByNA(na) {
  return getPs().find(p => p.na === Number(na));
}

let editingNA = null;

// =============================================================================
// SEÇÃO 19 — CADASTRO DE PACIENTES
// Salva um novo animal ou atualiza o registro existente (mesmo nome + dono).
// Também agenda um procedimento se os campos correspondentes forem preenchidos.
// =============================================================================

// Processa o formulário de cadastro e salva o paciente no banco de dados local
function cadastrar() {
  // Lê e sanitiza todos os campos do formulário
  const nome      = sanitizar(document.getElementById('f-nome').value.trim());
  const especie   = document.getElementById('f-especie').value;
  const raca      = sanitizar(document.getElementById('f-raca').value.trim());
  const idade     = sanitizar(document.getElementById('f-idade').value.trim());
  const dono      = sanitizar(document.getElementById('f-dono').value.trim());
  const donoTel   = sanitizar(document.getElementById('f-dono-tel').value.trim());
  const sintomas  = sanitizar(document.getElementById('f-sintomas').value.trim());
  const proc      = sanitizar(document.getElementById('f-proc').value.trim());
  const procDate  = document.getElementById('f-proc-date').value;
  const procTime  = document.getElementById('f-proc-time').value;
  const msgEl     = document.getElementById('cadastro-msg');

  // Valida campos obrigatórios
  if (!nome || !especie || !raca || !dono || !donoTel) {
    msgEl.innerHTML = '<div class="fm-msg err">Preencha os campos obrigatórios (*).</div>';
    setTimeout(() => msgEl.innerHTML = '', 3500);
    return;
  }

  // Valida formato do telefone do dono (necessário para lembretes de consulta)
  if (!validarTelefone(donoTel)) {
    msgEl.innerHTML = '<div class="fm-msg err">Telefone do dono inválido.</div>';
    setTimeout(() => msgEl.innerHTML = '', 3500);
    return;
  }

  const patients = getPs();
  // Verifica se o paciente já existe (mesmo nome e dono, ignorando maiúsculas)
  const idx = editingNA !== null
    ? patients.findIndex(p => p.na === editingNA)
    : patients.findIndex(
        p => p.nome.toLowerCase() === nome.toLowerCase() &&
             p.dono.toLowerCase() === dono.toLowerCase()
      );
  const dc = todayStr();
  let na, isUpdate = false;

  if (idx >= 0) {
    // Atualiza registro existente e renova data da última consulta
    patients[idx] = { ...patients[idx], nome, especie, raca, idade, dono, donoTel, sintomas, dataConsulta: dc };
    if (photoData) patients[idx].foto = photoData;
    na = patients[idx].na;
    isUpdate = true;
  } else {
    // Cria novo registro com NA sequencial
    na = patients.length > 0 ? Math.max(...patients.map(p => p.na)) + 1 : 1;
    patients.push({ na, nome, especie, raca, idade, dono, donoTel, sintomas, foto: photoData, dataConsulta: dc });
  }

  savePs(patients);

  // Agenda procedimento se os três campos de agendamento estiverem preenchidos
  if (proc && procDate && procTime) {
    const procs = getPrs();
    const patientPhoto = getPatientByNA(na)?.foto || photoData;
    procs.push({ id: Date.now(), na, nome, dono, foto: patientPhoto, proc, date: procDate, time: procTime, status: 'agendado' });
    savePrs(procs);
    const hist = getHist();
    hist.push({ id: Date.now() + 1, na, type: 'Procedimento', date: procDate, desc: `Procedimento agendado: ${proc}` });
    saveHist(hist);
  }

  limparForm();
  updateSbCount();
  showToast(isUpdate ? 'Cadastro atualizado!' : 'Paciente cadastrado com sucesso!');
}

// Limpa todos os campos do formulário de cadastro
function limparForm() {
  ['f-nome','f-raca','f-idade','f-dono','f-dono-tel','f-sintomas','f-proc','f-proc-date']
    .forEach(id => document.getElementById(id).value = '');
  document.getElementById('f-especie').selectedIndex = 0;
  document.getElementById('f-proc-time').selectedIndex = 0;
  document.getElementById('f-foto').value = '';
  editingNA = null;
  photoData = null;
  document.getElementById('pp-preview').style.display   = 'none';
  document.getElementById('pp-placeholder').style.display = '';
  document.getElementById('cadastro-msg').innerHTML = '';
}

// Atualiza o contador de pacientes exibido na sidebar
function updateSbCount() {
  document.getElementById('sb-count').textContent = getPs().length;
}


// =============================================================================
// SEÇÃO 20 — BANCO DE DADOS (tabela de pacientes)
// Exibe estatísticas e a tabela de pacientes cadastrados.
// Suporta filtro de busca por nome, dono ou raça.
// =============================================================================

// Atualiza os cards de estatísticas: total, última consulta e espécie mais comum
function updateStats() {
  const p = getPs();
  document.getElementById('stat-total').textContent = p.length;
  if (p.length > 0) {
    const parse = s => { const [d,m,y] = s.split('/').map(Number); return new Date(y,m-1,d); };
    const sorted = [...p].sort((a,b) => parse(b.dataConsulta) - parse(a.dataConsulta));
    document.getElementById('stat-last').textContent = sorted[0].dataConsulta;
    const c = {};
    p.forEach(x => c[x.especie] = (c[x.especie] || 0) + 1);
    const top = Object.entries(c).sort((a,b) => b[1]-a[1])[0];
    document.getElementById('stat-species').textContent = top ? top[0] : '—';
  } else {
    document.getElementById('stat-last').textContent    = '—';
    document.getElementById('stat-species').textContent = '—';
  }
}

// Renderiza as linhas da tabela de pacientes, filtrando pela busca (q)
function renderTable(q) {
  const patients = getPs();
  const ql = q.toLowerCase();
  // Filtra pacientes cujo nome, dono ou raça contenham o termo buscado
  const f = ql
    ? patients.filter(p =>
        p.nome.toLowerCase().includes(ql) ||
        p.dono.toLowerCase().includes(ql) ||
        p.raca.toLowerCase().includes(ql))
    : patients;

  const tbody = document.getElementById('db-tbody');
  const empty = document.getElementById('db-empty');

  if (!f.length) { tbody.innerHTML = ''; empty.style.display = ''; return; }
  empty.style.display = 'none';

  tbody.innerHTML = f.map(p => `
    <tr>
      <td><span class="na-tag">NA-${String(p.na).padStart(3, '0')}</span></td>
      <td>${safeImageSrc(p.foto)
        ? `<img src="${safeImageSrc(p.foto)}" class="pav"/>`
        : `<div class="pini">${p.nome[0].toUpperCase()}</div>`}</td>
      <td><strong>${sanitizar(p.nome)}</strong>${p.idade
        ? `<br><span style="font-size:12px;color:var(--light)">${sanitizar(p.idade)}</span>` : ''}</td>
      <td><span class="spb">${sanitizar(p.especie)}</span><br>
          <span style="font-size:12px;color:var(--light)">${sanitizar(p.raca)}</span></td>
      <td>${sanitizar(p.dono)}<br><span style="font-size:12px;color:var(--light)">📞 ${sanitizar(p.donoTel || '—')}</span></td>
      <td style="color:var(--light);font-size:13px">${p.dataConsulta}</td>
      <td>
        <div class="table-actions">
          <button class="icon-action" title="Ver ficha" onclick="openPatientDetails(${p.na})">Ver</button>
          <button class="icon-action" title="Editar" onclick="editPatient(${p.na})">Editar</button>
          <button class="icon-action danger" title="Excluir" onclick="deletePatient(${p.na})">Excluir</button>
        </div>
      </td>
    </tr>`).join('');
}

function editPatient(na) {
  const p = getPatientByNA(na);
  if (!p) return;
  editingNA = p.na;
  showSection('cadastro');
  document.getElementById('f-nome').value = p.nome || '';
  document.getElementById('f-especie').value = p.especie || '';
  document.getElementById('f-raca').value = p.raca || '';
  document.getElementById('f-idade').value = p.idade || '';
  document.getElementById('f-dono').value = p.dono || '';
  document.getElementById('f-dono-tel').value = p.donoTel || '';
  document.getElementById('f-sintomas').value = p.sintomas || '';
  if (p.foto) {
    photoData = p.foto;
    document.getElementById('pp-placeholder').style.display = 'none';
    const img = document.getElementById('pp-preview');
    img.src = p.foto;
    img.style.display = 'block';
  }
  showToast(`Editando NA-${String(p.na).padStart(3, '0')}`);
}

function deletePatient(na) {
  const p = getPatientByNA(na);
  if (!p) return;
  const ok = confirm(`Excluir ${p.nome} (NA-${String(p.na).padStart(3, '0')}) e seus dados vinculados?`);
  if (!ok) return;
  savePs(getPs().filter(x => x.na !== na));
  savePrs(getPrs().filter(x => x.na !== na));
  saveHist(getHist().filter(x => x.na !== na));
  saveVacc(getVacc().filter(x => x.na !== na));
  saveApts(getApts().map(a => a.na === na ? { ...a, na: null, status: 'sem-vinculo' } : a));
  renderTable('');
  updateStats();
  updateSbCount();
  renderAppointments();
  showToast('Paciente excluído.');
}

function openPatientDetails(na) {
  const p = getPatientByNA(na);
  if (!p) return;
  const procs = getPrs().filter(x => x.na === na).sort((a,b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));
  const hist = getHist().filter(x => x.na === na).sort((a,b) => (b.date || '').localeCompare(a.date || ''));
  const vacc = getVacc().filter(x => x.na === na).sort((a,b) => (b.next || b.date || '').localeCompare(a.next || a.date || ''));
  const appointments = getApts().filter(x => Number(x.na) === na);
  const av = safeImageSrc(p.foto) ? `<img src="${safeImageSrc(p.foto)}" class="pp-photo"/>` : `<div class="pp-ini">${p.nome[0].toUpperCase()}</div>`;
  document.getElementById('patient-detail-content').innerHTML = `
    <div class="detail-head">${av}<div><h2>${sanitizar(p.nome)}</h2><span class="na-tag">NA-${String(p.na).padStart(3,'0')}</span><p>${sanitizar(p.especie)} · ${sanitizar(p.raca)} · Tutor: ${sanitizar(p.dono)} · 📞 ${sanitizar(p.donoTel || 'Não informado')}</p></div></div>
    <div class="detail-section"><h4>Sintomas / observações</h4><p>${p.sintomas ? sanitizar(p.sintomas) : 'Nenhuma observação registrada.'}</p></div>
    <div class="detail-section"><h4>Procedimentos</h4>${procs.length ? procs.map(x => `<div class="mini-row"><span>${fmtDate(x.date)} ${x.time}</span><strong>${sanitizar(x.proc)}</strong>${statusBadge(normalizeStatus(x.status, x.date, x.time))}</div>`).join('') : '<p>Nenhum procedimento.</p>'}</div>
    <div class="detail-section"><h4>Histórico clínico</h4>${hist.length ? hist.map(x => `<div class="mini-row"><span>${fmtDate(x.date)}</span><strong>${sanitizar(x.type)}</strong><p>${sanitizar(x.desc)}</p></div>`).join('') : '<p>Nenhum evento clínico.</p>'}</div>
    <div class="detail-section"><h4>Vacinas</h4>${vacc.length ? vacc.map(x => `<div class="mini-row"><span>${fmtDate(x.date)}</span><strong>${sanitizar(x.name)}</strong><p>Próxima dose: ${fmtDate(x.next)} · ${sanitizar(x.status)}</p></div>`).join('') : '<p>Nenhuma vacina registrada.</p>'}</div>
    <div class="detail-section"><h4>Pré-agendamentos</h4>${appointments.length ? appointments.map(x => `<div class="mini-row"><span>${fmtDate(x.date)}</span><strong>${sanitizar(x.service)}</strong><p>${sanitizar(x.message || 'Sem mensagem.')}</p></div>`).join('') : '<p>Nenhuma solicitação vinculada.</p>'}</div>`;
  document.getElementById('patient-detail-modal-bg').classList.add('open');
}

function closePatientDetails() {
  document.getElementById('patient-detail-modal-bg').classList.remove('open');
}


// =============================================================================
// SEÇÃO 21 — CALENDÁRIO DO MÉDICO (agenda de procedimentos)
// Exibe um calendário mensal com os dias que têm procedimentos agendados.
// Ao clicar num dia, mostra os detalhes dos procedimentos daquele dia.
// =============================================================================

// Nomes dos meses em português
const MONTHS = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

// Abreviações dos dias da semana
const DOWS = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];

// Estado do calendário: ano, mês e dia selecionado atualmente
let calY = new Date().getFullYear();
let calM = new Date().getMonth();
let selDay = null;

// Navega entre meses: dir=-1 (mês anterior), dir=0 (hoje), dir=1 (próximo mês)
function changeCalMonth(dir) {
  if (dir === 0) { calY = new Date().getFullYear(); calM = new Date().getMonth(); }
  else {
    calM += dir;
    if (calM < 0)  { calM = 11; calY--; }
    if (calM > 11) { calM = 0;  calY++; }
  }
  buildCalendar();
}

// Constrói e renderiza o calendário completo do mês atual
function buildCalendar() {
  document.getElementById('cal-month-title').textContent = `${MONTHS[calM]} ${calY}`;
  document.getElementById('cal-dows').innerHTML = DOWS.map(d => `<div class="cal-dow">${d}</div>`).join('');

  // Conta procedimentos por dia do mês atual
  const procs = getPrs();
  const procDays = {};
  procs.forEach(p => {
    const [y,m,d] = p.date.split('-').map(Number);
    if (y === calY && m - 1 === calM) procDays[d] = (procDays[d] || 0) + 1;
  });

  const first    = new Date(calY, calM, 1).getDay();    // dia da semana do dia 1
  const days     = new Date(calY, calM + 1, 0).getDate(); // total de dias no mês
  const prevDays = new Date(calY, calM, 0).getDate();   // dias do mês anterior
  const today    = new Date();
  let html = '';

  // Células do mês anterior (preenchimento antes do dia 1)
  for (let i = 0; i < first; i++)
    html += `<div class="cal-day other"><div class="cal-dn">${prevDays - first + i + 1}</div></div>`;

  // Células dos dias do mês atual
  for (let d = 1; d <= days; d++) {
    const isT  = today.getFullYear() === calY && today.getMonth() === calM && today.getDate() === d;
    const isS  = selDay === d;
    const cnt  = procDays[d] || 0;
    let cls = 'cal-day';
    if (isT) cls += ' today';
    if (isS) cls += ' selected';
    if (cnt > 0) cls += ' has-ev';
    const dots = cnt > 0
      ? `<div class="cal-dots">${Array(Math.min(cnt,5)).fill('<div class="cal-dot"></div>').join('')}</div>`
      : '';
    html += `<div class="${cls}" onclick="selectDay(${d})"><div class="cal-dn">${d}</div>${dots}</div>`;
  }

  // Células do próximo mês (preenchimento após o último dia)
  const rem = (7 - (first + days) % 7) % 7;
  for (let i = 1; i <= rem; i++)
    html += `<div class="cal-day other"><div class="cal-dn">${i}</div></div>`;

  document.getElementById('cal-days').innerHTML = html;
  if (selDay) renderCalDet(selDay);
}

// Seleciona um dia no calendário e exibe seus procedimentos
function selectDay(d) {
  selDay = d;
  buildCalendar();
  renderCalDet(d);
}

// Renderiza os procedimentos agendados para o dia selecionado
function renderCalDet(d) {
  const iso   = `${calY}-${String(calM+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  const procs = getPrs().filter(p => p.date === iso).sort((a,b) => a.time.localeCompare(b.time));
  const det   = document.getElementById('cal-det');

  document.getElementById('cal-det-date').textContent  = `${String(d).padStart(2,'0')}/${String(calM+1).padStart(2,'0')}/${calY}`;
  document.getElementById('cal-badge-cnt').textContent = `${procs.length} procedimento${procs.length !== 1 ? 's' : ''}`;
  det.style.display = '';

  if (!procs.length) {
    document.getElementById('cal-proc-list').innerHTML =
      '<div class="cal-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M8 12h8M12 8v8"/></svg>Nenhum procedimento para este dia.</div>';
    return;
  }

  // Monta os cartões de cada procedimento com avatar, nome, NA e descrição
  document.getElementById('cal-proc-list').innerHTML = procs.map(p => {
    const av = safeImageSrc(p.foto)
      ? `<img src="${safeImageSrc(p.foto)}" class="proc-av"/>`
      : `<div class="proc-ini">${p.nome[0].toUpperCase()}</div>`;
    return `<div class="proc-item">
      <div class="proc-time">${p.time}</div>
      ${av}
      <div class="proc-info">
        <div class="pin">${sanitizar(p.nome)}</div>
        <div class="pina"><span class="na-tag">NA-${String(p.na).padStart(3,'0')}</span></div>
        <div class="pidc">${sanitizar(p.proc)}</div>
        <div class="pido">Tutor: ${sanitizar(p.dono)} · 📞 ${sanitizar(getPatientByNA(p.na)?.donoTel || '—')}</div>
        <div class="status-row">
          ${statusBadge(normalizeStatus(p.status, p.date, p.time))}
          <select class="status-select" onchange="updateProcStatus(${p.id}, this.value)">
            ${Object.entries(STATUS_LABELS).map(([value,label]) => `<option value="${value}" ${normalizeStatus(p.status, p.date, p.time) === value ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </div>
      </div>
    </div>`;
  }).join('');
}

function updateProcStatus(id, status) {
  const procs = getPrs();
  const idx = procs.findIndex(p => p.id === id);
  if (idx < 0) return;
  procs[idx].status = status;
  savePrs(procs);
  buildCalendar();
  if (curNA) renderPatProcs();
  showToast('Status do procedimento atualizado.');
}


// =============================================================================
// SEÇÃO 22 — PORTAL DO TUTOR (busca e histórico do animal)
// Permite que o tutor busque o pet pelo NA e visualize o histórico de
// procedimentos, com indicação se já foram realizados (verde) ou pendentes (azul).
// =============================================================================

// Estado do calendário do portal do tutor
let patCalY = new Date().getFullYear();
let patCalM = new Date().getMonth();
let curNA   = null; // NA do animal atualmente consultado

// O tutor só recebe dados de pets vinculados à própria conta. No primeiro acesso,
// o vínculo exige NA + telefone já cadastrado pela clínica.
async function searchPat() {
  const val = document.getElementById('pat-na-in').value.trim();
  const na = parseInt(val, 10);
  const msgEl = document.getElementById('pat-search-msg');
  if (!val || isNaN(na)) { msgEl.innerHTML = '<div class="auth-msg-box err">Digite um NA válido.</div>'; return; }
  let patient = getPs().find(p => Number(p.na) === na);
  if (!patient) {
    const phoneEl = document.getElementById('pat-claim-phone');
    const phone = phoneEl ? phoneEl.value.trim() : '';
    if (!validarTelefone(phone)) {
      msgEl.innerHTML = '<div class="auth-msg-box err">No primeiro acesso, informe também o telefone cadastrado na clínica.</div>';
      return;
    }
    try {
      const result = await apiRequest('patient_claim', { method:'POST', body:{ na, phone } });
      applyServerData(result.data || {});
      patient = getPs().find(p => Number(p.na) === na);
    } catch (err) { msgEl.innerHTML = `<div class="auth-msg-box err">${sanitizar(err.message)}</div>`; return; }
  }
  if (!patient) { msgEl.innerHTML = '<div class="auth-msg-box err">Não foi possível acessar esse pet.</div>'; return; }
  msgEl.innerHTML = '';
  curNA = na;
  showPatResult(patient);
}

// Exibe as informações do animal encontrado e seus procedimentos
function showPatResult(p) {
  document.getElementById('pat-result').style.display = '';
  const av = safeImageSrc(p.foto)
    ? `<img src="${safeImageSrc(p.foto)}" class="pp-photo"/>`
    : `<div class="pp-ini">${p.nome[0].toUpperCase()}</div>`;
  document.getElementById('pat-profile-card').innerHTML = `
    ${av}
    <div class="pp-info">
      <h2>${sanitizar(p.nome)}</h2>
      <span class="na-tag" style="margin-top:4px;display:inline-block">NA-${String(p.na).padStart(3,'0')}</span>
      <div class="pp-meta">
        <div class="pp-mi">🐾 ${sanitizar(p.especie)} · ${sanitizar(p.raca)}</div>
        ${p.idade ? `<div class="pp-mi">🗓 ${sanitizar(p.idade)}</div>` : ''}
        <div class="pp-mi">👤 ${sanitizar(p.dono)}</div>
      </div>
      <div class="pp-tel-row">
        <span class="pp-tel-lbl">📞 Telefone para contato</span>
        <input type="tel" id="pp-tel-input" placeholder="(16) 99999-8888"/>
        <button class="pp-tel-save" onclick="savePatOwnerPhone()">Salvar</button>
      </div>
      <div id="pp-tel-msg"></div>
    </div>`;
  // Preenche o valor via propriedade (não via atributo HTML) para não ter
  // que reescapar aspas do telefone dentro de um value="..."
  document.getElementById('pp-tel-input').value = p.donoTel || '';
  patCalY = new Date().getFullYear();
  patCalM = new Date().getMonth();
  buildPatCal();
  renderPatProcs();
  renderPatHistory();
  renderPatVaccines();
  renderPatAppointments();
}

// Salva o telefone de contato informado pelo tutor no registro do animal.
// É o mesmo campo que o médico vê e edita ao cadastrar/editar o paciente.
async function savePatOwnerPhone() {
  const msgEl = document.getElementById('pp-tel-msg');
  if (!curNA) return;
  const tel = document.getElementById('pp-tel-input').value.trim();
  if (!validarTelefone(tel)) {
    msgEl.innerHTML = '<div class="fm-msg err">Informe um telefone válido.</div>';
    setTimeout(() => msgEl.innerHTML = '', 3000); return;
  }
  try {
    const result = await apiRequest('patient_phone_update', { method:'POST', body:{ na:curNA, phone:tel } });
    applyServerData(result.data || {});
    const patient = getPatientByNA(curNA); if (patient) showPatResult(patient);
    msgEl.innerHTML = '<div class="fm-msg ok">Telefone atualizado!</div>';
    setTimeout(() => msgEl.innerHTML = '', 2500);
    showToast('Telefone de contato atualizado!');
  } catch (err) { msgEl.innerHTML = `<div class="fm-msg err">${sanitizar(err.message)}</div>`; }
}

// Navega entre meses no calendário do portal do tutor
function changePatCal(dir) {
  patCalM += dir;
  if (patCalM < 0)  { patCalM = 11; patCalY--; }
  if (patCalM > 11) { patCalM = 0;  patCalY++; }
  buildPatCal();
}

// Constrói o mini-calendário do tutor mostrando só os dias com procedimentos do animal
function buildPatCal() {
  document.getElementById('pat-cal-month').textContent =
    `${MONTHS[patCalM]} ${patCalY}`;
  document.getElementById('pat-cal-dows').innerHTML =
    DOWS.map(d => `<div class="cal-dow" style="font-size:11px">${d}</div>`).join('');

  // Filtra apenas os procedimentos do animal atual
  const procs = getPrs().filter(p => p.na === curNA);
  const pd = {};
  procs.forEach(p => {
    const [y,m,d] = p.date.split('-').map(Number);
    if (y === patCalY && m - 1 === patCalM) pd[d] = (pd[d] || 0) + 1;
  });

  const first    = new Date(patCalY, patCalM, 1).getDay();
  const days     = new Date(patCalY, patCalM + 1, 0).getDate();
  const prevDays = new Date(patCalY, patCalM, 0).getDate();
  const today    = new Date();
  let html = '';

  for (let i = 0; i < first; i++)
    html += `<div class="cal-day other" style="min-height:44px"><div class="cal-dn">${prevDays-first+i+1}</div></div>`;

  for (let d = 1; d <= days; d++) {
    const isT = today.getFullYear()===patCalY && today.getMonth()===patCalM && today.getDate()===d;
    const cnt = pd[d] || 0;
    let cls = 'cal-day';
    if (isT) cls += ' today';
    if (cnt > 0) cls += ' has-ev';
    const dots = cnt > 0
      ? `<div class="cal-dots">${Array(Math.min(cnt,3)).fill('<div class="cal-dot"></div>').join('')}</div>`
      : '';
    html += `<div class="${cls}" style="min-height:44px;cursor:default"><div class="cal-dn">${d}</div>${dots}</div>`;
  }

  const rem = (7 - (first + days) % 7) % 7;
  for (let i = 1; i <= rem; i++)
    html += `<div class="cal-day other" style="min-height:44px"><div class="cal-dn">${i}</div></div>`;

  document.getElementById('pat-cal-days').innerHTML = html;
}

// Renderiza a lista de procedimentos do animal com status: realizado (verde) ou pendente (azul)
function renderPatProcs() {
  const procs = getPrs()
    .filter(p => p.na === curNA)
    .sort((a,b) => new Date(a.date+'T'+a.time) - new Date(b.date+'T'+b.time));

  const el = document.getElementById('pat-procs');
  if (!procs.length) {
    el.innerHTML = '<div class="no-procs">Nenhum procedimento agendado para este paciente.</div>';
    return;
  }

  el.innerHTML = procs.map(p => {
    const state = normalizeStatus(p.status, p.date, p.time);
    const done = state === 'concluido';
    const [y,m,d] = p.date.split('-').map(Number);
    const ds   = `${String(d).padStart(2,'0')}/${String(m).padStart(2,'0')}/${y}`;

    const status = state === 'concluido'
      ? `<div class="pst-done"><svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 8l4 4 6-7"/></svg>Concluído</div>`
      : `<div class="pst-pending">${STATUS_LABELS[state] || 'Agendado'}</div>`;

    return `<div class="ppi ${done ? 'done' : 'pending'}">
      <div><div class="ppi-date">${ds}</div><div class="ppi-time">${p.time}</div></div>
      <div class="ppi-desc">${sanitizar(p.proc)}</div>
      ${status}
    </div>`;
  }).join('');
}

async function submitAppointment() {
  const tutor = document.getElementById('appt-tutor').value.trim();
  const phone = document.getElementById('appt-phone').value.trim();
  const pet = document.getElementById('appt-pet').value.trim();
  const naRaw = document.getElementById('appt-na').value.trim();
  const service = document.getElementById('appt-service').value;
  const date = document.getElementById('appt-date').value;
  const message = document.getElementById('appt-message').value.trim();
  if (!tutor || !phone || !pet || !service || !date) return showToast('Preencha tutor, telefone, pet, serviço e data preferida.');
  if (!validarTelefone(phone)) return showToast('Informe um telefone válido.');
  const na = naRaw ? parseInt(naRaw,10) : null;
  try {
    await apiRequest('appointment_create', { method:'POST', body:{ tutor,phone,pet,na,service,date,time:'',message } });
    ['appt-tutor','appt-phone','appt-pet','appt-na','appt-date','appt-message'].forEach(id => document.getElementById(id).value='');
    document.getElementById('appt-service').selectedIndex=0;
    if (currentSession) { const r=await refreshSecureBootstrap(); if (currentSession?.role==='pat') enterPatPortal(currentSession.user); }
    showToast('Pré-agendamento enviado!');
  } catch (err) { showToast(err.message); }
}

function renderAppointments() {
  const appointments = getApts();
  const list = document.getElementById('appointments-list');
  if (!list) return;
  const pending = appointments.filter(a => a.status !== 'confirmado' && a.status !== 'cancelado').length;
  document.getElementById('appt-stat-total').textContent = appointments.length;
  document.getElementById('appt-stat-pending').textContent = pending;
  document.getElementById('appt-stat-linked').textContent = appointments.filter(a => a.na).length;

  if (!appointments.length) {
    list.innerHTML = '<div class="empty-st"><p>Nenhuma solicitação recebida ainda.</p></div>';
    return;
  }

  list.innerHTML = appointments.map(a => {
    const patient = a.na ? getPatientByNA(a.na) : null;
    return `<article class="request-card">
      <div class="request-main">
        <div>
          <span class="request-date">${fmtDate(a.date)}${a.time ? ` · ${a.time}` : ''}</span>
          <h3>${sanitizar(a.pet)} · ${sanitizar(a.service)}</h3>
          <p>${sanitizar(a.message || 'Sem mensagem adicional.')}</p>
          <div class="request-meta">
            <span>Tutor: ${sanitizar(a.tutor)}</span>
            <span>Contato: ${sanitizar(a.phone)}</span>
            <span>${patient ? `Vinculado a NA-${String(a.na).padStart(3,'0')}` : 'Sem NA vinculado'}</span>
          </div>
        </div>
        <span class="request-status ${a.status || 'recebido'}">${sanitizar(a.status || 'recebido')}</span>
      </div>
      <div class="request-actions">
        <select onchange="updateAppointmentStatus(${a.id}, this.value)">
          ${['recebido','em-retorno','confirmado','cancelado','sem-vinculo'].map(s => `<option value="${s}" ${(a.status || 'recebido') === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
        <input type="number" min="1" value="${a.na || ''}" placeholder="NA" onchange="linkAppointmentToPatient(${a.id}, this.value)"/>
        <button class="btn-clr" onclick="deleteAppointment(${a.id})">Excluir</button>
      </div>
    </article>`;
  }).join('');
}

function updateAppointmentStatus(id, status) {
  const arr = getApts();
  const idx = arr.findIndex(a => a.id === id);
  if (idx < 0) return;
  arr[idx].status = status;
  saveApts(arr);
  renderAppointments();
  if (curNA) renderPatAppointments();
}

function linkAppointmentToPatient(id, value) {
  const arr = getApts();
  const idx = arr.findIndex(a => a.id === id);
  if (idx < 0) return;
  const na = parseInt(value, 10);
  if (!value) arr[idx].na = null;
  else if (getPatientByNA(na)) arr[idx].na = na;
  else {
    showToast('NA não encontrado.');
    renderAppointments();
    return;
  }
  saveApts(arr);
  renderAppointments();
  if (curNA) renderPatAppointments();
}

function deleteAppointment(id) {
  if (!confirm('Excluir esta solicitação?')) return;
  saveApts(getApts().filter(a => a.id !== id));
  renderAppointments();
  if (curNA) renderPatAppointments();
}

function populateClinicalPatientSelect() {
  const sel = document.getElementById('clinical-patient');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">Selecione</option>' + getPs().map(p =>
    `<option value="${p.na}">NA-${String(p.na).padStart(3,'0')} · ${sanitizar(p.nome)} (${sanitizar(p.dono)})</option>`
  ).join('');
  if (current && getPatientByNA(Number(current))) sel.value = current;
}

function activeClinicalNA() {
  const sel = document.getElementById('clinical-patient');
  return sel && sel.value ? Number(sel.value) : null;
}

function renderClinicalArea() {
  const na = activeClinicalNA();
  const patient = na ? getPatientByNA(na) : null;
  const card = document.getElementById('clinical-patient-card');
  const histEl = document.getElementById('clinical-history-list');
  const vacEl = document.getElementById('clinical-vaccine-list');
  if (!card || !histEl || !vacEl) return;
  if (!patient) {
    card.innerHTML = '<p class="muted">Selecione um paciente para editar o prontuário.</p>';
    histEl.innerHTML = '<div class="no-procs">Nenhum paciente selecionado.</div>';
    vacEl.innerHTML = '<div class="no-procs">Nenhum paciente selecionado.</div>';
    return;
  }

  card.innerHTML = `<strong>${sanitizar(patient.nome)}</strong><span class="na-tag">NA-${String(patient.na).padStart(3,'0')}</span><p>${sanitizar(patient.especie)} · ${sanitizar(patient.raca)} · Tutor: ${sanitizar(patient.dono)}</p>`;
  const hist = getHist().filter(h => h.na === na).sort((a,b) => (b.date || '').localeCompare(a.date || ''));
  const vacc = getVacc().filter(v => v.na === na).sort((a,b) => (b.next || b.date || '').localeCompare(a.next || a.date || ''));
  histEl.innerHTML = hist.length ? hist.map(h => `<div class="timeline-item"><div class="timeline-date">${fmtDate(h.date)}</div><div><strong>${sanitizar(h.type)}</strong><p>${sanitizar(h.desc)}</p></div><button class="mini-danger" onclick="removeHistoryEvent(${h.id})">Remover</button></div>`).join('') : '<div class="no-procs">Nenhum evento clínico registrado.</div>';
  vacEl.innerHTML = vacc.length ? vacc.map(v => `<div class="timeline-item"><div class="timeline-date">${fmtDate(v.date)}</div><div><strong>${sanitizar(v.name)}</strong><p>Próxima dose: ${fmtDate(v.next)} · ${sanitizar(v.status)}</p></div><button class="mini-danger" onclick="removeVaccineEvent(${v.id})">Remover</button></div>`).join('') : '<div class="no-procs">Nenhuma vacina registrada.</div>';
}

function addHistoryEvent() {
  const na = activeClinicalNA();
  if (!na) return showToast('Selecione um paciente.');
  const type = sanitizar(document.getElementById('hist-type').value);
  const date = document.getElementById('hist-date').value || new Date().toISOString().slice(0,10);
  const desc = sanitizar(document.getElementById('hist-desc').value.trim());
  if (!desc) return showToast('Descreva o evento clínico.');
  const hist = getHist();
  hist.push({ id: Date.now(), na, type, date, desc });
  saveHist(hist);
  document.getElementById('hist-desc').value = '';
  document.getElementById('hist-date').value = '';
  renderClinicalArea();
  if (curNA === na) renderPatHistory();
  showToast('Evento clínico adicionado.');
}

function removeHistoryEvent(id) {
  saveHist(getHist().filter(h => h.id !== id));
  renderClinicalArea();
  if (curNA) renderPatHistory();
}

function addVaccineEvent() {
  const na = activeClinicalNA();
  if (!na) return showToast('Selecione um paciente.');
  const name = sanitizar(document.getElementById('vac-name').value.trim());
  const date = document.getElementById('vac-date').value || new Date().toISOString().slice(0,10);
  const next = document.getElementById('vac-next').value;
  const status = sanitizar(document.getElementById('vac-status').value);
  if (!name) return showToast('Informe o nome da vacina.');
  const vacc = getVacc();
  vacc.push({ id: Date.now(), na, name, date, next, status });
  saveVacc(vacc);
  ['vac-name','vac-date','vac-next'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('vac-status').selectedIndex = 0;
  renderClinicalArea();
  if (curNA === na) renderPatVaccines();
  showToast('Vacina salva.');
}

function removeVaccineEvent(id) {
  saveVacc(getVacc().filter(v => v.id !== id));
  renderClinicalArea();
  if (curNA) renderPatVaccines();
}

function renderPatHistory() {
  const el = document.getElementById('pat-history-list');
  if (!el) return;
  const hist = getHist().filter(h => h.na === curNA).sort((a,b) => (b.date || '').localeCompare(a.date || ''));
  el.innerHTML = hist.length ? hist.map(h => `<div class="pat-info-item"><span>${fmtDate(h.date)}</span><strong>${sanitizar(h.type)}</strong><p>${sanitizar(h.desc)}</p></div>`).join('') : '<div class="no-procs">Nenhum histórico clínico disponível.</div>';
}

function renderPatVaccines() {
  const el = document.getElementById('pat-vaccine-list');
  if (!el) return;
  const vacc = getVacc().filter(v => v.na === curNA).sort((a,b) => (b.next || b.date || '').localeCompare(a.next || a.date || ''));
  el.innerHTML = vacc.length ? vacc.map(v => `<div class="pat-info-item"><span>${fmtDate(v.date)}</span><strong>${sanitizar(v.name)}</strong><p>Próxima dose: ${fmtDate(v.next)} · ${sanitizar(v.status)}</p></div>`).join('') : '<div class="no-procs">Nenhuma vacina registrada.</div>';
}

function renderPatAppointments() {
  const el = document.getElementById('pat-appointment-list');
  if (!el) return;
  const arr = getApts().filter(a => Number(a.na) === curNA);
  el.innerHTML = arr.length ? arr.map(a => `<div class="pat-info-item"><span>${fmtDate(a.date)}${a.time ? ` · ${a.time}` : ''}</span><strong>${sanitizar(a.service)}</strong><p>${sanitizar(a.status || 'recebido')} · ${sanitizar(a.message || 'Sem mensagem.')}</p></div>`).join('') : '<div class="no-procs">Nenhum pré-agendamento vinculado a este NA.</div>';
}


// =============================================================================
// SEÇÃO 23 — PAINEL DE PERFIL (dropdown da conta)
// Controla a abertura e fechamento do painel que aparece ao clicar no botão
// de conta no canto superior direito (médico e tutor possuem painéis separados).
// =============================================================================

// Papel cujo painel de perfil está aberto no momento (null = nenhum)
let activePanel = null;

// Abre ou fecha o painel de perfil do papel indicado ('doc' ou 'pat')
function togglePanel(role) {
  if (activePanel === role) { closePanel(role); return; }
  if (activePanel) closePanel(activePanel);
  activePanel = role;
  document.getElementById(role + '-panel').classList.add('open');
  document.getElementById(role + '-overlay').classList.add('open');
  document.getElementById(role === 'doc' ? 'doc-user-btn' : 'pat-user-btn').classList.add('open');
}

// Fecha o painel de perfil do papel indicado
function closePanel(role) {
  document.getElementById(role + '-panel').classList.remove('open');
  document.getElementById(role + '-overlay').classList.remove('open');
  const btn = document.getElementById(role === 'doc' ? 'doc-user-btn' : 'pat-user-btn');
  if (btn) btn.classList.remove('open');
  if (activePanel === role) activePanel = null;
}


// =============================================================================
// SEÇÃO 24 — EDIÇÃO DE PERFIL
// Permite ao usuário (médico ou tutor) trocar a foto de perfil e/ou a senha.
// A senha antiga deve ser confirmada antes de aceitar a nova.
// A nova senha é armazenada como hash, nunca em texto puro.
// =============================================================================

// Papel sendo editado e nova foto temporária
let editRole = null;
let newPhoto = null;

// Abre o modal de edição de perfil para o papel indicado
function openEdit(role) {
  editRole = role;
  newPhoto = null;
  closePanel(role);
  const user = currentSession && currentSession.role === role ? normalizeProfileUser(currentSession.user) : null;
  if (!user) return showToast('Sua sessão expirou. Entre novamente.');
  const av = document.getElementById('edit-av');
  const safePhoto = safeImageSrc(user.photo);
  if (safePhoto) av.innerHTML = `<img src="${safePhoto}" alt="Foto de perfil"/>`; else av.textContent = profileInitials(user);
  document.getElementById('edit-name').value = user.name || '';
  ['edit-old-pwd','edit-new-pwd','edit-conf-pwd'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('edit-photo-in').value = '';
  document.getElementById('edit-msg').innerHTML = '';
  document.getElementById('edit-modal-bg').classList.add('open');
}

// Fecha o modal de edição de perfil
function closeEdit() {
  document.getElementById('edit-modal-bg').classList.remove('open');
  newPhoto = null;
}

// Lê a nova foto selecionada, comprime e exibe a pré-visualização no modal
async function handleEditPhoto(input) {
  const f = input.files[0];
  if (!f) return;
  try {
    newPhoto = await comprimirImagem(f);
    document.getElementById('edit-av').innerHTML = `<img src="${newPhoto}" alt="Nova foto de perfil"/>`;
  } catch (err) {
    showMMsg('Não foi possível carregar essa imagem. Tente outra foto.', 'err');
    input.value = '';
  }
}

// Salva as alterações de perfil (nome, foto e/ou senha) com segurança
async function saveEdit() {
  const newName = document.getElementById('edit-name').value.trim();
  const oldPwd = document.getElementById('edit-old-pwd').value;
  const newPwd = document.getElementById('edit-new-pwd').value;
  const confPwd = document.getElementById('edit-conf-pwd').value;
  const hasPwd = oldPwd || newPwd || confPwd;
  if (!newName) return showMMsg('Informe seu nome.', 'err');
  if (!currentSession || currentSession.role !== editRole) return showMMsg('Sua sessão expirou.', 'err');
  if (hasPwd) {
    if (!oldPwd || !newPwd || !confPwd) return showMMsg('Preencha todos os campos de senha.', 'err');
    if (newPwd !== confPwd) return showMMsg('As senhas não coincidem.', 'err');
    const errPwd = validatePwd(newPwd); if (errPwd) return showMMsg(errPwd, 'err');
  }
  const body = { name:newName, old_password: hasPwd ? oldPwd : '', new_password: hasPwd ? newPwd : '' };
  if (newPhoto !== null) body.photo = newPhoto;
  try {
    const result = await apiRequest('profile_update', { method:'POST', body });
    currentSession.user = normalizeProfileUser(result.user);
    updateProfileUI(currentSession.user);
    showMMsg('Perfil atualizado com sucesso!', 'ok');
    setTimeout(() => closeEdit(), 900);
    showToast('Perfil atualizado!');
  } catch (err) { showMMsg(err.message, 'err'); }
}


// =============================================================================
// SEÇÃO 25 — CONFIRMAÇÃO DE LOGOUT
// Exibe um modal pedindo confirmação antes de encerrar a sessão.
// Ao confirmar, a sessão é encerrada e o usuário volta para o site público.
// =============================================================================

// Papel que está solicitando o logout
let confirmRole = null;

// Abre o modal de confirmação de saída
function openConfirm(role) {
  confirmRole = role;
  closePanel(role);
  document.getElementById('confirm-modal-bg').classList.add('open');
}

// Fecha o modal de confirmação sem sair
function closeConfirm() {
  document.getElementById('confirm-modal-bg').classList.remove('open');
}

// Executa o logout após confirmação do usuário
function doConfirmLogout() {
  closeConfirm();
  if (confirmRole === 'doc') doDocLogout();
  else doPatLogout();
}


// =============================================================================
// SEÇÃO 26 — LEMBRETE DE CONSULTAS
// Enquanto o médico está logado, verifica periodicamente se algum
// procedimento agendado para hoje já chegou no horário marcado.
// Quando chega a hora, um cartão aparece na tela com o nome do animal,
// o tutor e o telefone de contato, para o médico entrar em contato.
// =============================================================================

// IDs de procedimentos já avisados (evita repetir o mesmo lembrete)
let remindedProcIds = new Set();
// IDs de procedimentos com lembrete ativo (ainda não dispensado pelo médico)
let activeReminders = [];
// Referência do intervalo de verificação (para poder cancelar no logout)
let reminderInterval = null;

// Verifica se algum procedimento de hoje "venceu" o horário e ainda não foi avisado
function checkReminders() {
  const now = new Date();
  const todayISO = now.toISOString().slice(0, 10);
  const nowMin = now.getHours() * 60 + now.getMinutes();

  const procsHoje = getPrs().filter(p => p.date === todayISO);
  let mudou = false;

  procsHoje.forEach(p => {
    const status = normalizeStatus(p.status, p.date, p.time);
    // Só avisa procedimentos que ainda não foram atendidos/cancelados
    if (status !== 'agendado' && status !== 'confirmado') return;
    if (remindedProcIds.has(p.id)) return;

    const [h, m] = p.time.split(':').map(Number);
    const horarioMin = h * 60 + m;
    if (nowMin < horarioMin) return; // ainda não chegou a hora

    remindedProcIds.add(p.id);
    activeReminders.push(p.id);
    mudou = true;
  });

  if (mudou) renderReminders();
}

// Renderiza os cartões de lembrete ativos na tela do médico
function renderReminders() {
  const el = document.getElementById('reminder-stack');
  if (!el) return;

  const procs = getPrs();
  el.innerHTML = activeReminders.map(id => {
    const p = procs.find(x => x.id === id);
    if (!p) return '';
    const tel = getPatientByNA(p.na)?.donoTel;
    return `<div class="reminder-card">
      <div class="reminder-top">🔔 Horário da consulta chegou</div>
      <h4>${sanitizar(p.nome)}<span class="na-tag">NA-${String(p.na).padStart(3,'0')}</span></h4>
      <p>${sanitizar(p.proc)} · ${p.time}</p>
      <p>Tutor: ${sanitizar(p.dono)}</p>
      <div class="reminder-phone">📞 ${sanitizar(tel || 'Telefone não informado')}</div>
      <button class="reminder-btn-dismiss" onclick="dismissReminder(${p.id})">Dispensar</button>
    </div>`;
  }).filter(Boolean).join('');
}

// Remove um lembrete da tela (o procedimento não volta a ser avisado)
function dismissReminder(id) {
  activeReminders = activeReminders.filter(x => x !== id);
  renderReminders();
}

// Liga a verificação periódica de lembretes (chamado ao entrar no app do médico)
function startReminderWatch() {
  checkReminders();
  if (reminderInterval) clearInterval(reminderInterval);
  reminderInterval = setInterval(checkReminders, 20000); // a cada 20s
}

// Desliga a verificação e limpa os lembretes (chamado ao sair do app do médico)
function stopReminderWatch() {
  if (reminderInterval) { clearInterval(reminderInterval); reminderInterval = null; }
  remindedProcIds = new Set();
  activeReminders = [];
  renderReminders();
}




// =============================================================================
// JANELAS DA HOME: SERVIÇOS E AGENDAMENTO
// Mantêm a estética do site e acompanham automaticamente o tema claro/escuro.
// O agendamento usa os dados carregados do MySQL e revalida a disponibilidade
// antes de gravar para reduzir risco de conflito de horário.
// =============================================================================
function updateHomeModalLock() {
  const servicesOpen = document.getElementById('services-modal-bg')?.classList.contains('open');
  const bookingOpen = document.getElementById('booking-modal-bg')?.classList.contains('open');
  document.body.classList.toggle('services-modal-open', !!servicesOpen);
  document.body.classList.toggle('booking-modal-open', !!bookingOpen);
}

function openServicesModal() {
  const modal = document.getElementById('services-modal-bg');
  if (!modal) return;
  modal.classList.add('open');
  updateHomeModalLock();
}

function closeServicesModal() {
  const modal = document.getElementById('services-modal-bg');
  if (!modal) return;
  modal.classList.remove('open');
  updateHomeModalLock();
}

function openAppointmentFromServices() {
  closeServicesModal();
  setTimeout(() => openAppointmentModal(), 80);
}

const BOOKING_WEEKDAYS = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
let bookingSelectedDate = '';
let bookingSelectedTime = '';
let bookingOccupiedSlots = new Set();

function bookingISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getBookingTimeSlots() {
  const slots = [];
  for (let h = 8; h <= 18; h++) {
    for (let m = 0; m < 60; m += 30) {
      if (h === 18 && m === 30) break;
      const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      if (time >= '12:30' && time < '14:00') continue;
      slots.push(time);
    }
  }
  return slots;
}

function getNextBookingDates(limit = 12) {
  const dates = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  let guard = 0;

  while (dates.length < limit && guard < 40) {
    const day = cursor.getDay();
    if (day >= 1 && day <= 5) dates.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
    guard++;
  }
  return dates;
}

function isBookingSlotOccupied(date, time) {
  return bookingOccupiedSlots.has(`${date}|${time}`);
}

function availableBookingSlots(date) {
  return getBookingTimeSlots().filter(time => !isBookingSlotOccupied(date, time));
}

async function refreshBookingAvailability() {
  try {
    const result = await apiRequest('availability');
    bookingOccupiedSlots = new Set((result.occupied || []).map(x => `${x.date}|${x.time}`));
    return true;
  } catch (err) { console.error('[VetClinic/Agenda]', err); return false; }
}

function bookingDateLabel(iso) {
  const [y,m,d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return `${BOOKING_WEEKDAYS[date.getDay()]}, ${String(d).padStart(2,'0')}/${String(m).padStart(2,'0')}`;
}

function renderBookingDates() {
  const grid = document.getElementById('booking-date-grid');
  if (!grid) return;

  const dates = getNextBookingDates();
  const rows = dates.map(date => {
    const iso = bookingISODate(date);
    const free = availableBookingSlots(iso).length;
    const disabled = free === 0;
    const selected = bookingSelectedDate === iso;
    return `<button type="button" class="booking-date-btn ${selected ? 'selected' : ''}" ${disabled ? 'disabled' : ''} onclick="selectBookingDate('${iso}')">
      <span class="booking-date-week">${BOOKING_WEEKDAYS[date.getDay()]}</span>
      <span class="booking-date-main">${String(date.getDate()).padStart(2,'0')}/${String(date.getMonth()+1).padStart(2,'0')}</span>
      <span class="booking-date-slots">${disabled ? 'Lotado' : `${free} horário${free !== 1 ? 's' : ''} livre${free !== 1 ? 's' : ''}`}</span>
    </button>`;
  });

  grid.innerHTML = rows.join('');

  if (!bookingSelectedDate) {
    const first = dates.map(bookingISODate).find(iso => availableBookingSlots(iso).length > 0);
    if (first) selectBookingDate(first, true);
  }
}

function selectBookingDate(date, rerenderDates = true) {
  bookingSelectedDate = date;
  bookingSelectedTime = '';
  if (rerenderDates) renderBookingDates();
  renderBookingTimes();
  updateBookingSummary();
}

function renderBookingTimes() {
  const grid = document.getElementById('booking-time-grid');
  if (!grid) return;

  if (!bookingSelectedDate) {
    grid.innerHTML = '<div class="booking-empty-time">Nenhuma data disponível no momento.</div>';
    return;
  }

  grid.innerHTML = getBookingTimeSlots().map(time => {
    const busy = isBookingSlotOccupied(bookingSelectedDate, time);
    const selected = bookingSelectedTime === time;
    return `<button type="button" class="booking-time-btn ${selected ? 'selected' : ''}" ${busy ? 'disabled' : ''} onclick="selectBookingTime('${time}')">
      ${time}<small>${busy ? 'Ocupado' : 'Livre'}</small>
    </button>`;
  }).join('');
}

function selectBookingTime(time) {
  if (!bookingSelectedDate || isBookingSlotOccupied(bookingSelectedDate, time)) return;
  bookingSelectedTime = time;
  renderBookingTimes();
  updateBookingSummary();
}

function updateBookingSummary() {
  const summary = document.getElementById('booking-selected-summary');
  const submit = document.getElementById('booking-submit');
  if (!summary || !submit) return;

  if (bookingSelectedDate && bookingSelectedTime) {
    summary.textContent = `${bookingDateLabel(bookingSelectedDate)} às ${bookingSelectedTime}`;
    submit.disabled = false;
  } else if (bookingSelectedDate) {
    summary.textContent = `${bookingDateLabel(bookingSelectedDate)} · escolha um horário`;
    submit.disabled = true;
  } else {
    summary.textContent = 'Selecione uma data e horário';
    submit.disabled = true;
  }
}

async function openAppointmentModal() {
  const modal = document.getElementById('booking-modal-bg');
  if (!modal) return;
  if (!dbReady || !dbOnline) return showToast('Supabase indisponível. Confira sua conexão com a internet.');

  closeServicesModal();
  bookingSelectedDate = '';
  bookingSelectedTime = '';
  modal.classList.add('open');
  updateHomeModalLock();

  const dateGrid = document.getElementById('booking-date-grid');
  const timeGrid = document.getElementById('booking-time-grid');
  if (dateGrid) dateGrid.innerHTML = '<div class="booking-loading">Consultando horários no Supabase...</div>';
  if (timeGrid) timeGrid.innerHTML = '<div class="booking-empty-time">Aguarde a disponibilidade carregar.</div>';
  updateBookingSummary();

  const ok = await refreshBookingAvailability();
  if (!ok) {
    if (dateGrid) dateGrid.innerHTML = '<div class="booking-loading">Não foi possível consultar a agenda. Confira a internet e o Supabase.</div>';
    showToast('Não foi possível consultar os horários no banco.');
    return;
  }

  renderBookingDates();
}

function closeAppointmentModal() {
  const modal = document.getElementById('booking-modal-bg');
  if (!modal) return;
  modal.classList.remove('open');
  updateHomeModalLock();
}

function clearBookingForm() {
  ['booking-tutor','booking-phone','booking-pet','booking-na','booking-message'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const service = document.getElementById('booking-service');
  if (service) service.selectedIndex = 0;
  bookingSelectedDate = '';
  bookingSelectedTime = '';
}

async function submitBookingAppointment() {
  const tutor = document.getElementById('booking-tutor').value.trim();
  const phone = document.getElementById('booking-phone').value.trim();
  const pet = document.getElementById('booking-pet').value.trim();
  const naRaw = document.getElementById('booking-na').value.trim();
  const service = document.getElementById('booking-service').value;
  const message = document.getElementById('booking-message').value.trim();
  if (!tutor || !phone || !pet || !service || !bookingSelectedDate || !bookingSelectedTime) return showToast('Preencha seus dados e escolha data e horário.');
  if (!validarTelefone(phone)) return showToast('Informe um telefone válido.');
  const na = naRaw ? parseInt(naRaw,10) : null;
  const submit = document.getElementById('booking-submit');
  if (submit) { submit.disabled=true; submit.textContent='Confirmando...'; }
  const date=bookingSelectedDate, time=bookingSelectedTime;
  try {
    await apiRequest('appointment_create', { method:'POST', body:{ tutor,phone,pet,na,service,date,time,message } });
    clearBookingForm(); closeAppointmentModal();
    if (currentSession) await refreshSecureBootstrap();
    showToast(`Agendamento enviado para ${fmtDate(date)} às ${time}.`);
  } catch (err) {
    await refreshBookingAvailability(); renderBookingDates();
    bookingSelectedTime=''; renderBookingTimes(); updateBookingSummary();
    showToast(err.message);
  } finally { if (submit) submit.textContent='Confirmar agendamento'; }
}

// Fecha as janelas pelo teclado.
document.addEventListener('keydown', function (event) {
  if (event.key === 'Escape') {
    closeServicesModal();
    closeAppointmentModal();
  }
});


// =============================================================================
// SEÇÃO 27 — INICIALIZAÇÃO DO SISTEMA
// Executado automaticamente ao carregar a página.
// Aplica o tema salvo, verifica se há sessão ativa e válida,
// e redireciona o usuário para a tela correta.
// =============================================================================
(async function init() {
  applyTheme();
  buildTimeOpts();
  const bancoConectado = await initDatabase();
  renderTestimonials();
  if (!bancoConectado) {
    setTimeout(() => showToast('Supabase indisponível. Confira sua conexão com a internet.'), 150);
    return;
  }
  if (currentSession?.role === 'doc') { enterDocApp(currentSession.user); return; }
  if (currentSession?.role === 'pat') { enterPatPortal(currentSession.user); return; }
})();
