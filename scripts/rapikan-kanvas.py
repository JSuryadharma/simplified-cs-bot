#!/usr/bin/env python3
"""Rapikan posisi node di kanvas workflows/wa-admin-lengkap.json (hanya posisi; node,
sambungan, dan parameter tidak berubah). Tiap alur (per trigger) disusun kiri ke kanan:
jalur utama satu baris, cabang di baris bawahnya; catatan (sticky) di kiri alurnya.
Jalankan dari root repo: python3 scripts/rapikan-kanvas.py
"""
import json
P='workflows/wa-admin-lengkap.json'
W=json.load(open(P)); w=W[0]
nodes={n['name']:n for n in w['nodes']}
C=w['connections']
XS,YS=256,192
edges={}   # name -> list of (output_index, child)
for src,v in C.items():
    for outs in v.values():
        for oi,o in enumerate(outs):
            for c in o: edges.setdefault(src,[]).append((oi,c['node']))
for k in edges: edges[k].sort(key=lambda t:t[0])
real=[n for n in nodes if not nodes[n]['type'].endswith('stickyNote')]
parents={n:set() for n in real}
for s,l in edges.items():
    for _,c in l: parents[c].add(s)
# components (undirected)
comp={}; comps=[]
for n in real:
    if n in comp: continue
    stack=[n]; cid=len(comps); comps.append([])
    while stack:
        x=stack.pop()
        if x in comp: continue
        comp[x]=cid; comps[cid].append(x)
        stack+= [c for _,c in edges.get(x,[])] + list(parents[x])
TRIG=lambda n: nodes[n]['type'].endswith(('Trigger','webhook','formTrigger','manualTrigger')) or nodes[n]['type'] in('n8n-nodes-base.webhook','n8n-nodes-base.formTrigger','n8n-nodes-base.manualTrigger')
# back edges via DFS from roots
def layout(members):
    roots=[n for n in members if TRIG(n)] or [n for n in members if not parents[n]]
    roots.sort(key=lambda n:(nodes[n]['position'][1],nodes[n]['position'][0]))
    back=set(); state={}
    def dfs(u):
        state[u]=1
        for _,c in edges.get(u,[]):
            if state.get(c)==1: back.add((u,c))
            elif c not in state: dfs(c)
        state[u]=2
    for r in roots: 
        if r not in state: dfs(r)
    for n in members:
        if n not in state: dfs(n)
    fwd=lambda u:[(oi,c) for oi,c in edges.get(u,[]) if (u,c) not in back]
    # longest path layer
    layer={}
    order=[]; seen=set()
    def topo(u):
        if u in seen: return
        seen.add(u)
        for _,c in fwd(u): topo(c)
        order.append(u)
    for r in roots: topo(r)
    for n in members: topo(n)
    for u in reversed(order):
        layer.setdefault(u,0)
        for _,c in fwd(u): layer[c]=max(layer.get(c,0),layer[u]+1)
    # rows: main chain first (first child keeps the row); other branches are queued and placed
    # left-to-right on the nearest row below whose cells along the branch chain are free
    import heapq
    row={}; occ=set(); q=[]; seq=[0]
    def chain(u):
        out=[u]; cur=u; seen={u}
        while True:
            nx=[c for _,c in fwd(cur) if c not in row and c not in seen]
            if not nx: return out
            cur=nx[0]; seen.add(cur); out.append(cur)
    def fits(ch, r): return all((layer[x], r) not in occ for x in ch)
    def place_chain(u, r):
        ch=chain(u)
        while not fits(ch, r): r+=1
        for x in ch:
            row[x]=r; occ.add((layer[x], r))
        for x in ch:
            for _,c in fwd(x):
                if c not in row:
                    seq[0]+=1; heapq.heappush(q,(layer[c], seq[0], c, r+1))
    def drain():
        while q:
            _,_,c,r=heapq.heappop(q)
            if c not in row: place_chain(c, r)
    for rt in roots:
        if rt not in row: place_chain(rt, (max(row.values())+1) if row else 0); drain()
    for n in members:
        if n not in row: place_chain(n, 0); drain()
    return {n:(layer[n],row[n]) for n in members}
STICKY_FOR={  # sticky -> a node in its flow
 'CATATAN 00 - Setup Qdrant':'Jalankan Setup','CATATAN 02 - Router WhatsApp':'Webhook Pesan WhatsApp',
 'CATATAN 02b - Endpoint Perintah Owner':'Webhook Perintah Owner','CATATAN 05 - Upload Knowledge dan Aset':'Form Upload Knowledge',
 'CATATAN 06 - Impor Knowledge v2':'Webhook Impor Knowledge','CATATAN 07 - Kebijakan Privasi':'Webhook Kebijakan Privasi',
 'CATATAN - Verifikasi Webhook Meta':'Verifikasi Webhook Meta'}
ORDER=['Jalankan Setup','Webhook Pesan WhatsApp','Webhook Perintah Owner','Form Upload Knowledge','Webhook Impor Knowledge','Webhook Kebijakan Privasi','Verifikasi Webhook Meta']
cid_order=[comp[x] for x in ORDER]
assert sorted(cid_order)==list(range(len(comps))), (len(comps), [sorted(c)[:3] for c in comps])
inv={v:k for k,v in STICKY_FOR.items()}
y=0
TOP=nodes['CATATAN UTAMA - Peta Workflow']; TOP['position']=[0,-400-TOP['parameters'].get('height',320)]
for key in ORDER:
    members=comps[comp[key]]
    pos=layout(members)
    note=nodes[inv[key]]; nh=note['parameters'].get('height',300); nw=note['parameters'].get('width',440)
    extra=0
    if key=='Webhook Pesan WhatsApp':
        extra=nodes['CATATAN 02c - Opsi Jawaban AI']['parameters']['height']+64  # ruang catatan opsi di atas
    base=y+extra
    for n,(lx,ry) in pos.items(): nodes[n]['position']=[lx*XS, base+ry*YS]
    note['position']=[-nw-96, y]
    if key=='Webhook Pesan WhatsApp':
        xs=[nodes[n]['position'][0] for n in ['Chat dengan Opsi?','Siapkan Pesan Opsi','Kirim Balasan dengan Opsi']]
        nodes['CATATAN 02c - Opsi Jawaban AI']['position']=[min(xs)-32, y]
    rows=max(r for _,r in pos.values())+1
    y=max(base+rows*YS, y+nh)+256
open(P,'w').write(json.dumps(W,separators=(',',':'),ensure_ascii=False))
# overlap check
ps=[(n['name'],tuple(n['position'])) for n in w['nodes'] if not n['type'].endswith('stickyNote')]
assert len(set(p for _,p in ps))==len(ps),'overlap'
print('components',len(comps),'ok')
