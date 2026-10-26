// Shared presentation for the HTML fallback and embedded main canvas prototype.
(() => {
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function blocks(markdown){
    return String(markdown||'').split(/(!\[[^\]]*\]\([^\s]+\))/g).flatMap(part=>{
      const image=part.match(/^!\[([^\]]*)\]\(([^\s]+)\)$/);
      if(image){const url=image[2];return /^(https?:\/\/|data:image\/(png|jpeg|webp|gif|svg\+xml)[;,])/i.test(url)?[{image:url,alt:image[1]}]:[{text:part}];}
      return part.split(/\n\s*\n/).filter(text=>text.trim()).map(text=>({text}));
    });
  }
  function markup(card){
    const tags=card.showTags!==false&&(card.tags||[]).length?`<div class="fc-tags">${card.tags.map(tag=>'<span>'+escape(tag)+'</span>').join('')}</div>`:'';
    return `<header class="fc-head"><div class="fc-origin">${escape(card.origin||'本人记录')}</div><h3>${escape(card.text)}</h3></header>${card.showBody!==false&&card.body?'<div class="fc-body"></div>':''}${tags}<footer class="fc-foot"><span class="fc-overflow"></span><button type="button" data-card-notebook="${escape(card.id)}">写字板</button></footer><button type="button" class="fc-resize" aria-label="调整${escape(card.text)}卡片大小" title="拖动调整宽高；方向键微调"></button>`;
  }
  function fullBody(markdown){return blocks(markdown).map(block=>block.image?`<img src="${escape(block.image)}" alt="${escape(block.alt||'正文图片')}">`:`<p>${escape(block.text)}</p>`).join('');}
  function fill(card,node){
    const body=node.querySelector('.fc-body');if(!body)return;
    body.replaceChildren();let remaining=body.clientHeight,clipped=false,previousImage=false,used=false;
    const list=blocks(card.body);
    for(let i=0;i<list.length;i++){
      const block=list[i],gap=used&&(previousImage||block.image)?8:0;remaining-=gap;
      if(remaining<22){clipped=true;break;}
      const element=document.createElement(block.image?'img':'p');
      if(gap)element.style.marginTop=gap+'px';
      if(block.image){element.src=block.image;element.alt=block.alt||'正文图片';element.draggable=false;element.style.height=Math.min(remaining,body.clientWidth*.54)+'px';body.append(element);remaining-=element.offsetHeight;}
      else{element.textContent=block.text;body.append(element);const natural=element.offsetHeight,lines=Math.floor(remaining/22);element.style.webkitLineClamp=String(lines);remaining-=Math.min(natural,lines*22);if(natural>lines*22){clipped=true;break;}}
      used=true;previousImage=!!block.image;
      if(i<list.length-1&&remaining<22){clipped=true;break;}
    }
    node.querySelector('.fc-overflow').textContent=clipped?'还有内容':'';node.dataset.previewBudget=String(body.clientHeight);node.dataset.clipped=String(clipped);
  }
  function minimum(node){return 34+node.querySelector('.fc-head').offsetHeight+30+(node.querySelector('.fc-tags')?node.querySelector('.fc-tags').offsetHeight+10:0)+(node.querySelector('.fc-body')?56:0);}
  globalThis.ForkwiseCards={escape,blocks,markup,fullBody,fill,minimum};
})();
