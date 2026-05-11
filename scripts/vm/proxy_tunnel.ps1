# proxy_tunnel.ps1
# Maintains a persistent SSH reverse SOCKS5 proxy on the VM.
# VM's localhost:1080 routes through this PC's internet connection.
# Run this whenever TradingView needs BlackBull access.

$SSH_KEY = "$env:USERPROFILE\.ssh\id_rsa_oracle"
$VM = "ubuntu@132.145.44.68"

Write-Host "Starting SSH reverse SOCKS5 proxy (VM:1080 -> this PC -> internet)"
Write-Host "Keep this window open while trading. Ctrl+C to stop."
Write-Host ""

while ($true) {
    $ts = Get-Date -Format "HH:mm:ss"
    Write-Host "[$ts] Tunnel up..."
    & ssh -i $SSH_KEY `
        -R 1080 `
        -N `
        -o ServerAliveInterval=20 `
        -o ServerAliveCountMax=3 `
        -o ExitOnForwardFailure=yes `
        -o StrictHostKeyChecking=no `
        $VM
    $ts = Get-Date -Format "HH:mm:ss"
    Write-Host "[$ts] Tunnel dropped. Reconnecting in 5s..."
    Start-Sleep 5
}
