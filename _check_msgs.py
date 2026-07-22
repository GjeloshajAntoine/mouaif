import json, os, glob

root = r'C:\Users\Admin\Documents\mouaif'

with open(os.path.join(root, '.mouaif.json'), encoding='utf-8') as f:
    d = json.load(f)

chats = d.get('chats', [])

# Root message files
root_msgs = set()
for f in glob.glob(os.path.join(root, '.mouaif.messages.*.json')):
    basename = os.path.basename(f)
    cid = basename.replace('.mouaif.messages.', '').replace('.json', '')
    root_msgs.add(cid)

# Trace folder message files
trace_msgs = set()
trace_dir = os.path.join(root, '.mouaif', 'traces')
if os.path.isdir(trace_dir):
    for f in glob.glob(os.path.join(trace_dir, '.mouaif.messages.*.json')):
        basename = os.path.basename(f)
        cid = basename.replace('.mouaif.messages.', '').replace('.json', '')
        trace_msgs.add(cid)

print(f'Total chats in .mouaif.json: {len(chats)}')
print(f'Root message files: {len(root_msgs)}')
print(f'Trace folder message files: {len(trace_msgs)}')

# Chats with meaningful titles
for c in chats:
    cid = c['id']
    title = c.get('title', '?')
    if title == 'New chat':
        continue
    in_root = cid in root_msgs
    in_trace = cid in trace_msgs
    if in_root:
        loc = 'ROOT'
    elif in_trace:
        loc = 'TRACE'
    else:
        loc = 'MISSING'
    print(f'{cid} {loc} {title[:60]}')