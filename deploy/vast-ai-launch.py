#!/usr/bin/env python3
"""
AR-1 Research Platform - Vast.ai Instance Launcher
Launches an RTX 3060 instance on Vast.ai and deploys AR-1 platform
"""

import requests
import json
import time
import sys

API_KEY = "5d2d46bd85397a2196ae40d659cfa52a6efd1e871d1377dd8b0631359115ae1e"
BASE_URL = "https://console.vast.ai/api/v0"

def get_headers():
    return {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
        "Accept": "application/json"
    }

def find_cheapest_3060():
    """Find the cheapest available RTX 3060 instance"""
    print("🔍 Searching for RTX 3060 instances...")
    
    response = requests.get(
        f"{BASE_URL}/search/asks/",
        headers=get_headers(),
        json={
            "q": {
                "gpu_name": {"in": ["GeForce RTX 3060"]},
                "rentable": {"eq": True},
                "rented": {"eq": False}
            },
            "order": [["dph_total", "asc"]],
            "type": "on-demand"
        }
    )
    
    if response.status_code != 200:
        print(f"❌ Failed to search: {response.text}")
        return None
    
    data = response.json()
    offers = data.get("offers", [])
    
    if not offers:
        print("❌ No RTX 3060 instances available")
        return None
    
    # Get cheapest
    cheapest = offers[0]
    print(f"✅ Found RTX 3060: ${cheapest['dph_total']:.3f}/hour")
    print(f"   GPU: {cheapest['gpu_name']}")
    print(f"   VRAM: {cheapest[' gpu_memory ']}GB")
    print(f"   Location: {cheapest.get('geolocation', 'Unknown')}")
    
    return cheapest

def create_instance(offer_id):
    """Create instance from offer"""
    print(f"\n🚀 Creating instance from offer {offer_id}...")
    
    # Read setup script
    with open("deploy/vast-ai-setup.sh", "r") as f:
        setup_script = f.read()
    
    response = requests.post(
        f"{BASE_URL}/instances/create/",
        headers=get_headers(),
        json={
            "client_id": "me",
            "offer_id": offer_id,
            "image": "nvidia/cuda:12.2.0-devel-ubuntu22.04",
            "disk": 50,  # 50GB disk
            "label": "AR-1-Research-Platform",
            "onstart_cmd": setup_script,
            "runtype": "command",
            "args": [
                "bash", "-c",
                "apt-get update && apt-get install -y curl git && " +
                "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && " +
                "apt-get install -y nodejs && " +
                "cd /tmp && " +
                "git clone https://github.com/Fenkins/AR-1.git && " +
                "cd AR-1 && " +
                "npm install && " +
                "npx prisma generate && " +
                "npx prisma db push && " +
                "npm run seed && " +
                "npm run build && " +
                "npm start"
            ],
            "ssh": True,
            "jupyter": False
        }
    )
    
    if response.status_code != 200:
        print(f"❌ Failed to create instance: {response.text}")
        return None
    
    data = response.json()
    print(f"✅ Instance created!")
    print(f"   ID: {data.get('new_contract')}")
    
    return data.get("new_contract")

def wait_for_instance(contract_id, timeout=600):
    """Wait for instance to be ready"""
    print(f"\n⏳ Waiting for instance to be ready (timeout: {timeout}s)...")
    
    start_time = time.time()
    while time.time() - start_time < timeout:
        response = requests.get(
            f"{BASE_URL}/instances/",
            headers=get_headers()
        )
        
        if response.status_code == 200:
            instances = response.json().get("instances", [])
            for inst in instances:
                if inst.get("id") == contract_id:
                    state = inst.get("actual_state", "unknown")
                    print(f"   Status: {state}")
                    
                    if state == "running":
                        ip = inst.get("inet_ip") or inst.get("ssh_ip")
                        port = inst.get("ports", {}).get("3000/tcp", [{}])[0].get("HostPort", 3000)
                        print(f"\n✅ Instance is running!")
                        print(f"   IP: {ip}")
                        print(f"   Port: {port}")
                        print(f"   URL: http://{ip}:{port}")
                        return {"ip": ip, "port": port}
        
        time.sleep(10)
    
    print("❌ Timeout waiting for instance")
    return None

def main():
    print("=" * 60)
    print("AR-1 Research Platform - Vast.ai Deployment")
    print("=" * 60)
    print()
    
    # Find cheapest RTX 3060
    offer = find_cheapest_3060()
    if not offer:
        sys.exit(1)
    
    confirm = input(f"\nLaunch instance at ${offer['dph_total']:.3f}/hour? (y/n): ")
    if confirm.lower() != 'y':
        print("Cancelled")
        sys.exit(0)
    
    # Create instance
    contract_id = create_instance(offer['id'])
    if not contract_id:
        sys.exit(1)
    
    # Wait for ready
    instance_info = wait_for_instance(contract_id)
    if not instance_info:
        sys.exit(1)
    
    print("\n" + "=" * 60)
    print("✅ DEPLOYMENT COMPLETE")
    print("=" * 60)
    print(f"\nAccess AR-1 Platform:")
    print(f"  URL: http://{instance_info['ip']}:{instance_info['port']}")
    print(f"\nAdmin Credentials:")
    print(f"  Email: admin@example.com")
    print(f"  Password: jkp93p")
    print(f"\nManage instance:")
    print(f"  Vast.ai Console: https://console.vast.ai")
    print(f"  Contract ID: {contract_id}")

if __name__ == "__main__":
    main()
