import { evaluate } from "../src/connection.js";

// Look inside Pine editor container for buttons
const r = await evaluate("(function(){ var pe=document.querySelector('[class*=pineEditor],[class*=pine-editor],[class*=scriptEditor],[data-name=pine-editor]'); if(!pe) return 'no-pe-container'; var all=pe.querySelectorAll('button,[role=button],[class*=btn]'); var out=[]; for(var i=0;i<all.length;i++){ var el=all[i]; var t=el.textContent.trim().substring(0,50); var ti=el.getAttribute('title')||''; var dn=el.getAttribute('data-name')||''; var cl=el.className.substring(0,80); out.push('TXT:'+t+'|TI:'+ti+'|DN:'+dn+'|CLS:'+cl.substring(0,60)); } return '[CONTAINER:'+pe.tagName+'.'+pe.className.substring(0,40)+'] BTNS:'+out.length+'\n'+out.join('\n'); })()");
console.log(r);
