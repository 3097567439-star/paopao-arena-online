'use strict';

// 泡泡竞技场 v6.2：低延迟公网联机版 · 零依赖静态服务器 + WebSocket 房间服务器
// Node.js 18+：node server.js

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const W = 13, H = 11;
const DIRS = [[1,0],[-1,0],[0,1],[0,-1]];
const COLORS = ['#42bff5','#ff6e7f','#ff9d49','#9a79ff'];
const SPAWNS = [[1,1],[W-2,H-2],[W-2,1],[1,H-2]];
const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.txt':'text/plain; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png'};
const rooms = new Map();
let nextClientId = 1, nextBombId = 1, nextFlameId = 1;

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const key=(x,y)=>`${x},${y}`;
const rand=(a,b)=>Math.floor(Math.random()*(b-a+1))+a;

function safeSend(c,obj){ if(!c || c.closed) return; try{sendText(c.socket, JSON.stringify(obj));}catch(_){} }
function roomBroadcast(room,obj){ for(const c of room.clients.values()) safeSend(c,obj); }
function roomCode(){ let c; do{c=String(rand(1000,9999));}while(rooms.has(c)); return c; }
function cleanName(v){ return String(v||'玩家').replace(/[<>\r\n]/g,'').trim().slice(0,12)||'玩家'; }

function lobbyPayload(room){
  return {type:'lobby', code:room.code, hostId:room.hostId, started:!!room.game, players:[...room.clients.values()].map(c=>({id:c.id,name:c.name,color:c.color})), fillBots:room.fillBots};
}
function broadcastLobby(room){ roomBroadcast(room,lobbyPayload(room)); }

function createRoom(client,name){
  leaveRoom(client,false);
  const code=roomCode();
  const room={code,hostId:client.id,clients:new Map(),game:null,fillBots:true,lastTick:Date.now(),snapshotAcc:0};
  rooms.set(code,room); client.name=cleanName(name); client.color=COLORS[0]; client.room=room; room.clients.set(client.id,client);
  broadcastLobby(room);
}
function joinRoom(client,code,name){
  const room=rooms.get(String(code||'').trim());
  if(!room) return safeSend(client,{type:'error',message:'房间不存在'});
  if(room.game) return safeSend(client,{type:'error',message:'本局已经开始，请等下一局'});
  if(room.clients.size>=4) return safeSend(client,{type:'error',message:'房间已满'});
  leaveRoom(client,false);
  client.name=cleanName(name); client.room=room; room.clients.set(client.id,client);
  const used=new Set([...room.clients.values()].filter(c=>c!==client).map(c=>c.color));
  client.color=COLORS.find(c=>!used.has(c))||COLORS[room.clients.size-1];
  broadcastLobby(room);
}
function leaveRoom(client,notify=true){
  const room=client.room; if(!room)return;
  room.clients.delete(client.id); client.room=null;
  if(room.game){
    const a=room.game.actors.find(a=>a.id===client.id); if(a){a.connected=false;a.inputDir={x:0,y:0};}
    roomBroadcast(room,{type:'event',event:'feed',text:`📡 ${client.name} 断开连接`});
  }
  if(room.clients.size===0){rooms.delete(room.code);return;}
  if(room.hostId===client.id)room.hostId=[...room.clients.keys()][0];
  if(notify)broadcastLobby(room);
}

function makeMap(){
  const map=Array.from({length:H},()=>Array(W).fill(0));
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    if(x===0||y===0||x===W-1||y===H-1) map[y][x]=1;
    else if(x%2===0&&y%2===0) map[y][x]=1;
    else map[y][x]=Math.random()<.58?2:0;
  }
  const clears=[[1,1],[1,2],[2,1],[W-2,H-2],[W-3,H-2],[W-2,H-3],[W-2,1],[W-3,1],[W-2,2],[1,H-2],[1,H-3],[2,H-2]];
  clears.forEach(([x,y])=>map[y][x]=0); return map;
}
function makeActor(id,name,color,spawn,isBot=false){
  return {id,name,color,isBot,isAI:isBot,x:spawn[0]+.5,y:spawn[1]+.5,alive:true,connected:true,speed:isBot?2.28:2.72,bombCap:1,range:2,activeBombs:0,canKick:false,remote:false,shield:0,kills:0,inv:0,kickCooldown:0,kickPulse:0,moveDir:{x:0,y:0},inputDir:{x:0,y:0},botThink:0,botBombCd:.8};
}
function startGame(room){
  const humans=[...room.clients.values()]; if(!humans.length)return;
  const actors=[];
  humans.slice(0,4).forEach((c,i)=>actors.push(makeActor(c.id,c.name,c.color,SPAWNS[i],false)));
  if(room.fillBots){
    const botNames=['莓莓','橙仔','葡萄'];
    while(actors.length<4){const i=actors.length;actors.push(makeActor(`bot-${room.code}-${i}`,botNames[i-1]||`机器人${i}`,COLORS[i],SPAWNS[i],true));}
  }
  if(actors.length<2){safeSend(humans[0],{type:'error',message:'至少需要 2 名参赛者；可以开启 AI 补位'});return;}
  room.game={map:makeMap(),actors,bombs:[],items:[],flames:[],countdown:3.5,gameOver:false,winnerId:null,startedAt:Date.now(),eventSeq:0};
  room.lastTick=Date.now(); room.snapshotAcc=0;
  roomBroadcast(room,{type:'started'}); broadcastSnapshot(room,true);
}

function bombAt(g,x,y){return g.bombs.find(b=>!b.dead&&b.x===x&&b.y===y);}
function actorsInCell(g,x,y){return g.actors.filter(a=>a.alive&&Math.floor(a.x)===x&&Math.floor(a.y)===y);}
function solidCell(g,x,y,a){
  if(x<0||y<0||x>=W||y>=H||g.map[y][x]>0)return true;
  const b=bombAt(g,x,y); if(!b)return false;
  if(a&&b.passActors.has(a.id)&&Math.floor(a.x)===x&&Math.floor(a.y)===y)return false;
  return true;
}
function pointBlocked(g,a,px,py){return solidCell(g,Math.floor(px),Math.floor(py),a);}
function bombCellFree(g,x,y,ignore=null){
  if(x<1||y<1||x>=W-1||y>=H-1||g.map[y][x]!==0)return false;
  if(g.bombs.some(b=>!b.dead&&b!==ignore&&b.x===x&&b.y===y))return false;
  if(g.actors.some(a=>a.alive&&Math.floor(a.x)===x&&Math.floor(a.y)===y))return false;
  return true;
}
function kickBomb(g,b,dx,dy,a){
  if(!b||b.dead||b.moving||!a.canKick||a.kickCooldown>0)return false;
  if(!bombCellFree(g,b.x+dx,b.y+dy,b))return false;
  b.fromX=b.x;b.fromY=b.y;b.x+=dx;b.y+=dy;b.kickDir={x:dx,y:dy};b.slide=0;b.moving=true;b.passActors.clear();a.kickCooldown=.15;a.kickPulse=.20;return true;
}
function tryMove(g,a,dx,dy,dt){
  if(!a.alive||(!dx&&!dy))return false;
  const total=a.speed*dt,steps=Math.max(1,Math.ceil(total/.09)),dist=total/steps,r=.265;let moved=false;
  for(let i=0;i<steps;i++){
    if(dx){const nx=a.x+dx*dist,edge=nx+Math.sign(dx)*r,cx=Math.floor(edge),cy=Math.floor(a.y),hit=bombAt(g,cx,cy);if(hit&&a.canKick)kickBomb(g,hit,dx,0,a);if(!pointBlocked(g,a,edge,a.y-r+.025)&&!pointBlocked(g,a,edge,a.y+r-.025)){a.x=nx;moved=true}else break;}
    if(dy){const ny=a.y+dy*dist,edge=ny+Math.sign(dy)*r,cx=Math.floor(a.x),cy=Math.floor(edge),hit=bombAt(g,cx,cy);if(hit&&a.canKick)kickBomb(g,hit,0,dy,a);if(!pointBlocked(g,a,a.x-r+.025,edge)&&!pointBlocked(g,a,a.x+r-.025,edge)){a.y=ny;moved=true}else break;}
  }
  a.x=clamp(a.x,1.27,W-1.27);a.y=clamp(a.y,1.27,H-1.27);
  g.bombs.forEach(b=>{if(b.passActors.has(a.id)&&(Math.floor(a.x)!==b.x||Math.floor(a.y)!==b.y))b.passActors.delete(a.id)});
  pickup(g,a);return moved;
}
function nearestCenter(v){return Math.round(v-.5)+.5;}
function canMoveDir(g,a,d){
  if(!d.x&&!d.y)return false;const r=.265,p=.08;
  if(d.x){const edge=a.x+d.x*(r+p);return !pointBlocked(g,a,edge,a.y-r+.03)&&!pointBlocked(g,a,edge,a.y+r-.03);}
  const edge=a.y+d.y*(r+p);return !pointBlocked(g,a,a.x-r+.03,edge)&&!pointBlocked(g,a,a.x+r-.03,edge);
}
function moveActor(g,a,dt){
  const d=a.inputDir||{x:0,y:0}; if(!d.x&&!d.y){a.moveDir={x:0,y:0};return;}
  // 服务器端拐角辅助：靠近中心线时允许自然转向。
  if(d.y){const tx=nearestCenter(a.x),off=tx-a.x;if(Math.abs(off)<=.30)a.x+=clamp(off,-a.speed*2.5*dt,a.speed*2.5*dt);}
  if(d.x){const ty=nearestCenter(a.y),off=ty-a.y;if(Math.abs(off)<=.30)a.y+=clamp(off,-a.speed*2.5*dt,a.speed*2.5*dt);}
  if(canMoveDir(g,a,d)){a.moveDir={x:d.x,y:d.y};tryMove(g,a,d.x,d.y,dt);} else a.moveDir={x:0,y:0};
}
function placeBomb(g,a){
  if(g.gameOver||g.countdown>0||!a?.alive||a.activeBombs>=a.bombCap)return false;
  const x=Math.floor(a.x),y=Math.floor(a.y);if(bombAt(g,x,y)||g.map[y][x]!==0)return false;
  const occ=actorsInCell(g,x,y);
  if(a.isBot&&occ.some(o=>o!==a))return false;
  const b={id:nextBombId++,x,y,t:a.remote?8.5:1.9,ownerId:a.id,range:a.range,remote:!!a.remote,dead:false,pulse:Math.random()*6.28,passActors:new Set(occ.map(o=>o.id)),moving:false,slide:0,kickDir:{x:0,y:0},fromX:x,fromY:y};
  g.bombs.push(b);a.activeBombs++;return true;
}
function detonateRemote(g,a){const b=g.bombs.filter(b=>!b.dead&&b.ownerId===a.id&&b.remote).sort((m,n)=>m.id-n.id)[0];if(!b)return false;explode(g,b);return true;}
function blastCells(g,x,y,range){const out=[[x,y]];for(const [dx,dy] of DIRS){for(let i=1;i<=range;i++){const nx=x+dx*i,ny=y+dy*i;if(nx<0||ny<0||nx>=W||ny>=H||g.map[ny][nx]===1)break;out.push([nx,ny]);if(g.map[ny][nx]===2)break;}}return out;}
function randomItem(){const r=Math.random();return r<.20?'bomb':r<.40?'range':r<.58?'speed':r<.72?'kick':r<.84?'remote':'shield';}
function pickup(g,a){const x=Math.floor(a.x),y=Math.floor(a.y);for(let i=g.items.length-1;i>=0;i--){const it=g.items[i];if(it.x!==x||it.y!==y)continue;if(it.type==='bomb')a.bombCap=Math.min(5,a.bombCap+1);if(it.type==='range')a.range=Math.min(6,a.range+1);if(it.type==='speed')a.speed=Math.min(a.isBot?3.4:4.2,a.speed+.28);if(it.type==='kick')a.canKick=true;if(it.type==='remote')a.remote=true;if(it.type==='shield')a.shield=Math.min(2,a.shield+1);g.items.splice(i,1);}}
function explode(g,b){
  if(b.dead)return;b.dead=true;const owner=g.actors.find(a=>a.id===b.ownerId);if(owner)owner.activeBombs=Math.max(0,owner.activeBombs-1);
  const cells=blastCells(g,b.x,b.y,b.range), lethal=new Set(cells.map(c=>key(c[0],c[1])));
  for(const a of g.actors){if(!a.alive||a.inv>0||!lethal.has(key(Math.floor(a.x),Math.floor(a.y))))continue;if(a.shield>0){a.shield--;a.inv=1.05;emitGameEvent(g,'feed',`🛡️ ${a.name} 的护盾挡住了爆炸`);continue;}a.alive=false;if(owner&&owner!==a)owner.kills++;emitGameEvent(g,'feed',owner===a?`💥 ${a.name} 被自己的泡泡淘汰`:`💥 ${owner?.name||'爆炸'} 淘汰了 ${a.name}`);}
  for(const [x,y] of cells){if(g.map[y]?.[x]===2){g.map[y][x]=0;if(Math.random()<.40)g.items.push({x,y,type:randomItem(),t:11,bob:Math.random()*6});}const chained=bombAt(g,x,y);if(chained&&!chained.dead)chained.t=Math.min(chained.t,.035);}
  g.flames.push({id:nextFlameId++,cells,t:.48}); emitGameEvent(g,'explosion',null,{cells}); checkGameOver(g);
}
function emitGameEvent(g,event,text,extra={}){g.eventSeq++;g._events ||= [];g._events.push({type:'event',event,text,seq:g.eventSeq,...extra});}
function checkGameOver(g){const alive=g.actors.filter(a=>a.alive);if(!g.gameOver&&alive.length<=1){g.gameOver=true;g.winnerId=alive[0]?.id||null;emitGameEvent(g,'gameover',null,{winnerId:g.winnerId});}}
function updateBombMotion(g,b,dt){if(!b.moving||b.dead)return;b.slide+=dt*6.1;while(b.slide>=1&&b.moving&&!b.dead){b.slide-=1;const nx=b.x+b.kickDir.x,ny=b.y+b.kickDir.y;if(!bombCellFree(g,nx,ny,b)){b.moving=false;b.slide=0;break;}b.fromX=b.x;b.fromY=b.y;b.x=nx;b.y=ny;}}

function dangerCells(g){const d=new Set();for(const b of g.bombs){if(b.dead||b.t>1.15)continue;for(const [x,y] of blastCells(g,b.x,b.y,b.range))d.add(key(x,y));}return d;}
function botLineAttack(g,a,target){const ax=Math.floor(a.x),ay=Math.floor(a.y),tx=Math.floor(target.x),ty=Math.floor(target.y);if(ax!==tx&&ay!==ty)return false;const dist=Math.abs(ax-tx)+Math.abs(ay-ty);if(!dist||dist>a.range)return false;const dx=Math.sign(tx-ax),dy=Math.sign(ty-ay);for(let i=1;i<dist;i++){if(g.map[ay+dy*i][ax+dx*i]!==0||bombAt(g,ax+dx*i,ay+dy*i))return false;}return true;}
function botChoose(g,a,dt){
  a.botThink-=dt;a.botBombCd-=dt;if(a.botThink>0)return;
  a.botThink=.12+Math.random()*.10;const danger=dangerCells(g),cx=Math.floor(a.x),cy=Math.floor(a.y);let dirs=DIRS.map(d=>({x:d[0],y:d[1]})).filter(d=>canMoveDir(g,a,d));
  if(danger.has(key(cx,cy))){dirs.sort((p,q)=>Number(danger.has(key(cx+p.x,cy+p.y)))-Number(danger.has(key(cx+q.x,cy+q.y))));a.inputDir=dirs[0]||{x:0,y:0};return;}
  const humans=g.actors.filter(o=>o.alive&&!o.isBot);const target=humans.sort((p,q)=>Math.abs(p.x-a.x)+Math.abs(p.y-a.y)-Math.abs(q.x-a.x)-Math.abs(q.y-a.y))[0];
  if(target){dirs.sort((p,q)=>{const pd=Math.abs((cx+p.x+.5)-target.x)+Math.abs((cy+p.y+.5)-target.y),qd=Math.abs((cx+q.x+.5)-target.x)+Math.abs((cy+q.y+.5)-target.y);return pd-qd;});}
  if(a.botBombCd<=0&&a.activeBombs<a.bombCap&&!bombAt(g,cx,cy)&&(DIRS.some(d=>g.map[cy+d[1]]?.[cx+d[0]]===2)||(target&&botLineAttack(g,a,target)))){if(placeBomb(g,a))a.botBombCd=.9+Math.random()*.6;}
  a.inputDir=dirs[0]||{x:0,y:0};
}

function tickRoom(room,dt){
  const g=room.game;if(!g)return;
  if(g.countdown>0){g.countdown=Math.max(0,g.countdown-dt);return;}
  if(!g.gameOver){for(const a of g.actors){if(!a.alive)continue;if(a.isBot)botChoose(g,a,dt);moveActor(g,a,dt);}}
  for(const b of g.bombs){if(b.dead)continue;updateBombMotion(g,b,dt);b.t-=dt;b.pulse+=dt*8;if(b.t<=0)explode(g,b);}g.bombs=g.bombs.filter(b=>!b.dead);
  for(const it of g.items){it.t-=dt;it.bob+=dt*4;}g.items=g.items.filter(i=>i.t>0);
  for(const f of g.flames)f.t-=dt;g.flames=g.flames.filter(f=>f.t>0);
  for(const a of g.actors){a.inv=Math.max(0,a.inv-dt);a.kickCooldown=Math.max(0,a.kickCooldown-dt);a.kickPulse=Math.max(0,a.kickPulse-dt);}
}
function serializeGame(g){return {map:g.map,countdown:g.countdown,gameOver:g.gameOver,winnerId:g.winnerId,actors:g.actors.map(a=>({id:a.id,name:a.name,color:a.color,isAI:a.isAI,isBot:a.isBot,x:a.x,y:a.y,alive:a.alive,speed:a.speed,bombCap:a.bombCap,range:a.range,activeBombs:a.activeBombs,canKick:a.canKick,remote:a.remote,shield:a.shield,kills:a.kills,inv:a.inv,kickPulse:a.kickPulse,connected:a.connected,moveDir:a.moveDir||{x:0,y:0}})),bombs:g.bombs.map(b=>({id:b.id,x:b.x,y:b.y,t:b.t,range:b.range,ownerId:b.ownerId,remote:b.remote,pulse:b.pulse,moving:b.moving,slide:b.slide,kickDir:b.kickDir,fromX:b.fromX,fromY:b.fromY})),items:g.items,flames:g.flames};}
function broadcastSnapshot(room,force=false){if(!room.game)return;roomBroadcast(room,{type:'state',serverTime:Date.now(),state:serializeGame(room.game)});if(room.game._events?.length){for(const e of room.game._events)roomBroadcast(room,e);room.game._events.length=0;}}

setInterval(()=>{
  const now=Date.now();for(const room of rooms.values()){if(!room.game)continue;const dt=clamp((now-room.lastTick)/1000,0,.05);room.lastTick=now;tickRoom(room,dt);room.snapshotAcc+=dt;if(room.snapshotAcc>=1/20){room.snapshotAcc-=1/20;broadcastSnapshot(room);}}
},1000/30);

function handleMessage(client,msg){
  let m;try{m=JSON.parse(msg)}catch{return;}
  if(m.type==='ping')return safeSend(client,{type:'pong',t:m.t,serverTime:Date.now()});
  if(m.type==='create')return createRoom(client,m.name);
  if(m.type==='join')return joinRoom(client,m.code,m.name);
  if(m.type==='leave')return leaveRoom(client,true);
  const room=client.room;if(!room)return safeSend(client,{type:'error',message:'请先创建或加入房间'});
  // v7.1 P2P 线路剖析：服务器只转发 SDP/ICE 信令，不承载 DataChannel 游戏流量。
  if(m.type==='rtcSignal'){
    const targetId=String(m.target||'');
    const target=targetId?room.clients.get(targetId):[...room.clients.values()].find(c=>c.id!==client.id);
    if(target) safeSend(target,{type:'rtcSignal',from:client.id,signal:m.signal||null});
    return;
  }
  if(m.type==='fillBots'&&client.id===room.hostId&&!room.game){room.fillBots=!!m.value;return broadcastLobby(room);}
  if(m.type==='start'&&client.id===room.hostId&&!room.game)return startGame(room);
  if(m.type==='restart'&&room.game?.gameOver)return startGame(room);
  const g=room.game;if(!g)return;
  const a=g.actors.find(a=>a.id===client.id);if(!a)return;
  if(m.type==='input'){const d=m.dir||{};const x=Number(d.x)||0,y=Number(d.y)||0;a.inputDir=Math.abs(x)>=Math.abs(y)?{x:Math.sign(x),y:0}:{x:0,y:Math.sign(y)};if(!x&&!y)a.inputDir={x:0,y:0};}
  if(m.type==='action'&&m.action==='bomb')placeBomb(g,a);
  if(m.type==='action'&&m.action==='remote')detonateRemote(g,a);
}

// ---- 极简 WebSocket 实现（浏览器文本帧足够本游戏使用） ----
function websocketAccept(key){return crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');}
function sendFrame(socket,opcode,payload){const data=Buffer.isBuffer(payload)?payload:Buffer.from(payload);let head;if(data.length<126){head=Buffer.alloc(2);head[0]=0x80|opcode;head[1]=data.length;}else if(data.length<65536){head=Buffer.alloc(4);head[0]=0x80|opcode;head[1]=126;head.writeUInt16BE(data.length,2);}else{head=Buffer.alloc(10);head[0]=0x80|opcode;head[1]=127;head.writeBigUInt64BE(BigInt(data.length),2);}socket.write(Buffer.concat([head,data]));}
function sendText(socket,text){sendFrame(socket,1,Buffer.from(text));}
function parseFrames(client,chunk){
  client.buffer=Buffer.concat([client.buffer,chunk]);
  while(client.buffer.length>=2){const b=client.buffer;const opcode=b[0]&15,masked=!!(b[1]&128);let len=b[1]&127,off=2;if(len===126){if(b.length<4)return;len=b.readUInt16BE(2);off=4;}else if(len===127){if(b.length<10)return;const big=b.readBigUInt64BE(2);if(big>BigInt(1e7)){client.socket.destroy();return;}len=Number(big);off=10;}const need=off+(masked?4:0)+len;if(b.length<need)return;let mask;if(masked){mask=b.subarray(off,off+4);off+=4;}const payload=Buffer.from(b.subarray(off,off+len));if(masked)for(let i=0;i<payload.length;i++)payload[i]^=mask[i%4];client.buffer=b.subarray(need);if(opcode===8){client.closed=true;client.socket.end();return;}if(opcode===9){sendFrame(client.socket,10,payload);continue;}if(opcode===1)handleMessage(client,payload.toString('utf8'));}
}

const server=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://localhost');
  if(u.pathname==='/health'){
    res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
    return res.end(JSON.stringify({ok:true,version:'v7.1',rooms:rooms.size,uptime:Math.round(process.uptime())}));
  }
  let p=decodeURIComponent(u.pathname);if(p==='/')p='/index.html';
  const file=path.normalize(path.join(ROOT,p));if(!file.startsWith(ROOT)){res.writeHead(403);return res.end('Forbidden');}
  fs.readFile(file,(err,data)=>{if(err){res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});return res.end('Not found');}res.writeHead(200,{'Content-Type':MIME[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(data);});
});
server.on('upgrade',(req,socket)=>{
  const u=new URL(req.url,'http://localhost');if(u.pathname!=='/ws'){socket.destroy();return;}
  const key=req.headers['sec-websocket-key'];if(!key){socket.destroy();return;}
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+websocketAccept(key)+'\r\n\r\n');
  // 实时游戏优先低延迟：关闭 Nagle，并开启 TCP keepalive。
  try{socket.setNoDelay(true);socket.setKeepAlive(true,15000);}catch(_){}
  const client={id:`p${nextClientId++}`,socket,buffer:Buffer.alloc(0),closed:false,room:null,name:'玩家',color:COLORS[0]};
  safeSend(client,{type:'hello',id:client.id,version:'v7.1'});
  socket.on('data',d=>parseFrames(client,d));socket.on('error',()=>{});socket.on('close',()=>{client.closed=true;leaveRoom(client,true);});socket.on('end',()=>{client.closed=true;leaveRoom(client,true);});
});
server.listen(PORT,HOST,()=>console.log(`\n泡泡竞技场 v7.1 P2P线路剖析服务器已启动\n本机: http://localhost:${PORT}\n局域网/公网: http://<服务器IP>:${PORT}\n`));
