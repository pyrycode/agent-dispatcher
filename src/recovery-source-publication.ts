import ts from 'typescript';
import {scrubCredentials} from './agent-runtime.js';
import type {RepairPublication} from './recovery-repair-publication.js';

const PRIVATE_LIMIT=4*1024*1024;
const sensitiveName=/(?:token|key|secret|password)$/i;
function refuseCredentials(text:string):void {
 if(scrubCredentials(text)!==text) throw new Error('Repair contains credential-shaped text; retain it privately');
}

/** Scan a copy only. Publication always retains the reviewed source bytes. */
function checkSource(path:string,source:string):void {
 if(!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(path)) return refuseCredentials(source);
 const file=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true);
 const masks:Array<[number,number]>=[];
 // Only these complete illustrative examples are exempt, and only in comments.
 // Provider keys and URL passwords elsewhere in a comment still receive the ordinary check.
 function commentRange(start:number,end:number):void {
  const comment=source.slice(start,end);
  for(const match of comment.matchAll(/\b(?:sk-ant-(?:api03|oat01)-\.\.\.|https:\/\/user:secret@host)(?=$|[\s,;])/g)) {
   masks.push([start+match.index!,start+match.index!+match[0].length]);
  }
 }
 function comments(node:ts.Node):void {
  ts.forEachLeadingCommentRange(source,node.pos,commentRange);
  ts.forEachTrailingCommentRange(source,node.end,commentRange);
  for(const child of node.getChildren(file)) comments(child);
 }
 comments(file);
 function memberRead(node:ts.Node):boolean {
  return ts.isPropertyAccessExpression(node)&&(ts.isIdentifier(node.expression)||memberRead(node.expression));
 }
 function assignment(name:ts.Node,initializer:ts.Expression|undefined):void {
  if(!initializer||!sensitiveName.test(ts.isStringLiteralLike(name)?name.text:name.getText(file))) return;
  // A property read is source syntax, not an unquoted diagnostic credential.
  // Strings, calls, element access and bare identifiers retain conservative checking.
  if(memberRead(initializer)) {
   refuseCredentials(initializer.getText(file));
   masks.push([initializer.getStart(file),initializer.end]);
  }
  let literal=initializer;
  while(ts.isParenthesizedExpression(literal)||ts.isAsExpression(literal)||ts.isTypeAssertionExpression(literal)||ts.isNonNullExpression(literal)||ts.isSatisfiesExpression(literal)) literal=literal.expression;
  if(ts.isStringLiteralLike(literal)) refuseCredentials('token="'+literal.text+'"');
 }
 function visit(node:ts.Node):void {
  // Decoding literals catches escaped provider prefixes as well as ordinary literals.
  if(ts.isStringLiteralLike(node)||ts.isTemplateHead(node)||ts.isTemplateMiddle(node)||ts.isTemplateTail(node)) refuseCredentials(node.text);
  if(ts.isVariableDeclaration(node)||ts.isPropertyAssignment(node)||ts.isPropertyDeclaration(node)||ts.isParameter(node)||ts.isBindingElement(node)) assignment(node.name,node.initializer);
  if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken) assignment(node.left,node.right);
  ts.forEachChild(node,visit);
 }
 visit(file);
 // Masking is internal to the scanner and must never alter the publication.
 let checked=source;
 for(const [start,end] of masks.sort((a,b)=>b[0]-a[0])) checked=checked.slice(0,start)+' '.repeat(end-start)+checked.slice(end);
 refuseCredentials(checked);
}

/** Only the reviewed preparation route uses source-aware checking. Diagnostics remain strict. */
export function validateRepairPublication(value:unknown):RepairPublication {
 const p=value as RepairPublication;
 if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!['files','modes','message','review','checksPassed'].includes(k))
  ||p.review!=='PASS'||p.checksPassed!==true||typeof p.message!=='string'||!p.message.trim()||p.message.length>2000
  ||!p.files||typeof p.files!=='object'||Array.isArray(p.files)||Object.keys(p.files).length===0||Object.keys(p.files).length>100
  ||p.modes!==undefined&&(!p.modes||typeof p.modes!=='object'||Array.isArray(p.modes))) throw new Error('Repair requires passing independent review and full checks');
 // Include the actual JSON envelope and its escaping in the original private limit.
 if(Buffer.byteLength(JSON.stringify(p))>PRIVATE_LIMIT) throw new Error('Task artifacts exceed the private transport limit');
 refuseCredentials(p.message);
 for(const [path,content] of Object.entries(p.files)) {
  if(!/^[\w./-]+$/.test(path)||path.startsWith('/')||path.split('/').some(part=>!part||part==='.'||part==='..')
   ||content!==null&&typeof content!=='string') throw new Error('Invalid repair path');
  refuseCredentials(path);
  if(content!==null) checkSource(path,content);
 }
 for(const [path,mode] of Object.entries(p.modes??{})) {
  if(!Object.hasOwn(p.files,path)||!['100644','100755'].includes(mode)) throw new Error('Unsupported repair file mode');
 }
 return p;
}
