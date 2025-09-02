/*
  voygen-feedback.js
  Lightweight engagement + analytics helpers for itinerary/proposal pages.
  Assumes the template provides:
   - <body data-trip-filename data-trip-title>
   - Sections with .vf-section and stable id + [data-section-id][data-section-title]
   - Buttons with .vf-ask[data-action="ask"] inside section headers
   - Sticky contact bar .vf-contact-bar (anchors just work; we only log)
   - Exit modal skeleton: .vf-backdrop[data-exit-modal] containing .vf-chips buttons
  Optional SITE_CONFIG (set in head) to control features and endpoints.
*/
(function(){
  const CFG = normalizeConfig(window.SITE_CONFIG || {});
  const STATE = { sessionId: getOrCreateSessionId(), maxScroll: 0, scrollMilestones: new Set(), sectionTimers: new Map(), exitShown: false, selectedChip: null };

  onReady(init);

  function init(){
    if(CFG.analytics.provider){ sendEvent('page_view'); }
    // Wire ask buttons
    if(CFG.features.askButtons){
      delegate(document, 'click', '.vf-ask[data-action="ask"]', onAskClick);
    }
    ensureAskModal();
    // Prefill schedule links with stored identity
    try{ updateScheduleLinks(); }catch(_){ }
    // Diagnostics in local/dev or ?debug=1
    try{ insertDiagnosticsIfDev(); }catch(_){ }
    // Section analytics
    observeSections();
    // Scroll depth
    window.addEventListener('scroll', onScrollDepth, {passive:true});
    onScrollDepth();
    // Exit intent
    if(CFG.features.exitIntent){ setupExitIntent(); }
    // Chat provider
    if(CFG.chat.enabled){ injectChat(CFG.chat); }
  }

  /* ---------------- Config ---------------- */
  function normalizeConfig(raw){
    const def = {
      agent:{phone:'',sms:'',email:'',messengerUrl:'',scheduleUrl:''},
      cpmaxx:{authLink:'#'},
      forms:{provider:'auto', questionEndpoint:'', feedbackEndpoint:''},
      analytics:{provider:'plausible', domain: location.hostname},
      chat:{enabled:false, provider:'crisp', websiteId:''},
      features:{exitIntent:true, askButtons:true, contactBar:true, nextSteps:true}
    };
    return deepMerge(def, raw);
  }

  function deepMerge(a,b){ const out = {...a}; for(const k in b){ if(b[k] && typeof b[k]==='object' && !Array.isArray(b[k])) out[k]=deepMerge(a[k]||{}, b[k]); else out[k]=b[k]; } return out; }

  /* ---------------- Session + Events ---------------- */
  function getOrCreateSessionId(){ try{ const key='vf_sid'; let id=localStorage.getItem(key); if(!id){ id = (crypto.randomUUID && crypto.randomUUID()) || (Date.now().toString(36)+Math.random().toString(36).slice(2,10)); localStorage.setItem(key, id); } return id; }catch(_){ return Date.now().toString(36)+Math.random().toString(36).slice(2,10);} }
  function tripFilename(){ const b=document.body; return b?.dataset?.tripFilename || (document.querySelector('meta[name="trip:filename"]')?.content) || location.pathname.split('/').pop(); }

  function sendEvent(type, props={}){
    const envelope = {
      sessionId: STATE.sessionId,
      page: location.pathname,
      tripFilename: tripFilename(),
      ts: new Date().toISOString(),
      ...props
    };
    if(window.plausible){ try{ window.plausible(type, { props: envelope }); }catch(e){} }
    // Future: POST to Worker if configured (kept no-op for static hosting)
    if(!window.plausible){
      if (console && console.debug) console.debug('[vf]', type, envelope);
    }
  }

  /* ---------------- Section Analytics ---------------- */
  function observeSections(){
    const sections = document.querySelectorAll('.vf-section');
    if(!sections.length) return;
    const threshold = 0.5;
    const observer = new IntersectionObserver((entries)=>{
      entries.forEach(entry=>{
        const el = entry.target;
        const id = el.getAttribute('data-section-id') || el.id || '';
        const title = el.getAttribute('data-section-title') || (el.querySelector('h2,h3')?.textContent || '').trim();
        const key = id || title;
        if(entry.isIntersecting && entry.intersectionRatio >= threshold){
          // Start timer; log after dwell
          if(!STATE.sectionTimers.has(key)){
            const t = setTimeout(()=>{
              sendEvent('section_view', { sectionId:id, title });
              STATE.sectionTimers.delete(key);
            }, 800);
            STATE.sectionTimers.set(key, t);
          }
        } else {
          // Leaving: clear timer if not yet fired
          const t = STATE.sectionTimers.get(key);
          if(t){ clearTimeout(t); STATE.sectionTimers.delete(key); }
        }
      });
    }, {threshold:[threshold]});
    sections.forEach(s=>observer.observe(s));
  }

  /* ---------------- Scroll Depth ---------------- */
  function onScrollDepth(){
    const h = document.documentElement;
    const scrollTop = (window.pageYOffset || h.scrollTop) - (h.clientTop || 0);
    const docH = Math.max(h.scrollHeight, document.body.scrollHeight);
    const winH = window.innerHeight || h.clientHeight;
    const max = Math.min(100, Math.round(((scrollTop + winH) / docH) * 100));
    if(max <= STATE.maxScroll) return;
    STATE.maxScroll = max;
    [25,50,75,100].forEach(mark=>{
      if(max >= mark && !STATE.scrollMilestones.has(mark)){
        STATE.scrollMilestones.add(mark);
        sendEvent('scroll_depth', { pct: mark, maxPct: STATE.maxScroll });
      }
    });
  }

  /* ---------------- Ask Flow ---------------- */
  function onAskClick(e){
    try{ e.preventDefault(); }catch(_){ }
    const btn = this || e.currentTarget;
    if(!btn || !btn.closest){ return; }
    const sec = btn.closest('.vf-section');
    const sectionId = (sec?.getAttribute('data-section-id')) || (sec?.id) || '';
    const title = (sec?.getAttribute('data-section-title')) || (sec?.querySelector('h2,h3')?.textContent || '').trim();
    const page = location.href.split('#')[0];
    const anchor = sectionId ? `#${sectionId}` : '';

    sendEvent('click', { action:'ask_question', sectionId, label:title });

    const payload = {
      type: 'question',
      tripFilename: tripFilename(),
      sectionId, title,
      pageUrl: page + anchor
    };
    // Ensure modal exists; if not, create then open; fallback to prompt
    try{ ensureAskModal(); }catch(_){ }
    if(!openAskModal(payload)){
      askViaPrompt(payload);
    }
  }

  function fallbackMailto(payload){
    const subj = encodeURIComponent(`Question about ${payload.title || 'this section'} — ${payload.tripFilename}`);
    const body = encodeURIComponent(`Hi, I have a question about:\n${payload.title}\n${payload.pageUrl}\n\nDetails:`);
    const mail = (CFG.agent.email || 'info@example.com');
    window.location.href = `mailto:${mail}?subject=${subj}&body=${body}`;
  }

  /* ---------------- Exit Intent ---------------- */
  function setupExitIntent(){
    try{ STATE.exitShown = !!sessionStorage.getItem('vf_exit_shown'); }catch(_){ STATE.exitShown = false; }
    const modal = document.querySelector('.vf-backdrop[data-exit-modal]');
    if(!modal) return;

    // Chip selection
    delegate(modal, 'click', '.vf-chips button', (ev)=>{
      STATE.selectedChip = ev.currentTarget.getAttribute('data-value') || null;
      modal.querySelectorAll('.vf-chips button').forEach(b=>b.classList.toggle('is-selected', b===ev.currentTarget));
    });
    // Actions
    delegate(modal, 'click', '[data-action="send_feedback"]', ()=>{
      const note = modal.querySelector('textarea')?.value || '';
      const subject = `[Exit feedback] ${tripFilename()}`;
      const payload = { type:'exit_feedback', choice: STATE.selectedChip, note, pageUrl: location.href, tripFilename: tripFilename(), ttcMs: Math.max(0, Date.now() - (STATE.startTs||Date.now())), hp:'', _subject: subject };
      sendEvent('click', { action:'send_feedback', label:STATE.selectedChip||'none' });
      if(CFG.forms.feedbackEndpoint){ sendToForms('feedback', payload).catch(()=>{}); }
      hideExit(modal);
      showToast('Thanks for the feedback!');
    });
    delegate(modal, 'click', '[data-action="dismiss"]', ()=>{ hideExit(modal); });

    // Trigger on top mouseleave (desktop) and on rapid scroll to top
    document.addEventListener('mouseleave', (ev)=>{
      if(ev.clientY <= 0) maybeShowExit(modal);
    });
    window.addEventListener('beforeunload', ()=>{ try{ sessionStorage.setItem('vf_exit_shown','1'); }catch(_){} });
  }
  function maybeShowExit(modal){ if(STATE.exitShown) return; STATE.exitShown=true; try{ sessionStorage.setItem('vf_exit_shown','1'); }catch(_){} showExit(modal); }
  function showExit(modal){ modal.hidden=false; modal.style.display='flex'; }
  function hideExit(modal){ modal.hidden=true; modal.style.display='none'; }

  /* ---------------- Chat ---------------- */
  function injectChat(chat){
    if(chat.provider==='crisp' && chat.websiteId){
      window.$crisp=[]; window.CRISP_WEBSITE_ID=chat.websiteId;
      const s=document.createElement('script'); s.src='https://client.crisp.chat/l.js'; s.async=1; document.head.appendChild(s);
    }
    // Add other providers as needed
  }

  /* ---------------- Helpers ---------------- */
  function onReady(fn){ if(document.readyState==='loading'){ document.addEventListener('DOMContentLoaded', fn, {once:true}); } else { fn(); } }
  function delegate(root, type, sel, handler){ root.addEventListener(type, function(ev){ const t=ev.target.closest(sel); if(t && root.contains(t)){ handler.call(t, ev); } }, true); }
  function postJson(url, data){ return fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(data) }).then(r=>{ if(!r.ok) throw new Error('HTTP '+r.status); return r.json().catch(()=>({ok:true})); }); }
  function postFormData(url, data){ const fd=new FormData(); Object.entries(data||{}).forEach(([k,v])=> fd.append(k, typeof v==='object'? JSON.stringify(v): String(v??''))); return fetch(url, { method:'POST', body: fd, headers:{'Accept':'application/json'} }).then(r=>{ if(!r.ok) throw new Error('HTTP '+r.status); return r.text(); }); }
  function sendToForms(kind, payload){ const url = kind==='feedback' ? CFG.forms.feedbackEndpoint : CFG.forms.questionEndpoint; const provider = (CFG.forms.provider||'auto').toLowerCase(); if(provider==='formspree'){ return postFormData(url, payload); } return postJson(url, payload); }

  function showToast(msg){
    let t = document.querySelector('.vf-toast');
    if(!t){ t=document.createElement('div'); t.className='vf-toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(()=> t.classList.remove('show'), 2200);
  }

  /* ---------------- Ask Modal ---------------- */
  function ensureAskModal(){
    if(document.querySelector('[data-ask-modal]')) return;
    const wrap = document.createElement('div');
    wrap.className = 'vf-backdrop';
    wrap.setAttribute('data-ask-modal','');
    wrap.hidden = true;
    wrap.innerHTML = `
      <div class="vf-modal" role="dialog" aria-modal="true" aria-labelledby="vf-ask-title">
        <h3 id="vf-ask-title">Ask a quick question</h3>
        <p class="vf-note" data-vf-ask-context></p>
        <div class="vf-form">
          <label class="vf-label">Your name (optional)
            <input class="vf-input" type="text" data-ask-name>
          </label>
          <label class="vf-label">Your email (optional, for reply)
            <input class="vf-input" type="email" data-ask-email placeholder="you@example.com">
          </label>
          <label class="vf-label">Question
            <textarea class="vf-input" rows="4" data-ask-message placeholder="Type your question…" required></textarea>
          </label>
        </div>
        <div class="vf-actions">
          <button class="vf-secondary" data-action="ask_cancel">Cancel</button>
          <button class="vf-primary" data-action="ask_send">Send</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    delegate(wrap, 'click', '[data-action="ask_cancel"]', ()=> hideAskModal());
    delegate(wrap, 'click', '[data-action="ask_send"]', ()=> submitAskModal());
    // Live persistence while typing
    delegate(wrap, 'input', '[data-ask-name]', (ev)=>{ try{ localStorage.setItem('vf_name', ev.target.value||''); }catch(_){} updateScheduleLinks(); });
    delegate(wrap, 'input', '[data-ask-email]', (ev)=>{ try{ localStorage.setItem('vf_email', ev.target.value||''); }catch(_){} updateScheduleLinks(); });
  }

  function openAskModal(ctx){
    STATE.askCtx = ctx;
    const modal = document.querySelector('[data-ask-modal]');
    if(!modal) return false;
    const p = modal.querySelector('[data-vf-ask-context]');
    const title = ctx?.title || 'this section';
    p.textContent = `About: ${title}`;
    modal.hidden = false; modal.style.display='flex';
    const msg = modal.querySelector('[data-ask-message]');
    if(msg){ msg.value = ''; msg.focus(); }
    const sendBtn = modal.querySelector('[data-action="ask_send"]');
    if(sendBtn){ sendBtn.disabled = true; setTimeout(()=>{ sendBtn.disabled = false; }, 1500); }
    // Prefill name/email from localStorage
    try{
      const name = localStorage.getItem('vf_name') || '';
      const email = localStorage.getItem('vf_email') || '';
      const nameEl = modal.querySelector('[data-ask-name]');
      const emailEl = modal.querySelector('[data-ask-email]');
      if(nameEl && !nameEl.value) nameEl.value = name;
      if(emailEl && !emailEl.value) emailEl.value = email;
    }catch(_){ }
    return true;
  }
  function hideAskModal(){ const modal=document.querySelector('[data-ask-modal]'); if(!modal) return; modal.hidden=true; modal.style.display='none'; }
  function validEmail(v){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v||''); }
  function updateScheduleLinks(){
    try{
      const name = (localStorage.getItem('vf_name')||'').trim();
      const email = (localStorage.getItem('vf_email')||'').trim();
      const notes = `Trip:${tripFilename()}`;
      const links = document.querySelectorAll('a[data-action="schedule_open"]');
      links.forEach(a=>{
        try{
          const base = a.getAttribute('href') || CFG.agent.scheduleUrl || '#';
          const u = new URL(base, location.origin);
          if(name) u.searchParams.set('name', name);
          if(email && validEmail(email)) u.searchParams.set('email', email);
          u.searchParams.set('notes', notes);
          a.setAttribute('href', u.toString());
        }catch(_){ }
      });
    }catch(_){ }
  }

  /* ---------------- Diagnostics (Dev) ---------------- */
  function isDev(){
    const h = location.hostname || '';
    const qp = new URLSearchParams(location.search||'');
    return h==='localhost' || h.startsWith('127.') || qp.get('debug')==='1';
  }
  function insertDiagnosticsIfDev(){
    if(!isDev()) return;
    if(document.querySelector('.vf-diagnostics-btn')) return;
    if(!CFG.forms.questionEndpoint && !CFG.forms.feedbackEndpoint) return;
    const btn = document.createElement('button');
    btn.className='vf-diagnostics-btn';
    btn.type='button';
    btn.textContent='Diagnostics';
    btn.title='Send test submissions to Formspree';
    btn.addEventListener('click', runDiagnostics);
    document.body.appendChild(btn);
  }
  async function runDiagnostics(){
    const name = (localStorage.getItem('vf_name')||'Dev Tester').trim();
    const email = (localStorage.getItem('vf_email')||'devtester@example.com').trim();
    const base = { tripFilename: tripFilename(), sectionId: 'diagnostics', title: 'Diagnostics', pageUrl: location.href };
    const results = [];
    try{
      if(CFG.forms.questionEndpoint){
        const p = { ...base, type:'question', name, email, message:'Diagnostics: question test' };
        await sendToForms('question', p);
        results.push('Question: OK');
      }
      if(CFG.forms.feedbackEndpoint){
        const p2 = { ...base, type:'exit_feedback', choice:'looking', note:'Diagnostics: feedback test' };
        await sendToForms('feedback', p2);
        results.push('Feedback: OK');
      }
      alert(results.join('\n') || 'No endpoints configured');
    }catch(err){
      console.error('[vf] diagnostics error', err);
      alert('Diagnostics failed: '+(err && err.message || err));
    }
  }
  function submitAskModal(){
    const modal=document.querySelector('[data-ask-modal]');
    if(!modal) return;
    const name = modal.querySelector('[data-ask-name]')?.value?.trim() || '';
    const email = modal.querySelector('[data-ask-email]')?.value?.trim() || '';
    const message = modal.querySelector('[data-ask-message]')?.value?.trim() || '';
    if(!message || message.length < 3){ alert('Please enter a brief question.'); return; }
    if(email && !validEmail(email)){ alert('Please enter a valid email or leave it blank.'); return; }
    // Persist identity for future sessions
    try{ if(name) localStorage.setItem('vf_name', name); if(email) localStorage.setItem('vf_email', email); }catch(_){ }
    updateScheduleLinks();
    const title = (STATE.askCtx && STATE.askCtx.title) || 'this section';
    const subject = `[Question] ${tripFilename()} — ${title}`;
    const ttcMs = Math.max(0, Date.now() - (STATE.startTs||Date.now()));
    const payload = { ...(STATE.askCtx||{}), name, email, message, ttcMs, hp:'', _subject: subject };
    if(CFG.forms.questionEndpoint){
      sendToForms('question', payload)
        .then(()=> { hideAskModal(); showToast('Sent! We will reply soon.'); })
        .catch(()=> { hideAskModal(); fallbackMailto(payload); });
    } else {
      hideAskModal();
      fallbackMailto(payload);
    }
  }

  function askViaPrompt(payload){
    let msg = '';
    try{ msg = prompt('What would you like to ask about this section?') || ''; }catch(_){}
    if(!msg) return; // user canceled
    const quick = { ...payload, message: String(msg).slice(0,1000) };
    if(CFG.forms.questionEndpoint){
      sendToForms('question', { ...quick, _subject: `[Question] ${tripFilename()} — ${quick.title||'this section'}` })
        .then(()=> showToast('Sent! We will reply soon.'))
        .catch(()=> fallbackMailto(quick));
    } else {
      fallbackMailto(quick);
    }
  }
})();
