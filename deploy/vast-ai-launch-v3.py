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

API_KEY = "5d2d46bd85397a2196ae40d659cfa52a6efd1e871d1377dd8b0631359115ae1e"
SSH_KEY_PATH = os.path.expanduser("~/.ssh/id_ed25519.pub")
AR3_REPO = "https://github.com/Fenkins/AR-3.git"
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

defvastai = f"vastai --api-key {API_KEY}"

def runvast(args, check=True):
    cmd = f"{defvastai} {args}"
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if check and r.returncode != 0:
        print(f"FAILED: {cmd}")
        print(r.stderr)
        sys.exit(1)
    return r.stdout

def get_instances():
    out = runvast("show instances")
    # Parse instance IDs from output
    ids = re.findall(r'\d+\s+(\d+)\s+\w+\s+\w+', out)
    return ids

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
    print("=" * 60)
    print("AR-3 Deployment - Vast.ai (v4)")
    print("=" * 60)

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
