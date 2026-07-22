import os
root = r'C:\Users\Admin\Documents\mouaif'
files = [f for f in os.listdir(root) if '.mouaif.messages.' in f]
print('Total root message files:', len(files))

targets = [
    '.mouaif.messages.a3375921.json',
    '.mouaif.messages.c3c7bd21.json',
    '.mouaif.messages.51af3a56.json',
    '.mouaif.messages.6687f443.json',
    '.mouaif.messages.fc02a28c.json',
    '.mouaif.messages.87c3026a.json',
]

for t in targets:
    root_path = os.path.join(root, t)
    trace_path = os.path.join(root, '.mouaif', 'traces', t)
    exists_root = os.path.exists(root_path)
    exists_trace = os.path.exists(trace_path)
    size = os.path.getsize(root_path) if exists_root else (os.path.getsize(trace_path) if exists_trace else 0)
    print(f'{t} root={exists_root} trace={exists_trace} size={size}')