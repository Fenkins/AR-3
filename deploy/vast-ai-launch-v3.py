#!/usr/bin/env python3
"""
AR-1 Research Platform - Vast.ai Instance Launcher (Simplified)
Launches an RTX 3060 instance on Vast.ai and deploys AR-1 platform
"""

import requests
import json
import time
import sys
import os
from datetime import datetime

API_KEY = "8a40b921ecdc6af9124f6715fdee718cd046a1b746e8aa40594480030e03d781"
BASE_URL = "https://console.vast.ai"
CONTRACT_ID = None

def get_headers():
    return {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
        "Accept": "application/json"
    }

def read_setup_script():
    script_path = os.path.join(os.path.dirname(__file__), "create-instance.sh")
    if os.path.exists(script_path):
        with open(script_path, "r") as f:
            return f.read()
    # Fallback inline script
    return """#!/bin/bash
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq curl git > /dev/null 2>&1
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null 2>&1
apt-get install -y -qq nodejs > /dev/null 2>&1
cd /opt && git clone https://github.com/Fenkins/AR-1.git && cd /opt/AR-1
npm install --silent
npx prisma generate && npx prisma db push && npm run seed
npm run build
# Start with nginx on port 80 proxying to 3000
npm start &
sleep 5
echo "Deployment complete at $(date)"
"""

def find_cheapest_3060():
    print("🔍 Searching for RTX 3060 instances...")
    response = requests.post(f"{BASE_URL}/api/v0/bundles/", headers=get_headers(), json={"limit": 300})
    if response.status_code != 200:
        print(f"❌ Search failed: {response.status_code}")
        return None
    offers = response.json().get("offers", [])
    rtx3060 = sorted([o for o in offers if o.get("gpu_name") == "RTX 3060"], key=lambda x: x["dph_total"])
    if not rtx3060:
        print("❌ No RTX 3060 available")
        return None
    cheapest = rtx3060[0]
    print(f"✅ Found: ${cheapest['dph_total']:.4f}/hr - {cheapest.get('geolocation','?')}")
    return cheapest

def create_instance(offer_id):
    print(f"🚀 Creating instance from offer {offer_id}...")
    setup_script = read_setup_script()
    response = requests.put(f"{BASE_URL}/api/v0/asks/{offer_id}/", headers=get_headers(), json={
        "client_id": "me",
        "image": "nvidia/cuda:12.2.0-devel-ubuntu22.04",
        "disk": 50,
        "price": 0.50,
        "label": "AR-1-Research-Platform",
        "onstart_cmd": setup_script,
        "runtype": "ssh",
        "ssh": True
    })
    result = response.json()
    contract_id = result.get("new_contract")
    print(f"   Contract ID: {contract_id}")
    print(f"   Response: {json.dumps(result)[:150]}")
    return contract_id

def wait_for_instance(contract_id, timeout=600):
    print(f"⏳ Waiting for instance {contract_id}...")
    start = time.time()
    while time.time() - start < timeout:
        resp = requests.get(f"{BASE_URL}/api/v0/instances/?id={contract_id}", headers=get_headers())
        if resp.status_code == 200:
            instances = resp.json().get("instances", [])
            if instances:
                inst = instances[0]
                state = inst.get("actual_state", "unknown")
                print(f"   Status: {state}")
                if state == "running":
                    time.sleep(30)  # Wait for setup script
                    ip = inst.get("inet_ip") or inst.get("public_ipaddr")
                    ssh_port = inst.get("ssh_port")
                    ports = inst.get("ports", {})
                    # Get mapped port 80
                    port80 = ports.get("80/tcp", [{}])[0].get("HostPort", 80) if isinstance(ports.get("80/tcp"), list) else 80
                    url = f"http://{ip}:{port80}" if ip else None
                    return {"ip": ip, "ssh_port": ssh_port, "url": url, "instance": inst}
        time.sleep(15)
    print("❌ Timeout")
    return None

def destroy_instance(contract_id):
    """Destroy an instance"""
    print(f"Destroying instance {contract_id}...")
    resp = requests.put(f"{BASE_URL}/api/v0/instances/{contract_id}/", headers=get_headers(), json={"op": "destroy"})
    print(f"   Result: {resp.json()}")

def main():
    global CONTRACT_ID
    print("=" * 60)
    print("AR-1 Deployment - Vast.ai")
    print("=" * 60)
    
    offer = find_cheapest_3060()
    if not offer:
        sys.exit(1)
    
    print(f"\nGPU: {offer['gpu_name']} | ${offer['dph_total']:.4f}/hr | {offer.get('geolocation','?')}")
    print(f"Starting deployment...\n")
    
    contract_id = create_instance(offer['id'])
    if not contract_id:
        print("❌ Failed to create instance")
        sys.exit(1)
    
    CONTRACT_ID = contract_id
    
    info = wait_for_instance(contract_id)
    if not info:
        print("\n⚠️  Instance may still be starting. Check Vast.ai console.")
        print(f"   Contract: {contract_id}")
        sys.exit(1)
    
    print("\n" + "=" * 60)
    print("✅ DEPLOYMENT COMPLETE")
    print("=" * 60)
    print(f"URL: {info['url']}")
    print(f"SSH: ssh root@{info['ip']} -p {info['ssh_port']}")
    print(f"Admin: admin@example.com / jkp93p")
    print(f"Contract: {contract_id}")

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\n⚠️  Interrupted!")
        if CONTRACT_ID:
            print(f"Instance {CONTRACT_ID} may still be running. Destroy it manually or run cleanup.")
        sys.exit(1)
