import { parseFragment, type DefaultTreeAdapterTypes as P5 } from 'parse5';
import { parseTableTSV } from './table-clipboard';
import type { RichTableCell, RichTableClipboard } from './table-rich-clipboard';
import type { Merge } from './table-ops';

const MAX_HTML = 512 * 1024, MAX_TAGS = 5000, MAX_CELLS = 1000, MAX_ROWS = 200, MAX_COLS = 50;
type Element = P5.Element;
type Node = P5.Node;
type Style = Pick<RichTableCell, 'fill' | 'horizontal' | 'vertical'>;
type ClassRule = { name: string; tag: string | null; declarations: string; specificity: number; order: number };
export interface ExternalTableResult { clipboard: RichTableClipboard; lostFormatting: boolean }
const UNSUPPORTED_STYLE = /(?:^|[;{])\s*(?:font(?:-[\w-]+)?|color|text-decoration(?:-[\w-]+)?|border(?:-[\w-]+)?|background-(?!color\b)[\w-]+|box-shadow|opacity|filter|transform|writing-mode|direction|text-transform|white-space)\s*:/i;
const RELEVANT_STYLE = /(?:^|[;{])\s*(?:background(?:-color)?|text-align|vertical-align)\s*:/i;
const isElement = (node: Node): node is Element => 'tagName' in node;
const attr = (node: Element, name: string) => node.attrs.find(a => a.name === name)?.value;
const descendants = (root: Node): Node[] | null => {
  const result: Node[] = [], pending: {node: Node; depth: number}[] = [{node:root,depth:0}];
  while (pending.length) {
    const {node,depth}=pending.pop()!;
    if (depth > 64 || result.length >= MAX_TAGS) return null;
    result.push(node);
    if ('childNodes' in node) for (let i=node.childNodes.length-1;i>=0;i--) pending.push({node:node.childNodes[i],depth:depth+1});
  }
  return result;
};

/** Only plain, opaque colors are mapped; CSS functions, URLs and variables are never evaluated. */
function color(value: string): string | null {
  const s=value.trim().toLowerCase().replace(/\s*!important\s*$/, '');
  const names:Record<string,string>={white:'#FFFFFF',black:'#000000',red:'#FF0000',blue:'#0000FF',green:'#008000',yellow:'#FFFF00',gray:'#808080',grey:'#808080',silver:'#C0C0C0',orange:'#FFA500',purple:'#800080',lime:'#00FF00',aqua:'#00FFFF',cyan:'#00FFFF',fuchsia:'#FF00FF',magenta:'#FF00FF',navy:'#000080',teal:'#008080',maroon:'#800000',olive:'#808000'};
  if (s==='transparent' || s==='none') return '';
  if (names[s]) return names[s];
  if (/^#[0-9a-f]{3}$/.test(s)) return '#'+[...s.slice(1)].map(ch=>ch+ch).join('').toUpperCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s.toUpperCase();
  const rgb=/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(s);
  if (rgb) {const parts=rgb.slice(1).map(Number);if(parts.every(n=>n<=255))return '#'+parts.map(n=>n.toString(16).padStart(2,'0')).join('').toUpperCase();}
  return null;
}
function applyDeclarations(style: Style, raw: string, inheritedFill: string): boolean {
  for (const part of raw.split(';')) {
    const i=part.indexOf(':'); if(i<1)continue;
    const key=part.slice(0,i).trim().toLowerCase(), value=part.slice(i+1).trim().toLowerCase();
    if (['background','background-color','text-align','vertical-align'].includes(key) && /!important\s*$/.test(value)) return false;
    if (key==='background' || key==='background-color') { const mapped=color(value); if(mapped===null)return false; style.fill=mapped || inheritedFill; }
    else if (key==='text-align') { if(value!=='left'&&value!=='center'&&value!=='right')return false;style.horizontal=value; }
    else if (key==='vertical-align') { if(value!=='top'&&value!=='middle'&&value!=='bottom')return false;style.vertical=value; }
  }
  return true;
}
/** Only top-level single-class rules participate; nested at-rules are ignored. */
function classRules(css:string, start:number): { rules:ClassRule[]; ignoredFormatting:boolean } {
  const out:ClassRule[]=[];let ignoredFormatting=false,depth=0,startAt=0,bodyAt=0,nested=false,quote='',comment=false;
  for(let i=0;i<css.length;i++){
    const ch=css[i],next=css[i+1];
    if(comment){if(ch==='*'&&next==='/'){comment=false;i++;}continue;}
    if(quote){if(ch==='\\'){i++;continue;}if(ch===quote)quote='';continue;}
    if(ch==='/'&&next==='*'){comment=true;i++;continue;}
    if(ch==='"'||ch==="'"){quote=ch;continue;}
    if(ch==='{'){if(depth===0){bodyAt=i+1;nested=false;}else nested=true;depth++;}
    else if(ch==='}'&&depth>0){
      depth--;
      if(depth===0){
        const selector=css.slice(startAt,bodyAt-1).replace(/\/\*[\s\S]*?\*\//g,'').trim();
        const match=/^(td|th)?\.([A-Za-z_][\w-]*)$/i.exec(selector);
        const declarations=css.slice(bodyAt,i);
        if(!nested&&match)out.push({name:match[2],tag:match[1]?.toLowerCase()??null,declarations,specificity:match[1]?11:10,order:start+out.length});
        else if(RELEVANT_STYLE.test(declarations))ignoredFormatting=true;
        startAt=i+1;
      }
    }
  }
  return {rules:out,ignoredFormatting};
}
function styleFor(element: Element, inherited: Style, rules: ClassRule[]): Style | null {
  const style={...inherited};
  const legacyColor=attr(element,'bgcolor');if(legacyColor){const fill=color(legacyColor);if(fill===null)return null;style.fill=fill || inherited.fill;}
  const h=attr(element,'align')?.toLowerCase();if(h){if(h!=='left'&&h!=='center'&&h!=='right')return null;style.horizontal=h;}
  const v=attr(element,'valign')?.toLowerCase();if(v){if(v!=='top'&&v!=='middle'&&v!=='bottom')return null;style.vertical=v;}
  const classes=new Set((attr(element,'class')??'').split(/\s+/));
  for(const rule of rules.filter(rule=>classes.has(rule.name)&&(!rule.tag||rule.tag===element.tagName)).sort((a,b)=>a.specificity-b.specificity||a.order-b.order)) if(!applyDeclarations(style,rule.declarations,inherited.fill))return null;
  if(!applyDeclarations(style,attr(element,'style')??'',inherited.fill))return null;
  return style;
}

/** Extract text only. Reject nested tables and non-text media rather than loading or silently dropping them. */
function cellText(root: Element): string | null {
  let out='', count=0;
  const visit=(node: Node,depth:number): boolean => {
    if(++count>MAX_TAGS || depth>64)return false;
    if(node.nodeName==='#text'){out+=(node as P5.TextNode).value;return out.length<=256*1024;}
    if(node.nodeName==='#comment')return true;
    if(!isElement(node))return false;
    if(node!==root && ['script','style','template','table','img','svg','math','iframe','object','embed','video','audio','input','canvas'].includes(node.tagName))return false;
    if(node.tagName==='br'){out+='\n';return true;}
    const block=node!==root && ['p','div'].includes(node.tagName);
    if(block && out && !out.endsWith('\n'))out+='\n';
    for(const child of node.childNodes)if(!visit(child,depth+1))return false;
    if(block && !out.endsWith('\n'))out+='\n';
    return true;
  };
  if(!visit(root,0))return null;
  return out.endsWith('\n') && root.childNodes.some(child=>isElement(child)&&['p','div'].includes(child.tagName)) ? out.slice(0,-1) : out;
}
const normalized = (text:string) => text.replace(/\r\n?/g,'\n').replace(/\u00a0/g,' ');
const intSpan = (value:string|undefined,max:number): number | null => {
  if(value===undefined)return 1;
  if(!/^[1-9]\d*$/.test(value))return null;
  const n=Number(value);return Number.isSafeInteger(n)&&n<=max?n:null;
};

/** Parse an external HTML table as inert data, accepting it only if its text agrees with text/plain. */
export function parseExternalTableHTML(html:string, plain:string): ExternalTableResult | null {
  if(!html || html.length>MAX_HTML || plain.length>256*1024 || /data-jiange-cell-grid\s*=/i.test(html))return null;
  let tags=0;for(const ch of html)if(ch==='<' && ++tags>MAX_TAGS)return null;
  try {
    const nodes=descendants(parseFragment(html));if(!nodes)return null;
    const tables=nodes.filter((node):node is Element=>isElement(node)&&node.tagName==='table');
    if(tables.length!==1)return null;
    const table=tables[0], inside=descendants(table);if(!inside)return null;
    let lostFormatting=inside.some(node=>isElement(node)&&(['b','strong','i','em','u','s','strike','font','a','sub','sup','bdi','bdo'].includes(node.tagName)||!!attr(node,'dir')||UNSUPPORTED_STYLE.test(attr(node,'style')??'')));
    const rules:ClassRule[]=[];
    for(const node of nodes){
      if(!isElement(node)||node.tagName!=='style')continue;
      const css=node.childNodes.filter((n):n is P5.TextNode=>n.nodeName==='#text').map(n=>n.value).join('');
      if(UNSUPPORTED_STYLE.test(css))lostFormatting=true;
      const parsed=classRules(css,rules.length);rules.push(...parsed.rules);lostFormatting ||= parsed.ignoredFormatting;if(rules.length>MAX_TAGS)return null;
    }
    const rowEls: {row:Element;group:Element|null}[]=[];let phase=0, seenHead=false;
    for(const child of table.childNodes){
      if(!isElement(child))continue;
      if(child.tagName==='tr') {if(phase>1)return null;phase=1;rowEls.push({row:child,group:null});}
      else if(['thead','tbody','tfoot'].includes(child.tagName)){
        if(child.tagName==='thead'){if(phase!==0||seenHead)return null;seenHead=true;}
        else if(child.tagName==='tbody'){if(phase>1)return null;phase=1;}
        else phase=2;
        for(const item of child.childNodes)if(isElement(item)&&item.tagName==='tr')rowEls.push({row:item,group:child});
      } else if(child.tagName==='table')return null;
      if(rowEls.length>MAX_ROWS)return null;
    }
    if(!rowEls.length)return null;
    const cells: (RichTableCell | undefined)[][]=Array.from({length:rowEls.length},()=>[]), merges:Merge[]=[];
    const defaults:Style={fill:'',horizontal:'left',vertical:'top'}, tableStyle=styleFor(table,defaults,rules);if(!tableStyle)return null;
    for(let r=0;r<rowEls.length;r++){
      const {row,group}=rowEls[r], groupStyle=group?styleFor(group,tableStyle,rules):tableStyle;if(!groupStyle)return null;
      const rowStyle=styleFor(row,groupStyle,rules);if(!rowStyle)return null;let col=0;
      for(const child of row.childNodes){
        if(!isElement(child)||!['td','th'].includes(child.tagName))continue;
        while(cells[r][col])col++;
        const rs=intSpan(attr(child,'rowspan'),MAX_ROWS),cs=intSpan(attr(child,'colspan'),MAX_COLS),text=cellText(child);
        if(!rs||!cs||text===null||r+rs>rowEls.length||col+cs>MAX_COLS||Array.from({length:rs},(_,i)=>rowEls[r+i].group).some(other=>other!==group))return null;
        const style=styleFor(child,rowStyle,rules);if(!style)return null;
        for(let y=r;y<r+rs;y++)for(let x=col;x<col+cs;x++){
          if(cells[y][x])return null;
          cells[y][x]=y===r&&x===col?{text,...style}:{text:'',...defaults};
        }
        if(rs>1||cs>1)merges.push([r,col,rs,cs]);
        col+=cs;
      }
    }
    const width=Math.max(...cells.map(row=>row.length));
    if(!width||width>MAX_COLS||width*cells.length>MAX_CELLS)return null;
    const grid:RichTableCell[][]=cells.map(row=>Array.from({length:width},(_,i)=>row[i]??{text:'',...defaults}));
    const plainRows=plain===''?[['']]:parseTableTSV(plain);
    if(!plainRows || plainRows.length!==grid.length || plainRows.some(row=>row.length!==width))return null;
    for(let r=0;r<grid.length;r++)for(let c=0;c<width;c++){
      const authoritative=plainRows[r]?.[c]??'';
      if(normalized(grid[r][c].text)!==normalized(authoritative))return null;
      grid[r][c].text=authoritative;
    }
    const clipboard:RichTableClipboard=merges.length?{version:2,cells:grid,merges}:{version:1,cells:grid};
    return {clipboard,lostFormatting};
  } catch { return null; }
}
