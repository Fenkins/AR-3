#!/usr/bin/env python3
"""
AR-3 Research Platform - Vast.ai Deploy Script (curl-based)
Uses direct VAST.ai API to launch RTX 3060 instance with cloudflared tunnel.
"""
import subprocess, json, time, sys, os, re

API_KEY = "900b73f6045d2c94cf38d0deac1dd5d5f1b5ac12c6a9c523c5f6d13772a2d0d1d"
AR3_REPO = "https://github.com/Fenkins/AR-3.git"
OUTPUT_FILE = "/tmp/AR-3/deploy/active_instance.json"

BASE_URL = "https://console.vast.ai/api/v0"

def api(method, path, data=None):
    cmd = [
        "curl", "-s", "-X", method,
        "-H", f"Authorization: Bearer {API_KEY}",
        "-H", "Content-Type: application/json"
    ]
    url = f"{BASE_URL}{path}"
    if data and method in ("POST", "PUT", "PATCH"):
        cmd += ["-d", json.dumps(data)]
    cmd.append(url)
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        return {"error": r.stderr}
    try:
        return json.loads(r.stdout)
    except:
        return {"raw": r.stdout}

def wait_for_running(contract_id, timeout=360):
    print(f"Waiting for instance {contract_id} to be running (max {timeout}s)...")
    start = time.time()
    while time.time() - start < timeout:
        res = api("GET", f"/instances/{contract_id}/")
        inst = res.get("instance", res)
        if inst and inst.get("status") == "running":
            print(f"  Instance is running!")
            return True
        print(f"  Status: {inst.get('status', 'unknown') if isinstance(inst, dict) else '?'} ...")
        time.sleep(15)
    return False

def get_ssh_details(contract_id):
    res = api("GET", "/instances/")
    instances = res.get("instances", [])
    for inst in instances:
        if str(inst.get("id")) == str(contract_id):
            return inst
    return None

def main():
    print("=" * 60)
    print("AR-3 Deployment - Vast.ai RTX 3060")
    print("=" * 60)

    # Step 1: Check balance
    print("\n[1] Checking account balance...")
    res = api("GET", "/users/current")
    print(f"  Account info: {json.dumps(res, indent=2)[:200]}")

    # Step 2: Search cheapest RTX 3060
    print("\n[2] Searching for cheapest RTX 3060...")
    query = json.dumps({"gpu_name": {"eq": "RTX_3060"}, "rentable": {"eq": True}, "dph_total": {"lt": 0.5}})
    res = api("GET", f"/main/offers?q={query}")
    offers = res.get("offers", [])
    if not offers:
        # Try without price filter
        query2 = json.dumps({"gpu_name": {"eq": "RTX_3060"}, "rentable": {"eq": True}})
        res = api("GET", f"/main/offers?q={query2}")
        offers = res.get("offers", [])
    print(f"  Found {len(offers)} RTX 3060 offers")
    if offers:
        offers.sort(key=lambda x: x.get("dph_total", 999))
        for o in offers[:5]:
            print(f"    ID={o.get('id')}  ${o.get('dph_total')}/hr  {o.get('gpu_name')}  {o.get('inet_up')}/{o.get('inet_down')} Mbps  {o.get('num_gpus')}x")
        best = offers[0]
        offer_id = best["id"]
        price = best.get("dph_total", "?")
        print(f"  Selected: offer_id={offer_id} @ ${price}/hr")
    else:
        print("ERROR: No RTX 3060 offers found!")
        sys.exit(1)

    # Step 3: Create instance
    print(f"\n[3] Creating instance from offer {offer_id}...")
    onstart_cmd = f"""set -e && export DEBIAN_FRONTEND=noninteractive && apt-get update -qq && apt-get install -y -qq curl git nginx python3 python3-pip && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null 2>&1 && apt-get install -y -qq nodejs && cd /opt && git clone {AR3_REPO} /opt/AR-3 && cd /opt/AR-3 && npm install --silent && npx prisma generate && npx prisma db push && npm run build && curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared && cat > /root/start-ar3.sh <<'STARTUP'\n#!/bin/bash\ncd /opt/AR-3\npkill -f "npm start" 2>/dev/null || true; pkill -f "cloudflared" 2>/dev/null || true; sleep 2\nnohup npm start > /tmp/ar3.log 2>&1 &\nsleep 3\nnohup cloudflared tunnel --url http://localhost:3000 > /tmp/tunnel.log 2>&1 &\nsleep 8\ngrep -o 'https://[^ ]*trycloudflare.com' /tmp/tunnel.log | head -1 > /tmp/tunnel_url.txt\necho "AR-3: $(cat /tmp/tunnel_url.txt 2>/dev/null || echo 'tunnel pending')"\nSTARTUP\nchmod +x /root/start-ar3.sh"""
    create_res = api("PUT", f"/asks/{offer_id}/", {
        "image": "nvidia/cuda:12.2.0-devel-ubuntu22.04",
        "runtype": "ssh",
        "disk": 50,
        "label": "AR-3-Research",
        "onstart": onstart_cmd,
        "env": {"DATABASE_URL": "file:./prisma/dev.db"}
    })
    print(f"  Create response: {json.dumps(create_res, indent=2)[:500]}")

    # Extract contract ID
    contract_id = create_res.get("new_contract") or create_res.get("id") or create_res.get("contract_id")
    if not contract_id:
        print(f"  Raw response: {str(create_res)[:300]}")
        print("ERROR: Could not extract contract ID")
        sys.exit(1)
    print(f"  Contract ID: {contract_id}")

    # Step 4: Wait for running
    if not wait_for_running(contract_id, timeout=360):
        print("TIMEOUT waiting for instance!")
        sys.exit(1)

    # Step 5: Get SSH details
    print("\n[4] Getting SSH details...")
    inst = get_ssh_details(contract_id)
    if inst:
        ssh_host = inst.get("ssh_host", f"ssh{contract_id}.vast.ai")
        ssh_port = inst.get("ssh_port", "22")
        print(f"  SSH: ssh -p {ssh_port} root@{ssh_host}")
        print(f"  Instance info: id={inst.get('id')} status={inst.get('status')}")
    else:
        ssh_host = f"ssh{contract_id}.vast.ai"
        ssh_port = "22"
        print(f"  SSH (from contract): ssh -p {ssh_port} root@{ssh_host}")

    # Step 6: Run startup script
    print("\n[5] Running startup script on instance...")
    time.sleep(20)
    ssh_key = os.path.expanduser("~/.ssh/id_ed25519.pub")
    ssh_cmd = f"ssh -o StrictHostKeyChecking=no -o ConnectTimeout=60 -i {ssh_key} -p {ssh_port} root@{ssh_host}"
    r = subprocess.run(f"{ssh_cmd} 'bash /root/start-ar3.sh 2>&1'", shell=True, capture_output=True, text=True)
    if r.returncode == 0:
        print(f"  Startup output: {r.stdout[:300]}")
    else:
        print(f"  SSH may need manual setup: {r.stderr[:200] if r.stderr else 'ok'}")

    # Step 7: Get tunnel URL
    print("\n[6] Getting tunnel URL...")
    tunnel_url = ""
    r = subprocess.run(f"{ssh_cmd} 'cat /tmp/tunnel_url.txt 2>/dev/null || echo not_ready'", shell=True, capture_output=True, text=True)
    if r.returncode == 0:
        tunnel_url = r.stdout.strip()
        print(f"  Tunnel URL: {tunnel_url}")

    # Step 8: Save instance info
    instance_info = {
        "contract_id": str(contract_id),
        "tunnel_url": tunnel_url or "pending",
        "ssh_host": ssh_host,
        "ssh_port": str(ssh_port),
        "ssh_key": ssh_key
    }
    with open(OUTPUT_FILE, "w") as f:
        json.dump(instance_info, f, indent=2)

    print("\n" + "=" * 60)
    print(f"DEPLOYMENT COMPLETE")
    print(f"  Contract ID: {contract_id}")
    print(f"  Tunnel URL: {tunnel_url or 'check /tmp/tunnel_url.txt on instance'}")
    print(f"  SSH: ssh -i {ssh_key} -p {ssh_port} root@{ssh_host}")
    print(f"  Admin UI: {tunnel_url}/ (admin@example.com / jkp93p)")
    print("=" * 60)

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nInterrupted!")
        sys.exit(1)
