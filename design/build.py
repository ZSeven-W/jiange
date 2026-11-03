"""Rebuild design/jiange.op from screens.js via the OpenPencil `op` CLI and export previews."""
import json, subprocess, sys
PORT = sys.argv[1] if len(sys.argv) > 1 else "3111"
OP = ["/workspace/openpencil/bin/op", "--port", PORT]
def op(*a):
    r = subprocess.run(OP + list(a), capture_output=True, text=True, check=True)
    return r.stdout
for n in json.loads(op("get", "--depth", "0"))["nodes"]:
    op("delete", n["id"])
op("vars:set", "@vars.json", "--replace")
op("design", "@screens.js")
roots = json.loads(op("get", "--depth", "99"))["nodes"]
fixed = 0
def walk(n):
    global fixed
    if n.get("type") == "text" and n.get("name", "").startswith("c#"):
        want = n["name"][1:]
        if n["fill"][0]["color"].upper() != want.upper():
            op("update", n["id"], json.dumps({"fill": [{"type": "solid", "color": want}]})); fixed += 1
    for c in n.get("children", []) if isinstance(n.get("children"), list) else []:
        walk(c)
for r in roots: walk(r)
names = {"Login": "login", "App · Doc": "app-doc", "App · Presence": "app-presence"}
for r in roots:
    op("export", "--item", r["id"], "--output", f"previews/{names[r['name']]}.png", "--format", "png", "--scale", "1")
op("save_document", "filePath=/workspace/jiange/design/jiange.op")
print("roots", [r["name"] for r in roots], "color fixes", fixed)
