// Preserve the user's reading position across status-only refreshes.
export function captureView(root){
 const selectors=['.execution-tree-scroll','.execution-inspector','.dev-table-scroll','.graph-viewport'];
 const scroll=selectors.flatMap(selector=>[...root.querySelectorAll(selector)].map((el,index)=>({selector,index,top:el.scrollTop,left:el.scrollLeft})));
 const details=[...root.querySelectorAll('details[data-detail],details[data-map-fold]')].map(el=>({key:el.dataset.detail||el.dataset.mapFold,map:!!el.dataset.mapFold,open:el.open}));
 const focused=root.contains(document.activeElement)?document.activeElement:null;
 return {scroll,details,focus:focused?{...focused.dataset}:null,windowY:window.scrollY,windowX:window.scrollX};
}
export function restoreView(root,saved){
 if(!saved)return;
 for(const item of saved.details||[]){const el=[...root.querySelectorAll(item.map?'[data-map-fold]':'[data-detail]')].find(el=>(item.map?el.dataset.mapFold:el.dataset.detail)===item.key);if(el)el.open=item.open;}
 for(const item of saved.scroll||[]){const el=root.querySelectorAll(item.selector)[item.index];if(el){el.scrollTop=item.top;el.scrollLeft=item.left;}}
 if(saved.focus&&Object.keys(saved.focus).length){const el=[...root.querySelectorAll('button,summary,input,select')].find(el=>Object.entries(saved.focus).every(([k,v])=>el.dataset[k]===v));el?.focus({preventScroll:true});}
 if(window.scrollY!==saved.windowY||window.scrollX!==saved.windowX)window.scrollTo(saved.windowX,saved.windowY);
}
export function replaceView(root,html){const saved=captureView(root);root.innerHTML=html;restoreView(root,saved);}
export function defaultCollapsed(plan){
 if(!plan)return new Set();const depth=new Map([[plan.rootId,0]]),queue=[plan.rootId];
 for(let i=0;i<queue.length;i++)for(const edge of plan.edges.filter(e=>e.from===queue[i]))if(!depth.has(edge.to)){depth.set(edge.to,depth.get(edge.from)+1);queue.push(edge.to);}
 return new Set(plan.nodes.filter(n=>(depth.get(n.id)??0)>=2&&plan.edges.some(e=>e.from===n.id)).map(n=>n.id));
}
