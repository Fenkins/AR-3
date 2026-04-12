# Deployment Success Log

We successfully deployed the AR-1 Research Platform to Vast.ai using the following approach:

## Approach

1. **Instance Selection**: Filtered for an `RTX 3060` instance to keep costs low while ensuring adequate performance.
2. **Onstart Script**: Used the `--onstart-cmd` parameter of the Vast.ai CLI to inject a bootstrap script directly.
3. **Tunneling**: Overcame previous NAT and public URL issues by utilizing Cloudflare Try Tunnels. The startup script installs `cloudflared` and forwards `http://localhost:3001` to a stable, public `trycloudflare.com` URL.

## Exact Deployment Command

If you need to redeploy or bring the project back up strictly from this repository, run the following using the `vastai` CLI (ensure you're authenticated with `vastai set api-key <KEY>`):

```bash
# 1. Find a suitable RTX 3060 instance ID:
vastai search offers "gpu_name=RTX_3060" -o "dph"

# 2. Launch using the chosen ID (e.g. 19958699):
vastai create instance 19958699 \
  --image nvidia/cuda:12.2.0-devel-ubuntu22.04 \
  --disk 50 \
  --label AR-1-Research-Platform \
  --onstart-cmd "curl -fsSL https://raw.githubusercontent.com/Fenkins/AR-1/main/deploy/setup-with-tunnel.sh | bash"
```

## Retrieving the Public URL

Once the instance turns to a `running` state (takes about 5-10 minutes to finish the build inside), you can fetch the public link by SSH-ing into the instance and reading the status file:

```bash
# Assuming the instance IP is <IP> and SSH port is <PORT>
ssh root@<IP> -p <PORT> "cat /tmp/ar1-status.json"
```

The JSON will contain `"public_url"` which allows you to access the dashboard globally.

## Default Credentials
- **Email:** `admin@example.com`
- **Password:** `jkp93p`
