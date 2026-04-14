#!/usr/bin/env python3
"""
AR-1 Research Platform - Vast.ai Instance Launcher
Launches an RTX 3060 instance on Vast.ai and deploys AR-1 platform
Handles public URL detection properly for Vast.ai's port mapping
"""

import requests
import json
import time
import sys
import subprocess
import os
from datetime import datetime

API_KEY = "8a40b921ecdc6af9124f6715fdee718cd046a1b746e8aa40594480030e03d781"
BASE_URL = "https://console.vast.ai"

def get_headers():
    return {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36"
    }

def read_setup_script():
    """Read the setup script from the deploy directory"""
    script_path = os.path.join(os.path.dirname(__file__), "create-instance.sh")
    with open(script_path, "r") as f:
        return f.read()

def find_cheapest_3060():
    """Find the cheapest available RTX 3060 instance"""
    print("🔍 Searching for RTX 3060 instances...")
    
    # Fetch all bundles and filter client-side
    response = requests.post(
        f"{BASE_URL}/api/v0/bundles/",
        headers=get_headers(),
        json={
            "limit": 300,
            "type": "on-demand"
        }
    )
    
    if response.status_code != 200:
        print(f"❌ Failed to search: {response.status_code} - {response.text}")
        return None
    
    data = response.json()
    offers = data.get("offers", [])
    
    # Filter for RTX 3060
    rtx3060 = [o for o in offers if o.get("gpu_name") == "RTX 3060"]
    
    if not rtx3060:
        print("❌ No RTX 3060 instances available")
        return None
    
    # Sort by price
    rtx3060.sort(key=lambda x: x.get("dph_total", 999))
    
    # Get cheapest
    cheapest = rtx3060[0]
    print(f"✅ Found {len(rtx3060)} RTX 3060 offer(s). Cheapest: ${cheapest['dph_total']:.4f}/hour")
    print(f"   GPU: {cheapest['gpu_name']}")
    print(f"   VRAM: {cheapest.get('gpu_total_ram', 'Unknown')}MB")
    print(f"   Location: {cheapest.get('geolocation', 'Unknown')}")
    print(f"   Disk: {cheapest.get('disk_space', 0):.0f}GB")
    print(f"   Reliability: {cheapest.get('reliability', 'N/A'):.2f}")
    
    return cheapest

def create_instance(offer_id):
    """Create instance from offer"""
    print(f"\n🚀 Creating instance from offer {offer_id}...")
    
    setup_script = read_setup_script()
    
    response = requests.put(
        f"{BASE_URL}/api/v0/asks/{offer_id}/",
        headers=get_headers(),
        json={
            "client_id": "me",
            "image": "nvidia/cuda:12.2.0-devel-ubuntu22.04",
            "disk": 50,
            "price": 0.50,
            "env": {},
            "label": "AR-1-Research-Platform",
            "onstart_cmd": setup_script,
            "runtype": "ssh",
            "args": [],
            "ssh": True,
            "jupyter": False
        }
    )
    
    if response.status_code not in [200, 201]:
        print(f"❌ Failed to create instance: {response.status_code} - {response.text}")
        return None
    
    data = response.json()
    print(f"✅ Instance creation initiated!")
    print(f"   Response: {json.dumps(data, indent=2)[:200]}")
    
    return data

def get_instance_info(instance_id):
    """Get detailed info about an instance"""
    response = requests.get(
        f"{BASE_URL}/api/v0/instances/?id={instance_id}",
        headers=get_headers()
    )
    
    if response.status_code != 200:
        return None
    
    data = response.json()
    instances = data.get("instances", [])
    if instances:
        return instances[0]
    return None

def get_public_url(instance):
    """
    Detect the public URL for the Vast.ai instance.
    Vast.ai provides port mapping - we need to check for ports.
    """
    # Check for ssh_port (usually the mapped port)
    ssh_port = instance.get("ssh_port")
    jupyter_port = instance.get("jupyter_port")
    relay_port = instance.get("relay_port")
    
    # Get the public IP
    public_ip = instance.get("inet_ip") or instance.get("public_ipaddr")
    
    # Get container ports
    ports = instance.get("ports", {})
    
    if not public_ip:
        return None, None
    
    # Vast.ai maps ports - 80 and 3000 should be accessible
    # Try to find mapped port for 80 (nginx) or 3000 (direct)
    port_80_mapping = ports.get("80/tcp", [])
    port_3000_mapping = ports.get("3000/tcp", [])
    
    # If we have explicit port mappings, use them
    if port_80_mapping and isinstance(port_80_mapping, list) and len(port_80_mapping) > 0:
        host_port = port_80_mapping[0].get("HostPort", 80)
        if isinstance(host_port, int):
            return f"http://{public_ip}:{host_port}", host_port
    
    if port_3000_mapping and isinstance(port_3000_mapping, list) and len(port_3000_mapping) > 0:
        host_port = port_3000_mapping[0].get("HostPort", 3000)
        if isinstance(host_port, int):
            return f"http://{public_ip}:{host_port}", host_port
    
    # Fallback: Vast.ai instances are typically accessible on the public IP
    # Port 22 is mapped to ssh_port, other ports might be directly accessible
    # Let's try common patterns:
    
    # Try direct port access first (port 80 for nginx)
    return f"http://{public_ip}:80", 80

def wait_for_instance(contract_id, timeout=900):
    """Wait for instance to be ready and get connection info"""
    print(f"\n⏳ Waiting for instance to be ready (timeout: {timeout}s)...")
    print("   This includes OS boot + dependency installation + app deployment")
    
    start_time = time.time()
    last_state = "unknown"
    check_count = 0
    
    while time.time() - start_time < timeout:
        instance = get_instance_info(contract_id)
        
        if instance:
            state = instance.get("actual_state", "unknown")
            check_count += 1
            
            if state != last_state:
                print(f"   [{check_count}] Status: {state}")
                last_state = state
            
            if state == "running":
                # Instance is running, wait a bit for services to start
                print(f"\n   ✅ Instance is running, waiting for services...")
                
                # Wait for deployment to complete
                for i in range(12):  # Check for up to 2 more minutes
                    time.sleep(10)
                    instance = get_instance_info(contract_id)
                    if instance:
                        state = instance.get("actual_state", "unknown")
                        if state != "running":
                            print(f"   ⚠️  State changed to: {state}")
                            break
                        
                        # Check if we can connect
                        public_ip = instance.get("inet_ip") or instance.get("public_ipaddr")
                        if public_ip:
                            # Try to check if nginx is responding
                            try:
                                resp = requests.get(f"http://{public_ip}:80", timeout=3)
                                if resp.status_code == 200:
                                    print(f"   ✅ Application is responding!")
                                    break
                            except:
                                pass
                    
                    elapsed = int(time.time() - start_time)
                    print(f"   ...waiting ({elapsed}s elapsed)")
                
                # Get the public URL
                url, port = get_public_url(instance)
                
                if url:
                    print(f"\n✅ Instance is ready!")
                    print(f"   Public IP: {instance.get('inet_ip') or instance.get('public_ipaddr')}")
                    print(f"   SSH Port: {instance.get('ssh_port', 'N/A')}")
                    print(f"   URL: {url}")
                    
                    return {
                        "ip": instance.get('inet_ip') or instance.get('public_ipaddr'),
                        "ssh_port": instance.get('ssh_port'),
                        "url": url,
                        "port": port,
                        "instance": instance
                    }
                else:
                    print(f"   ⚠️  Could not determine public URL")
                    return {
                        "ip": instance.get('inet_ip') or instance.get('public_ipaddr'),
                        "ssh_port": instance.get('ssh_port'),
                        "url": None,
                        "port": None,
                        "instance": instance
                    }
        else:
            if check_count % 3 == 0:
                print(f"   [{check_count}] Waiting for instance to appear...")
        
        time.sleep(10)
    
    print(f"\n❌ Timeout waiting for instance after {timeout}s")
    return None

def test_connection(url):
    """Test if the application is responding"""
    if not url:
        return False
    
    try:
        print(f"\n🧪 Testing connection to {url}...")
        resp = requests.get(url, timeout=10)
        if resp.status_code == 200:
            print(f"   ✅ Application is responding (status: {resp.status_code})")
            return True
        else:
            print(f"   ⚠️  Got status {resp.status_code}")
            return False
    except Exception as e:
        print(f"   ❌ Connection failed: {e}")
        return False

def main():
    print("=" * 70)
    print("AR-1 Research Platform - Vast.ai Deployment")
    print("=" * 70)
    print(f"Started at: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print()
    
    # Find cheapest RTX 3060
    offer = find_cheapest_3060()
    if not offer:
        sys.exit(1)
    
    price = offer['dph_total']
    gpu_ram = offer.get('gpu_total_ram', 'Unknown')
    
    print(f"\nInstance Details:")
    print(f"  GPU: {offer['gpu_name']} ({gpu_ram}MB VRAM)")
    print(f"  Price: ${price:.4f}/hour (${price*24:.2f}/day)")
    print(f"  Location: {offer.get('geolocation', 'Unknown')}")
    print()
    
    # Create instance
    result = create_instance(offer['id'])
    if not result:
        print("❌ Failed to create instance")
        sys.exit(1)
    
    # Get contract ID from response
    # Vast.ai API returns different formats
    contract_id = result.get("new_contract") or result.get("id") or result.get("contract_id")
    
    if not contract_id:
        print(f"❌ Could not determine contract ID from response: {json.dumps(result)[:200]}")
        sys.exit(1)
    
    print(f"   Contract ID: {contract_id}")
    
    # Wait for ready
    instance_info = wait_for_instance(contract_id)
    if not instance_info:
        print("\n❌ Instance setup failed or timed out")
        sys.exit(1)
    
    # Test connection
    url = instance_info.get('url')
    if url:
        test_connection(url)
    
    print("\n" + "=" * 70)
    print("✅ DEPLOYMENT COMPLETE")
    print("=" * 70)
    print(f"\nAccess AR-1 Platform:")
    if url:
        print(f"  URL: {url}")
    else:
        ip = instance_info.get('ip')
        ssh_port = instance_info.get('ssh_port')
        print(f"  IP: {ip}")
        print(f"  SSH: ssh root@{ip} -p {ssh_port}")
        print(f"  Try: http://{ip}:80 or http://{ip}:3000")
    
    print(f"\nAdmin Credentials:")
    print(f"  Email: admin@example.com")
    print(f"  Password: jkp93p")
    print(f"  ⚠️  CHANGE THESE IMMEDIATELY AFTER LOGIN!")
    
    print(f"\nManage instance:")
    print(f"  Vast.ai Console: https://console.vast.ai")
    print(f"  Contract ID: {contract_id}")
    
    print(f"\nSSH Access:")
    ip = instance_info.get('ip')
    ssh_port = instance_info.get('ssh_port')
    if ip and ssh_port:
        print(f"  ssh root@{ip} -p {ssh_port}")
    
    print("\n" + "=" * 70)

if __name__ == "__main__":
    main()
