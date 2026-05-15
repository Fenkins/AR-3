#!/usr/bin/env python3
"""
AR-3 Research Platform - Vast.ai Instance Launcher v4
Uses vastai CLI for reliable instance management with SSH key and cloudflared tunnel.
"""

import subprocess
import json
import time
import sys
import os
import re
import argparse

SSH_KEY_PATH = os.path.expanduser("~/.ssh/id_ed25519.pub")
AR3_REPO = "https://github.com/Fenkins/AR-3.git"
ACTIVE_INSTANCE_FILE = os.path.join(os.path.dirname(__file__), "active_instance.json")
AR3_LABEL_MARKERS = ("AR-3", "AR3", "AR-3-Research")
SETUP_SCRIPT = """
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git nginx python3 python3-pip > /dev/null 2>&1
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null 2>&1
apt-get install -y -qq nodejs > /dev/null 2>&1

cd /opt
if [ ! -d AR-3 ]; then
    git clone {repo} /opt/AR-3
fi
cd /opt/AR-3
npm install --silent
npx prisma generate
npx prisma db push
npm run build

# Install cloudflared tunnel
curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared

# Create startup script
cat > /root/start-ar3.sh <<'STARTUP'
#!/bin/bash
cd /opt/AR-3
pkill -f "npm start" 2>/dev/null || true
pkill -f "cloudflared" 2>/dev/null || true
sleep 2
nohup npm start > /tmp/ar3.log 2>&1 &
sleep 3
nohup cloudflared tunnel --url http://localhost:3000 > /tmp/tunnel.log 2>&1 &
sleep 8
grep -o 'https://[^ ]*trycloudflare.com' /tmp/tunnel.log | head -1 > /tmp/tunnel_url.txt
echo "AR-3 started. Tunnel URL: $(cat /tmp/tunnel_url.txt)"
STARTUP
chmod +x /root/start-ar3.sh
echo "Setup complete"
"""

def get_api_key():
    api_key = os.environ.get("VAST_API_KEY", "").strip()
    if not api_key:
        print("ERROR: VAST_API_KEY environment variable is required")
        sys.exit(1)
    return api_key

def runvast(args, check=True):
    cmd = f"vastai --api-key {get_api_key()} {args}"
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if check and r.returncode != 0:
        print(f"FAILED: vastai {args}")
        print(r.stderr)
        sys.exit(1)
    return r.stdout

def load_recorded_instance():
    try:
        with open(ACTIVE_INSTANCE_FILE, "r") as f:
            data = json.load(f)
        if str(data.get("status", "")).lower() in {"running", "loading", "starting", "rented"}:
            return data
    except FileNotFoundError:
        return None
    except Exception as exc:
        print(f"WARNING: Could not read active instance record: {exc}")
    return None

def parse_instances(raw):
    try:
        data = json.loads(raw)
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            for key in ("instances", "contracts"):
                if isinstance(data.get(key), list):
                    return data[key]
    except Exception:
        pass
    instances = []
    for line in raw.splitlines():
        if any(marker in line for marker in AR3_LABEL_MARKERS):
            parts = line.split()
            instance_id = next((part for part in parts if part.isdigit()), "")
            instances.append({"id": instance_id, "label": line, "status": line})
    return instances

def get_active_ar3_instances():
    raw = runvast("show instances --raw", check=False) or runvast("show instances", check=False)
    active_statuses = {"running", "loading", "starting", "rented", "offline", "stopped"}
    active = []
    for inst in parse_instances(raw):
        label = str(inst.get("label") or inst.get("name") or inst.get("image_uuid") or "")
        status = str(inst.get("actual_status") or inst.get("status") or inst.get("cur_state") or "").lower()
        instance_id = str(inst.get("id") or inst.get("contract_id") or inst.get("instance_id") or "")
        if not any(marker.lower() in label.lower() for marker in AR3_LABEL_MARKERS):
            continue
        if status and not any(state in status for state in active_statuses):
            continue
        active.append({"id": instance_id, "label": label, "status": status or "unknown"})
    return active

def enforce_single_instance(replace=False):
    active = get_active_ar3_instances()
    recorded = load_recorded_instance()
    if recorded and not any(str(item.get("id")) == str(recorded.get("instance_id") or recorded.get("contract_id")) for item in active):
        active.append({
            "id": str(recorded.get("instance_id") or recorded.get("contract_id") or ""),
            "label": "recorded active_instance.json",
            "status": str(recorded.get("status") or "recorded"),
        })
    if active and not replace:
        print("ERROR: Refusing to create another AR-3 Vast.ai instance.")
        print("Active/recorded instance(s):")
        for item in active:
            print(f"  id={item.get('id') or '?'} status={item.get('status')} label={item.get('label')}")
        print("Use --replace only after intentionally stopping/destroying the existing instance.")
        sys.exit(1)
    if active and replace:
        print("WARNING: --replace was provided; launcher will continue despite recorded active instance(s).")
        for item in active:
            print(f"  existing id={item.get('id') or '?'} status={item.get('status')} label={item.get('label')}")

def wait_for_running(contract_id, timeout=300):
    print(f"Waiting for instance {contract_id} to be running...")
    start = time.time()
    while time.time() - start < timeout:
        out = runvast(f"show instances", check=False)
        for line in out.split("\n"):
            if str(contract_id) in line:
                if "running" in line.lower():
                    print(f"  Instance is running!")
                    return True
                elif "loading" in line.lower():
                    print(f"  still loading...")
                elif "stopped" in line.lower():
                    print(f"  stopped, attempting start...")
                    runvast(f"start instance {contract_id}")
        time.sleep(15)
    return False

def main():
    parser = argparse.ArgumentParser(description="Launch one AR-3 Vast.ai instance.")
    parser.add_argument("--replace", action="store_true", help="Allow launch when an AR-3 instance is already recorded/running.")
    parser.add_argument("--dry-run", action="store_true", help="Select an offer but do not rent it.")
    args = parser.parse_args()

    print("=" * 60)
    print("AR-3 Deployment - Vast.ai (v4)")
    print("=" * 60)
    enforce_single_instance(replace=args.replace)

    # Step 1: Find cheapest RTX 3060
    print("\n[1] Searching for RTX 3060...")
    out = runvast("search offers gpu_name==RTX_3060 --full")
    lines = [l for l in out.split("\n") if "RTX_3060" in l]
    if not lines:
        print("No RTX 3060 found!")
        sys.exit(1)

    # Parse first offer ID
    parts = lines[0].split()
    if len(parts) < 2:
        print(f"Cannot parse offer: {lines[0]}")
        sys.exit(1)
    offer_id = parts[1]
    print(f"  Found offer: {offer_id}")
    if args.dry_run:
        print("Dry run complete; no instance created.")
        return

    # Step 2: Create instance
    print(f"\n[2] Creating instance from offer {offer_id}...")
    # Use a simple onstart that installs cloudflared and clones repo
    onstart_cmd = SETUP_SCRIPT.format(repo=AR3_REPO)
    out = runvast(f'create instance {offer_id} --image "nvidia/cuda:12.2.0-devel-ubuntu22.04" --disk 50 --label "AR-3-Research" --ssh --onstart-cmd "{onstart_cmd}"')
    print(f"  {out[:200]}")

    # Extract contract ID
    m = re.search(r'"new_contract":\s*(\d+)', out)
    if not m:
        print(f"Cannot find contract ID in response: {out}")
        sys.exit(1)
    contract_id = m.group(1)
    print(f"  Contract ID: {contract_id}")

    # Step 3: Wait for running
    if not wait_for_running(contract_id):
        print("TIMEOUT waiting for instance!")
        sys.exit(1)

    # Step 4: Attach SSH key
    print(f"\n[3] Attaching SSH key...")
    ssh_pub_key = open(SSH_KEY_PATH).read().strip()
    out = runvast(f'attach ssh {contract_id} "{ssh_pub_key}"')
    print(f"  {out[:100]}")

    # Step 5: Reboot for SSH key to take effect
    print(f"\n[4] Rebooting for SSH key...")
    runvast(f"reboot instance {contract_id}")
    time.sleep(30)
    wait_for_running(contract_id)

    # Step 6: Get SSH details
    print(f"\n[5] Getting SSH details...")
    out = runvast(f"show instances")
    for line in out.split("\n"):
        if str(contract_id) in line:
            parts = line.split()
            ssh_host = None
            ssh_port = None
            # Parse from the SSH row
            pass
    print(f"  Instance: {contract_id}")
    print(f"  SSH: ssh root@ssh7.vast.ai -p <port> (check vast.ai console)")

    # Step 7: Run setup and start AR-3
    print(f"\n[6] Running AR-3 setup and starting platform...")
    ssh_cmd = f"ssh -o StrictHostKeyChecking=no -i {SSH_KEY_PATH}"
    # Get SSH port from instance info
    # For now, just tell user to SSH in and run /root/start-ar3.sh
    print(f"  SSH into the instance and run: /root/start-ar3.sh")
    print(f"  Or manually: cd /opt/AR-3 && nohup npm start &")

    print("\n" + "=" * 60)
    print(f"✅ DEPLOYMENT READY")
    print(f"   Contract: {contract_id}")
    print("=" * 60)

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\nInterrupted!")
        sys.exit(1)
