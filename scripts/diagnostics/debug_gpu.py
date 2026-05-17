import json
with open('/tmp/gpu_jobs.json') as f:
    d = json.load(f)
# Get most recent completed job
for job in reversed(d):
    if job.get('status') == 'completed':
        prompt = job['prompt']
        # Find the LLM response part
        if '```python' in prompt:
            idx = prompt.rfind('```python')
            print('Last 1000 chars of prompt (from python block):')
            print(prompt[idx:idx+1000])
        break
