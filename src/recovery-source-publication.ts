import ts from 'typescript';
import {credentialMatches,scrubCredentials} from './agent-runtime.js';
import type {GitHubBroker} from './github-broker.js';
export interface RepairPublication {files:Record<string,string|null>;modes?:Record<string,string>;message:string;review:'PASS';checksPassed:boolean}
import {scanSourcePackage,SourceScanFindings} from './gitleaks.js';

const PRIVATE_LIMIT=4*1024*1024;
const sensitiveName=/(?:token|key|secret|password)$/i;
const CREDENTIAL_REFUSAL='Repair contains credential-shaped text; retain it privately';

/**
 * The submitted publication itself is refused. The same bytes are refused
 * again on every retry, so the caller ends the task instead of retrying.
 */
export class RepairRefusal extends Error {}
/** The base sources could not be read now. A later attempt may succeed. */
export class RepairBaseUnavailable extends Error {}

function refuseCredentials(text:string):void {
 if(scrubCredentials(text)!==text) throw new RepairRefusal(CREDENTIAL_REFUSAL);
}

/**
 * Which lines of `source` the repair adds or changes, relative to the same
 * path at the repair's base revision. A line counts as unchanged only while
 * the base still holds an unused copy of exactly that line, so its bytes are
 * already in the repository. No base (a new file, or none supplied) means
 * every line is new.
 */
function changedLines(source:string,base:string|null|undefined):boolean[] {
 const lines=source.split('\n');
 if(typeof base!=='string') return lines.map(()=>true);
 const available=new Map<string,number>();
 for(const line of base.split('\n')) available.set(line,(available.get(line)??0)+1);
 return lines.map(line=>{
  const count=available.get(line)??0;
  if(count===0) return true;
  available.set(line,count-1);
  return false;
 });
}

/** Whether a character range touches any added or changed line. */
function touchesChange(source:string,changed:boolean[]):(start:number,end:number)=>boolean {
 if(changed.every(Boolean)) return ()=>true;
 const starts=[0];
 for(let i=source.indexOf('\n');i!==-1;i=source.indexOf('\n',i+1)) starts.push(i+1);
 const lineOf=(offset:number)=>{
  let low=0,high=starts.length-1;
  while(low<high) {const middle=(low+high+1)>>1;if(starts[middle]<=offset) low=middle;else high=middle-1;}
  return low;
 };
 return (start,end)=>{
  for(let line=lineOf(start),last=lineOf(Math.max(start,end-1));line<=last;line++) if(changed[line]) return true;
  return false;
 };
}

/**
 * Whether a name reads as source words rather than a value: letters only,
 * no camelCase or snake_case word longer than 16 letters, and at most one
 * word shorter than three. A name a repair declares itself can otherwise
 * smuggle a low-entropy secret such as `hunter2hunter2hunter2`, or a
 * mixed-case one such as `QwErTyUiOp...`, past the credential shapes.
 */
function wordy(name:string):boolean {
 if(!/^[A-Za-z_$]+$/.test(name)) return false;
 const words=name.replace(/([a-z])([A-Z])/g,'$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g,'$1_$2').split(/[_$]+/).filter(Boolean);
 return words.every(word=>word.length<=16)&&words.filter(word=>word.length<3).length<=1;
}

/** A conventional environment variable name, such as GITHUB_TOKEN. */
function environmentName(name:string):boolean {
 return /^[A-Z][A-Z0-9_]*$/.test(name)&&name.split('_').every(word=>word.length<=16&&!/\d{3}/.test(word));
}

/** The ordinary credential shapes, judged only where they touch an added or changed line. */
function refuseChanged(text:string,touches:(start:number,end:number)=>boolean):void {
 if(credentialMatches(text).some(([start,end])=>touches(start,end))) throw new RepairRefusal(CREDENTIAL_REFUSAL);
}

/** Scan a copy only. Publication always retains the reviewed source bytes. */
function checkSource(path:string,source:string,base:string|null|undefined):void {
 const changed=changedLines(source,base);
 // Nothing added or changed: every line is already in the repository.
 if(!changed.some(Boolean)) return;
 const touches=touchesChange(source,changed);
 if(!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(path)) return refuseChanged(source,touches);
 const file=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true);
 const masks:Array<[number,number]>=[];
 // Names this file declares. A credential value pasted without quotes also
 // parses as an identifier, but it is never declared anywhere in the file.
 // A name declared on an unchanged line is already in the repository. A name
 // the repair declares itself must also read as source words.
 const declared=new Set<string>(),unchangedDeclarations=new Set<string>();
 function declarations(node:ts.Node):void {
  if((ts.isVariableDeclaration(node)||ts.isParameter(node)||ts.isBindingElement(node)||ts.isFunctionDeclaration(node)
   ||ts.isClassDeclaration(node)||ts.isEnumDeclaration(node)||ts.isImportSpecifier(node)||ts.isImportClause(node)
   ||ts.isNamespaceImport(node)||ts.isImportEqualsDeclaration(node))&&node.name&&ts.isIdentifier(node.name)) {
   declared.add(node.name.text);
   if(!touches(node.name.getStart(file),node.name.end)) unchangedDeclarations.add(node.name.text);
  }
  ts.forEachChild(node,declarations);
 }
 declarations(file);
 const knownName=(name:string)=>unchangedDeclarations.has(name)||declared.has(name)&&wordy(name);
 // Only these complete illustrative examples are exempt, and only in comments.
 // Provider keys and URL passwords elsewhere in a comment still receive the ordinary check.
 function commentRange(start:number,end:number):void {
  const comment=source.slice(start,end);
  for(const match of comment.matchAll(/\b(?:sk-ant-(?:api03|oat01)-\.\.\.|https:\/\/user:secret@host)(?=$|[\s,;])/g)) {
   masks.push([start+match.index!,start+match.index!+match[0].length]);
  }
  // A comment quoting source such as `token: process.env.GITHUB_TOKEN!`
  // names where a credential comes from, not the credential. Only an
  // environment read with a conventional name, or a read on `this` or a
  // known name whose property names read as source words.
  for(const match of comment.matchAll(/\b[A-Za-z0-9_-]*(?:token|key|secret|password)["']?[ \t]*[=:][ \t]*["']?((?:[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)*)(?![\w$.])/gi)) {
   const reference=match[1],[root,...rest]=reference.split('.');
   if(!(rest.length===2&&root==='process'&&rest[0]==='env'&&environmentName(rest[1])||(root==='this'?rest.length>0:knownName(root))&&rest.every(wordy))) continue;
   const at=start+match.index!+match[0].length-reference.length;
   // Provider shapes inside the reference itself are still credentials.
   if(touches(at,at+reference.length)) refuseCredentials(reference);
   masks.push([at,at+reference.length]);
  }
 }
 function comments(node:ts.Node):void {
  ts.forEachLeadingCommentRange(source,node.pos,commentRange);
  ts.forEachTrailingCommentRange(source,node.end,commentRange);
  for(const child of node.getChildren(file)) comments(child);
 }
 comments(file);
 function unwrap(node:ts.Expression):ts.Expression {
  while(ts.isParenthesizedExpression(node)||ts.isAsExpression(node)||ts.isTypeAssertionExpression(node)||ts.isNonNullExpression(node)||ts.isSatisfiesExpression(node)) node=node.expression;
  return node;
 }
 function memberRead(node:ts.Node):boolean {
  if(ts.isNonNullExpression(node)||ts.isParenthesizedExpression(node)) return memberRead(node.expression);
  if(!ts.isPropertyAccessExpression(node)) return false;
  // A chain on `this` names only properties, so every name must read as source words.
  const names:string[]=[];
  let root:ts.Expression=node;
  while(ts.isPropertyAccessExpression(root)||ts.isNonNullExpression(root)||ts.isParenthesizedExpression(root)) {
   if(ts.isPropertyAccessExpression(root)) names.push(root.name.text);
   root=root.expression;
  }
  if(root.kind===ts.SyntaxKind.ThisKeyword) return names.every(wordy);
  return ts.isIdentifier(root);
 }
 function assignment(name:ts.Node,initializer:ts.Expression|undefined):void {
  if(!initializer||!sensitiveName.test(ts.isStringLiteralLike(name)?name.text:name.getText(file))) return;
  const value=unwrap(initializer);
  // A property read, or a name this file declares, is source syntax, not an
  // unquoted diagnostic credential. Non-null assertions and casts do not change that.
  // Strings, calls, element access and undeclared bare identifiers retain conservative checking.
  if(memberRead(value)||ts.isIdentifier(value)&&knownName(value.text)) {
   if(touches(initializer.getStart(file),initializer.end)) refuseCredentials(initializer.getText(file));
   masks.push([initializer.getStart(file),initializer.end]);
  }
  if(ts.isStringLiteralLike(value)&&touches(value.getStart(file),value.end)) refuseCredentials('token="'+value.text+'"');
 }
 function visit(node:ts.Node):void {
  // Decoding literals catches escaped provider prefixes as well as ordinary literals.
  if((ts.isStringLiteralLike(node)||ts.isTemplateHead(node)||ts.isTemplateMiddle(node)||ts.isTemplateTail(node))&&touches(node.getStart(file),node.end)) refuseCredentials(node.text);
  if(ts.isVariableDeclaration(node)||ts.isPropertyAssignment(node)||ts.isPropertyDeclaration(node)||ts.isParameter(node)||ts.isBindingElement(node)) assignment(node.name,node.initializer);
  if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken) assignment(node.left,node.right);
  ts.forEachChild(node,visit);
 }
 visit(file);
 // Masking is internal to the scanner and must never alter the publication.
 let checked=source;
 for(const [start,end] of masks.sort((a,b)=>b[0]-a[0])) checked=checked.slice(0,start)+' '.repeat(end-start)+checked.slice(end);
 refuseChanged(checked,touches);
}

/**
 * Each submitted path's content at the repair's base revision, read from
 * the repository the repair publishes to. null for a path the base lacks.
 */
export async function loadRepairBase(github:GitHubBroker,repository:string,revision:string,paths:string[]):Promise<Record<string,string|null>> {
 if(!/^[a-f0-9]{40}$/.test(revision)) throw new RepairBaseUnavailable('Repair base revision is not exact');
 const read=async(path:string,accept:string)=>{
  try {return await github.request(repository,{method:'GET',path:'/repos/'+repository+path,headers:{accept}});}
  catch {throw new RepairBaseUnavailable('Repair base sources unavailable');}
 };
 // A per-path 404 means the base lacks the file only once the base itself is readable.
 const commit=await read('/git/commits/'+revision,'application/vnd.github+json');
 if(commit.status!==200) throw new RepairBaseUnavailable('Repair base revision unavailable: HTTP '+commit.status);
 // Paths are validated again in full before any check relies on them.
 const valid=paths.filter(path=>/^[\w./-]+$/.test(path)&&!path.startsWith('/')&&!path.split('/').some(part=>!part||part==='.'||part==='..'));
 // At most eight at once, below GitHub's concurrency limits.
 const responses:Awaited<ReturnType<typeof read>>[]=[];
 for(let i=0;i<valid.length;i+=8) responses.push(...await Promise.all(valid.slice(i,i+8).map(path=>read('/contents/'+path+'?ref='+revision,'application/vnd.github.raw+json'))));
 const base:Record<string,string|null>={};
 valid.forEach((path,i)=>{
  const response=responses[i];
  if(response.status===404) base[path]=null;
  else if(response.status===200) base[path]=response.body;
  else throw new RepairBaseUnavailable('Repair base sources unavailable: HTTP '+response.status);
 });
 return base;
}

/**
 * Only the reviewed preparation route uses source-aware checking. Diagnostics remain strict.
 * With `base`, the sources at the repair's base revision, credential shapes
 * are judged only on the lines the repair adds or changes. Without it every
 * line counts as new. The pinned package scan always reads every byte.
 * Every refusal of the submitted bytes is a RepairRefusal.
 */
export function validateRepairPublication(value:unknown,base?:Record<string,string|null>):RepairPublication {
 const p=value as RepairPublication;
 if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!['files','modes','message','review','checksPassed'].includes(k))
  ||p.review!=='PASS'||p.checksPassed!==true||typeof p.message!=='string'||!p.message.trim()||p.message.length>2000
  ||!p.files||typeof p.files!=='object'||Array.isArray(p.files)||Object.keys(p.files).length===0||Object.keys(p.files).length>100
  ||p.modes!==undefined&&(!p.modes||typeof p.modes!=='object'||Array.isArray(p.modes))) throw new RepairRefusal('Repair requires passing independent review and full checks');
 // Include the actual JSON envelope and its escaping in the original private limit.
 if(Buffer.byteLength(JSON.stringify(p))>PRIVATE_LIMIT) throw new RepairRefusal('Task artifacts exceed the private transport limit');
 refuseCredentials(p.message);
 for(const [path,content] of Object.entries(p.files)) {
  if(!/^[\w./-]+$/.test(path)||path.startsWith('/')||path.split('/').some(part=>!part||part==='.'||part==='..')
   ||content!==null&&typeof content!=='string') throw new RepairRefusal('Invalid repair path');
  refuseCredentials(path);
  if(content!==null) checkSource(path,content,base&&Object.hasOwn(base,path)?base[path]:undefined);
 }
 for(const [path,mode] of Object.entries(p.modes??{})) {
  if(!Object.hasOwn(p.files,path)||!['100644','100755'].includes(mode)) throw new RepairRefusal('Unsupported repair file mode');
 }
 try {scanSourcePackage(p.files);}
 catch(error) {throw error instanceof SourceScanFindings?new RepairRefusal(error.message):error;}
 return p;
}
