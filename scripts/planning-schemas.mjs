const text={type:'string'},id={type:'string'},nullable={type:['string','null']},strings={type:'array',items:text};
const obj=properties=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
const arr=items=>({type:'array',items});
export const PLANNING_DRAFT_SCHEMA=obj({summary:text,nodes:arr(obj({id,parentId:nullable,title:text,description:text,instructions:text,criteria:text,nodeType:{type:'string',enum:['task','group']},dependsOn:strings,functionSteps:strings,reason:text})),defaults:arr(obj({question:text,answer:text,reason:text,alternatives:strings,nodeIds:strings})),deferred:arr(obj({id,title:text,description:text,benefit:text,reason:text,difficulty:text,conditions:text,parentId:nullable,dependsOn:strings,required:{type:'boolean'}})),promotions:arr(obj({backlogId:id,nodeIds:strings,reason:text}))});
export const PLANNING_CRITIQUE_SCHEMA=obj({summary:text,strengths:strings,risks:strings,changes:strings});
export const PLANNING_SCHEMAS={'planning-draft':PLANNING_DRAFT_SCHEMA,'planning-refine':PLANNING_DRAFT_SCHEMA,'planning-critique':PLANNING_CRITIQUE_SCHEMA};
