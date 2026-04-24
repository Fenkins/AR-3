#!/usr/bin/env python3
"""
ODE Research Pipeline Monitor
Watches for Implementation stage execution and detects FAKE experiments.
"""
import subprocess
import time
import re
import json

prev_variant_stage = None
prev_gpu_output = ""

def ssh(cmd):
    result = subprocess.run(
        f"ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -i /tmp/ar3_key -p 39216 root@ssh1.vast.ai '{cmd}'",
        shell=True, capture_output=True, text=True, timeout=30
    )
    return result.stdout + result.stderr

def check_space():
    """Get current Investigation variants from DB."""
    cmd = """node -e "
const { PrismaClient } = require('/opt/AR-3-fresh/node_modules/.prisma/client');
const prisma = new PrismaClient();
prisma.variant.findMany({ 
  where: { spaceId: 'cmoctnyga00032pqmmdshwj46' },
  orderBy: { createdAt: 'asc' },
  select: { id: true, name: true, stageName: true, status: true, cycleNumber: true, grade: true }
})
  .then(v => { console.log(JSON.stringify(v)); prisma.\$disconnect(); })
  .catch(e => { console.error(e.message); prisma.\$disconnect(); });
" """
    out = ssh(cmd.replace('\n', ''))
    try:
        return json.loads(out.split('\n')[-1])
    except:
        return []

def check_gpu_results():
    """Read recent GPU results."""
    try:
        with open('/tmp/gpu_results.json') as f:
            return json.load(f)
    except:
        return {}

def check_gpu_log():
    """Get recent GPU worker log lines."""
    out = ssh("tail -100 /tmp/gpu_worker.log 2>/dev/null | strings")
    return out

def check_nextjs_log():
    """Get recent nextjs log for execution context."""
    out = ssh("strings /tmp/nextjs.log | tail -50")
    return out

def detect_fake(impl_name, gpu_log_text, gpu_results):
    """Detect fake experiment signals."""
    signals = []
    
    gpu_log_lower = gpu_log_text.lower()
    
    # Signal 1: thinking tags in GPU output
    if '<thinking>' in gpu_log_lower or '<analysis>' in gpu_log_lower:
        signals.append("⚠️ <thinking> tags found in GPU log — AI simulating output")
    
    # Signal 2: GPU log mentions model path issues
    if 'repo id must be in the form' in gpu_log_lower or 'invalid' in gpu_log_lower:
        signals.append("⚠️ Invalid model repo ID in GPU log")
    
    # Signal 3: Code uses fake classes instead of real models
    fake_patterns = ['diffusiontextmodel', 'simplediffusionblock', 'fakemodel', 
                     'class diffusion', 'class transformer']
    for pat in fake_patterns:
        if pat in gpu_log_lower:
            signals.append(f"⚠️ Fake class pattern '{pat}' found in GPU log")
    
    # Signal 4: No tensor/metrics output - just text analysis
    if 'tensor' not in gpu_log_lower and 'norm' not in gpu_log_lower and 'loss' not in gpu_log_lower:
        signals.append("⚠️ No tensor/metrics output — possible text-only simulation")
    
    # Signal 5: Implementation generates simulation code
    impl_lower = impl_name.lower()
    if 'simulation' in impl_lower or 'fake' in impl_lower or 'synthetic' in impl_lower:
        signals.append(f"⚠️ Variant name suggests simulation: {impl_name}")
    
    # Signal 6: Check GPU results for very short output (fake)
    for job_id, result in list(gpu_results.items())[:5]:
        if result.get('output', '').__len__() < 200:
            signals.append(f"⚠️ Very short GPU result ({len(result.get('output', ''))} chars) for job {job_id[:8]}...")
    
    return signals

def main():
    global prev_variant_stage, prev_gpu_output
    
    print("🔭 ODE Research Pipeline Monitor — watching for Implementation fakes")
    print("=" * 60)
    
    while True:
        try:
            # Get variant status
            variants = check_space()
            impl_variants = [v for v in variants if v.get('stageName') == 'Implementation']
            
            if impl_variants:
                print(f"\n[{time.strftime('%H:%M:%S')}] Implementation variants running:")
                for v in impl_variants:
                    print(f"  - {v['name']} [{v['status']}]")
                
                # Check GPU log for these variants
                gpu_log = check_gpu_log()
                signals = detect_fake(v['name'], gpu_log, {})
                
                if signals:
                    print("\n🚨 FAKE EXPERIMENT SIGNALS DETECTED:")
                    for s in signals:
                        print(f"   {s}")
                    print("\n   ACTION: Need to update Implementation prompt to require real model loading.")
                else:
                    print(f"   ✓ No fake signals detected so far")
            else:
                inv_variants = [v for v in variants if v.get('stageName') == 'Investigation']
                if inv_variants:
                    print(f"[{time.strftime('%H:%M:%S')}] Investigation: {len(inv_variants)} variant(s), waiting for Implementation stage...")
                else:
                    print(f"[{time.strftime('%H:%M:%S')}] No variants yet, checking setup...")
            
            # Check GPU worker status
            gpu_log = check_gpu_log()
            if 'error' in gpu_log.lower() or 'warning' in gpu_log.lower():
                lines = gpu_log.split('\n')
                issues = [l for l in lines if 'error' in l.lower() or 'warning' in l.lower()][-3:]
                if issues:
                    print(f"   GPU issues: {issues[-1][:80]}")
            
            time.sleep(30)
            
        except KeyboardInterrupt:
            print("\nMonitor stopped.")
            break
        except Exception as e:
            print(f"Error: {e}")
            time.sleep(30)

if __name__ == '__main__':
    main()