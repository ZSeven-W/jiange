const white='#FFFFFF', ink='#1F2329', muted='#8F959E', border='#DEE0E3', blue='#1456F0';
function rect(parent,name,x,y,w,h,fill=white,stroke=border,r=4){return I(parent,{type:'frame',name,x,y,width:w,height:h,layout:'none',fill,stroke:{thickness:1,fill:stroke},cornerRadius:r});}
function text(parent,name,s,x,y,size=14,color=ink){return I(parent,{type:'text',name,x,y,content:s,fontSize:size,fill:color,fontWeight:400});}
const root=I(null,{type:'frame',name:'Find and replace reference',x:0,y:0,width:1280,height:600,layout:'none',fill:'#F5F6F7'});
function panel(name,x,replace){
  const h=replace?286:185;
  const p=rect(root,name,x+100,100,405,h,white,border,4);
  text(p,'Find tab','查找',24,16,16,replace?ink:blue);
  text(p,'Replace tab','替换',84,16,16,replace?blue:ink);
  text(p,'Close','×',362,13,22,'#646A73');
  I(p,{type:'rectangle',name:'divider',x:24,y:47,width:357,height:1,fill:border});
  I(p,{type:'rectangle',name:'active-tab',x:replace?84:24,y:46,width:32,height:3,fill:blue,cornerRadius:2});
  if(replace)text(p,'Find label','查找',24,66,14);
  let iy=replace?94:72;
  const input=rect(p,'Search input',24,iy,357,32,white,blue,5);
  text(input,'Placeholder','在文档内查找',10,7,14,muted);
  text(input,'Match count','0 / 0',316,7,14,'#646A73');
  if(replace){
    text(p,'Replace label','替换为',24,144,14);
    const second=rect(p,'Replace input',24,173,357,32,white,border,5);
    text(second,'Replace placeholder','请输入文字',10,7,14,muted);
  }
  const actions=replace?[['全部替换',24],['替换',116],['上一处',208],['下一处',300]]:[['上一处',208],['下一处',300]];
  for(const [label,ax] of actions){const bt=rect(p,label,ax,replace?229:128,80,32,replace&&label==='全部替换'?'#B6BBC1':white,border,5);text(bt,'label',label,12,7,14,replace&&label==='全部替换'?white:'#B7BBC1');}
}
panel('查找',0,false);panel('替换',450,true);
