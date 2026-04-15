import json
import sys

# Read from the prompt file
with open('/tmp/gpu_job_gpu_727cbedd-af1f-403a-8078-b55815aaaa4b_1776267548179_eia2omnsf/prompt.txt') as f:
    content = f.read()

msgs = json.loads(content)
print(f"Total messages: {len(msgs)}")
last = msgs[-1]
print(f"Last message role: {last['role']}")
content = last['content']
print(f"Content length: {len(content)}")
print(f"First 1500 chars of content:")
print(content[:1500])
