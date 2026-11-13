import {semanticNode} from './decision-core.js?v=0.9.5';

// Preserve current requirements, options, answers and every user message in full.
// Old AI prose, duplicate source copies, answer history and canvas layout remain
// in the saved project, but are not resent with every review.
export function reviewDecisionContext(item){
 const keys=['id','nodeIds','type','status','question','reason','options','answer','evidence','blocking','deferred','deferReason','relatedIds','changedReason','recommendation','resolution'];
 return Object.fromEntries(keys.filter(key=>item[key]!==undefined).map(key=>[key,item[key]]));
}
export function reviewPlanContext(plan){
 return {rootId:plan.rootId,nodes:plan.nodes.map(semanticNode),edges:plan.edges,messages:plan.messages.filter(m=>m.author==='user'),questionsAndDecisions:plan.items.map(reviewDecisionContext)};
}
