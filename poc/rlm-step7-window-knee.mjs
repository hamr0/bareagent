// Knee calibration + silent-under-recall DETECTOR validation, in one run.
//  (1) recall/precision/err/cost vs window → where does recall plateau (the default) and where does it collapse.
//  (2) per window, FRONT-half vs BACK-half recall (ground-truthed). If back<<front and the gap grows with window,
//      "tail truncation" is the mechanism AND front-loaded returned IDs are a runtime symptom of under-recall.
import { Loop } from '../src/loop.js';
import { OpenAIProvider } from '../src/provider-openai.js';
import { readFileSync } from 'node:fs';
const LABELS={1:'World',2:'Sports',3:'Business',4:'Sci/Tech'}, TARGET=2;
const provider=new OpenAIProvider({apiKey:process.env.OPENAI_API_KEY,model:'gpt-4o-mini'});
function parse(t){const o=[];for(const l of t.split('\n')){const s=l.trim();if(!s)continue;const p=s.replace(/^"/,'').replace(/"$/,'').split('","');if(p.length!==3||!LABELS[+p[0]])continue;o.push({cls:+p[0],text:`${p[1]}. ${p[2]}`.replace(/\s+/g,' ').trim()});}return o;}
const SAMPLE=Number(process.env.SAMPLE||250);
// Fetch once: curl -sL https://raw.githubusercontent.com/mhjabreel/CharCnn_Keras/master/data/ag_news_csv/test.csv -o agnews.csv
const CSV=process.env.AGNEWS_CSV||process.argv[2]||'agnews.csv';
const recs=parse(readFileSync(CSV,'utf8')).slice(0,SAMPLE).map((r,i)=>({id:`rec:${i}`,cls:r.cls,text:r.text}));
const labelOf=new Map(recs.map(r=>[r.id,r.cls])); const truth=recs.filter(r=>r.cls===TARGET).length;
let N=0;
async function judge(records){
  const shown=new Set(records.map(r=>r.id));
  const sys='You are a precise news classifier. Examine EACH item individually. Output ONLY the IDs (the "rec:N" tokens) of items that are SPORTS news (games, athletes, teams, leagues, matches, tournaments, scores). Comma-separated. If none, output "none". No count, no prose.';
  const body=records.map(r=>`${r.id}: ${r.text}`).join('\n');
  const out=await new Loop({provider,system:sys,throwOnError:false}).run([{role:'user',content:`[run ${N++}] Find the SPORTS news items.\n\nITEMS:\n${body}\n\nReply with ONLY the comma-separated matching rec: IDs (or "none").`}],[]);
  return new Set(((out.text||'').match(/rec:\d+/g)||[]).filter(id=>shown.has(id)));
}
console.log(`SAMPLE=${SAMPLE} truth=${truth} Sports | window: recall/prec/err  calls | FRONT vs BACK half recall (detector)`);
for(const W of [4,6,8,12,20,40]){
  const got=new Set(); let calls=0;
  let frontT=0,frontHit=0,backT=0,backHit=0;  // ground-truthed positional recall
  let retFront=0,retBack=0;                    // positions of RETURNED hits (runtime-observable, no truth)
  for(let i=0;i<recs.length;i+=W){
    const slice=recs.slice(i,i+W); calls++;
    const hit=await judge(slice);
    for(const id of hit) got.add(id);
    slice.forEach((r,j)=>{
      const isFront=j < slice.length/2;
      if(r.cls===TARGET){ if(isFront){frontT++; if(hit.has(r.id))frontHit++;} else {backT++; if(hit.has(r.id))backHit++;} }
      if(hit.has(r.id)){ if(isFront)retFront++; else retBack++; }
    });
  }
  let tp=0; for(const id of got) if(labelOf.get(id)===TARGET) tp++;
  const rf=frontT?frontHit/frontT:0, rb=backT?backHit/backT:0;
  const skew=(retFront+retBack)? retFront/(retFront+retBack):0;  // >0.5 = returned hits front-loaded (symptom)
  console.log(`  W=${String(W).padEnd(2)} rec=${(tp/truth).toFixed(2)} prec=${(got.size?tp/got.size:0).toFixed(2)} err=${String(Math.round(100*Math.abs(got.size-truth)/truth)).padStart(2)}% calls=${String(calls).padStart(3)} | front-rec=${rf.toFixed(2)} back-rec=${rb.toFixed(2)} gap=${(rf-rb).toFixed(2)} | returned-front-share=${skew.toFixed(2)}`);
}
