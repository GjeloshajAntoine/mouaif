import{d as h,aV as te,aW as ae,aX as _,h as k,be as L,bf as se,T as ne,aZ as z,bg as D,bh as P,k as e,S as B,aU as J,b0 as re,a$ as oe,a2 as N,bi as ie}from"./index-CbRXOog3.js";import{d as le}from"./themes-wQ2eG8uk.js";import"./mcp-sdk-DOnPPz21.js";import"./zod-D3xb6SHI.js";const V=[{id:"pointer-glow",label:"Pointer glow",note:"a soft light follows your finger or cursor",code:`// Pointer glow — a soft accent light that follows the pointer.
export default function setup(ctx) {
  ctx.addStyle(\`
    body::after {
      content: '';
      position: fixed;
      inset: 0;
      z-index: 2147483000;
      pointer-events: none;
      background: radial-gradient(260px circle at var(--glow-x, 50%) var(--glow-y, 40%),
        color-mix(in srgb, var(--accent) 14%, transparent), transparent 70%);
      transition: opacity .4s;
    }
  \`);
  const move = (event) => {
    ctx.setVar('--glow-x', event.clientX + 'px');
    ctx.setVar('--glow-y', event.clientY + 'px');
  };
  window.addEventListener('pointermove', move, { passive: true, signal: ctx.signal });
  window.addEventListener('pointerdown', move, { passive: true, signal: ctx.signal });
}
`},{id:"starfield",label:"Starfield",note:"slow drifting stars behind the app",code:`// Starfield — a canvas of drifting stars behind the whole app.
export default function setup(ctx) {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  Object.assign(canvas.style, {
    position: 'fixed', inset: '0', width: '100%', height: '100%',
    zIndex: '-1', pointerEvents: 'none'
  });
  // Behind #app: body and the app shell must not paint over it.
  ctx.addStyle('html { background: var(--bg); } body, .app__shell, .app__main--flush { background: transparent; }');
  document.body.prepend(canvas);
  const g = canvas.getContext('2d');
  let stars = [];
  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    stars = Array.from({ length: Math.round(innerWidth * innerHeight / 9000) }, () => ({
      x: Math.random() * innerWidth, y: Math.random() * innerHeight,
      r: Math.random() * 1.2 + 0.2, v: Math.random() * 0.03 + 0.01
    }));
  };
  resize();
  window.addEventListener('resize', resize, { signal: ctx.signal });
  const color = getComputedStyle(ctx.root).getPropertyValue('--fg').trim() || '#fff';
  const draw = (dt) => {
    g.clearRect(0, 0, innerWidth, innerHeight);
    g.fillStyle = color;
    for (const s of stars) {
      s.y -= s.v * dt;
      if (s.y < 0) { s.y = innerHeight; s.x = Math.random() * innerWidth; }
      g.globalAlpha = 0.25 + s.r * 0.35;
      g.beginPath(); g.arc(s.x, s.y, s.r, 0, Math.PI * 2); g.fill();
    }
  };
  if (ctx.reducedMotion) draw(0);
  else ctx.onFrame((now, dt) => draw(dt));
  return () => canvas.remove();
}
`},{id:"page-transitions",label:"Page transitions",note:"each screen slides and fades in",code:`// Page transitions — animate the main view on every navigation.
export default function setup(ctx) {
  let first = true;
  ctx.onRoute(() => {
    if (first) { first = false; return; }
    if (ctx.reducedMotion) return;
    // Wait one frame so the new view is in the DOM.
    requestAnimationFrame(() => {
      const main = document.querySelector('.app__main');
      if (!main) return;
      main.animate([
        { opacity: 0, transform: 'translateY(10px) scale(.99)' },
        { opacity: 1, transform: 'none' }
      ], { duration: 260, easing: 'cubic-bezier(.16,.84,.44,1)' });
    });
  });
}
`},{id:"time-of-day",label:"Time-of-day accent",note:"the accent shifts from dawn to night",code:`// Time-of-day accent — warmer in the morning, cooler at night.
export default function setup(ctx) {
  const paint = () => {
    const h = new Date().getHours() + new Date().getMinutes() / 60;
    const hue = Math.round(30 + (h / 24) * 200); // 30 (dawn) → 230 (night)
    ctx.setVar('--accent', 'hsl(' + hue + ' 85% 68%)');
    ctx.setVar('--accent-soft', 'hsl(' + hue + ' 85% 68% / .16)');
  };
  paint();
  const timer = setInterval(paint, 60 * 1000);
  return () => clearInterval(timer);
}
`}],F=`// Theme script — runs in the app page after the theme is applied.
// ctx: theme, root, app, signal, reducedMotion, route,
//      addStyle(css), setVar(name, value), onRoute(fn), onFrame(fn), onMotionChange(fn)
// Return a function to clean up anything ctx does not track for you.
export default function setup(ctx) {
}
`,M={sharp:{"--r-sm":"2px","--r-md":"3px","--r-lg":"4px"},round:{"--r-sm":"10px","--r-md":"18px","--r-lg":"24px"}},E={serif:'ui-serif, "New York", Georgia, Cambria, "Times New Roman", serif',mono:"var(--font-mono)"},Y=["--r-sm","--r-md","--r-lg","--font-sans"],$=new Set(J.map(s=>s.name)),ce=()=>({name:"My theme",base:"dark",vars:{},css:"",js:""});function H(s){const n=String(s||"").trim();return/^#[0-9a-f]{6}$/i.test(n)?n.toLowerCase():/^#[0-9a-f]{3}$/i.test(n)?("#"+n.slice(1).split("").map(t=>t+t).join("")).toLowerCase():null}function ue(s){return Object.entries(s).filter(([n])=>!$.has(n)&&!Y.includes(n)).map(([n,t])=>n+": "+t+";").join(`
`)}function de(s){const n={};let t=0;for(const u of s.split(/;|\n/)){const c=u.trim();if(!c)continue;const i=/^(--[A-Za-z0-9_-]+)\s*:\s*(.+)$/.exec(c);i&&!/[{}<>]/.test(i[2])?n[i[1]]=i[2].trim():t+=1}return{vars:n,bad:t}}function W(s){return s["--r-md"]===M.sharp["--r-md"]?"sharp":s["--r-md"]===M.round["--r-md"]?"round":s["--r-md"]?"custom":"default"}function U(s){const n=s["--font-sans"];return n?n===E.mono?"mono":n===E.serif?"serif":"custom":"system"}function C({name:s,label:n,value:t,options:u,onChange:c}){return e("div",{class:"row"},e("span",{class:"label"},n),e("div",{class:"seg",role:"radiogroup","aria-label":n},u.map(([i,x])=>e("label",{key:i,class:"seg__item"+(t===i?" seg__item--on":"")},e("input",{type:"radio",name:s,value:i,checked:t===i,onChange:()=>c(i)}),e("span",{class:"seg__pill"},x)))))}function me({token:s,value:n,onChange:t}){const u=H(n)||H(s.value)||"#000000",c="theme-token-"+s.name.slice(2);return e("div",{class:"theme-color"},e("input",{type:"color",class:"theme-color__swatch",value:u,"aria-label":s.label+" colour picker",onInput:i=>t(i.currentTarget.value)}),e("label",{class:"theme-color__label",for:c},e("span",null,s.label),e("code",null,s.name)),e("input",{id:c,class:"input theme-color__value",value:n||"",placeholder:s.value,autocapitalize:"off",spellcheck:!1,onInput:i=>t(i.currentTarget.value)}),n?e("button",{type:"button",class:"btn btn--ghost theme-color__reset","aria-label":"Reset "+s.label,onClick:()=>t("")},"×"):null)}function ge({id:s="",from:n=""}){const[t,u]=h(null),[c,i]=h(""),[x,O]=h(""),[S,K]=h(0),[g,m]=h({text:"",kind:""}),[b,w]=h(!1),d=!s,X=te.value.active||ae,y=!d&&X===s,j=_.value&&_.value.themeId===s?_.value:null;k(()=>{let a=!1;async function r(){let o;try{if(s){const l=await L(s);o={name:l.name,base:l.base,vars:l.vars||{},css:l.css||"",js:l.js||""}}else if(n){const v=se(n)||await L(n);o={name:v.name+" copy",base:v.base,vars:{...v.vars||{}},css:v.css||"",js:v.js||""}}else o=ce()}catch(l){a||m({text:"Could not load the theme: "+l.message,kind:"error"});return}a||(u(o),i(s?JSON.stringify(o):""),O(ue(o.vars)))}return r(),()=>{a=!0}},[s,n]);const p=ne(()=>!!t&&JSON.stringify(t)!==c,[t,c]);if(k(()=>{if(!t||z)return;if(!p&&y){D();return}const a=setTimeout(()=>P({id:s||"draft",name:t.name,base:t.base,vars:t.vars,css:t.css}),120);return()=>clearTimeout(a)},[t&&t.base,t&&t.vars,t&&t.css,p,y]),k(()=>()=>D(),[]),!t)return e(B,null,e("div",{class:"view-head"},e("a",{href:"#/settings/themes",class:"view-back","aria-label":"Back to themes"},"←"),e("h2",{class:"view-title"},"Theme")),e("p",{class:"status","data-state":g.kind,"aria-live":"polite"},g.text||"Loading…"));const f=a=>u(r=>({...r,...a})),T=a=>u(r=>({...r,vars:a({...r.vars})})),R=(a,r)=>T(o=>(r&&r.trim()?o[a]=r.trim():delete o[a],o));function q(a){T(r=>{for(const o of["--r-sm","--r-md","--r-lg"])delete r[o];return Object.assign(r,M[a]||{})})}function G(a){R("--font-sans",E[a]||"")}function Z(a){O(a);const r=de(a);K(r.bad),T(o=>{for(const l of Object.keys(o))!$.has(l)&&!Y.includes(l)&&delete o[l];return Object.assign(o,r.vars)})}function Q(a){const r=a==="template"?{code:F}:V.find(o=>o.id===a);r&&(t.js.trim()&&!window.confirm("Replace the current script with this example?")||f({js:r.code}))}async function I({use:a=!1}={}){if(!t.name.trim()){m({text:"Give the theme a name.",kind:"error"});return}w(!0),m({text:"Saving…",kind:"busy"});try{const r=await re(s,t);i(JSON.stringify(t)),a&&await oe(r.id);const o=a||y;m({text:o?"Saved and in use.":"Saved.",kind:"success"}),o||P({id:r.id,name:t.name,base:t.base,vars:t.vars,css:t.css}),d&&N("settings/themes/"+encodeURIComponent(r.id))}catch(r){m({text:"Save failed: "+r.message,kind:"error"})}w(!1)}async function ee(){if(window.confirm('Delete the theme "'+t.name+'"?')){w(!0);try{await ie(s),N("settings/themes")}catch(a){m({text:"Delete failed: "+a.message,kind:"error"}),w(!1)}}}const A=new Blob([t.js]).size;return e(B,null,e("div",{class:"view-head"},e("a",{href:"#/settings/themes",class:"view-back","aria-label":"Back to themes"},"←"),e("h2",{class:"view-title"},d?"New theme":t.name||"Theme")),e("section",{class:"settings-theme-edit"},e("p",{class:"hint hint--compact"},z?"Safe mode is on, so this page does not preview the theme.":"The app around you previews the colours and CSS as you type. The script runs when the theme is saved and in use."),e("div",{class:"group"},e("div",{class:"group__title"},"Theme"),e("div",{class:"row"},e("label",{class:"label",for:"theme-name"},"Name"),e("input",{id:"theme-name",class:"input",value:t.name,maxLength:60,onInput:a=>f({name:a.currentTarget.value})})),e(C,{name:"theme-base",label:"Base",value:t.base,options:[["dark","Dark"],["light","Light"]],onChange:a=>f({base:a})}),e(C,{name:"theme-radius",label:"Corners",value:W(t.vars),options:[["sharp","Sharp"],["default","Default"],["round","Round"]].concat(W(t.vars)==="custom"?[["custom","Custom"]]:[]),onChange:q}),e(C,{name:"theme-font",label:"Type",value:U(t.vars),options:[["system","System"],["serif","Serif"],["mono","Mono"]].concat(U(t.vars)==="custom"?[["custom","Custom"]]:[]),onChange:G})),e("div",{class:"group"},e("div",{class:"group__title"},"Colours",e("span",{class:"group__title-note"},"empty = default")),e("div",{class:"theme-colors"},J.map(a=>e(me,{key:a.name,token:a,value:t.vars[a.name]||"",onChange:r=>R(a.name,r)}))),e("div",{class:"row"},e("label",{class:"label",for:"theme-other"},"More tokens"),e("textarea",{id:"theme-other",class:"input theme-code",rows:4,value:x,spellcheck:!1,autocapitalize:"off",placeholder:`--accent-soft: rgba(110, 168, 254, .16);
--shadow-md: 0 4px 16px rgba(0,0,0,.35);`,onInput:a=>Z(a.currentTarget.value)}),e("p",{class:"hint hint--compact"+(S?" theme-warn":"")},S?S+' line(s) are not "--name: value" and are ignored.':'Any design token from base.css, one "--name: value;" per line. Soft tints and press shades follow the main colours unless set here.'))),e("div",{class:"group"},e("div",{class:"group__title"},"CSS"),e("div",{class:"row"},e("textarea",{class:"input theme-code",rows:8,value:t.css,spellcheck:!1,autocapitalize:"off","aria-label":"Theme CSS",placeholder:`.chat-view__bubble { backdrop-filter: blur(8px); }
@keyframes pulse { … }`,onInput:a=>f({css:a.currentTarget.value})}),e("p",{class:"hint hint--compact"},"Loaded after the app styles. Use it for anything tokens cannot reach: backgrounds, keyframes, per-component tweaks."))),e("div",{class:"group"},e("div",{class:"group__title"},"JavaScript",e("span",{class:"group__title-note"},A?Math.ceil(A/1024)+" KB":"optional")),j?e("p",{class:"status","data-state":"error",role:"alert"},"Script error: "+j.message):null,e("div",{class:"row"},e("label",{class:"label",for:"theme-example"},"Start from"),e("select",{id:"theme-example",class:"input",value:"",onChange:a=>{Q(a.currentTarget.value),a.currentTarget.value=""}},e("option",{value:""},"Insert an example…"),e("option",{value:"template"},"Empty template"),V.map(a=>e("option",{key:a.id,value:a.id},a.label+" — "+a.note)))),e("div",{class:"row"},e("textarea",{class:"input theme-code theme-code--js",rows:14,value:t.js,spellcheck:!1,autocapitalize:"off","aria-label":"Theme JavaScript",placeholder:F,onInput:a=>f({js:a.currentTarget.value})}),e("p",{class:"hint hint--compact"},"An ES module: ",e("code",null,"export default function setup(ctx)"),". ctx gives you addStyle, setVar, onRoute, onFrame, signal and reducedMotion, and undoes them when the theme changes. Return a function to clean up anything else."),e("p",{class:"hint hint--compact theme-warn"},"The script runs inside mouaif with full access to your chats and settings. Only use code you wrote or trust."))),e("div",{class:"settings-theme-edit__bar"},e("button",{type:"button",class:"btn btn--primary",disabled:b||!p&&!d,onClick:()=>I()},"Save"),y?null:e("button",{type:"button",class:"btn",disabled:b,onClick:()=>I({use:!0})},p||d?"Save & use":"Use"),e("button",{type:"button",class:"btn",disabled:b,onClick:()=>le(t)},"Export"),d?null:e("button",{type:"button",class:"btn btn--danger",disabled:b,onClick:ee},"Delete")),e("p",{class:"status","data-state":g.kind,"aria-live":"polite"},g.text||(p&&!d?"Unsaved changes.":""))))}export{ge as SettingsThemeEditView};
