param(
    [ValidateSet('Setup', 'Start', 'Status', 'Stop', 'Reset')]
    [string]$Action = 'Status',
    [string]$BitcoinBin = 'C:\Program Files\Bitcoin\daemon'
)

$ErrorActionPreference = 'Stop'
$labRoot = Join-Path $PSScriptRoot 'lab-data'
$daemon = Join-Path $BitcoinBin 'bitcoind.exe'
$cli = Join-Path $BitcoinBin 'bitcoin-cli.exe'
$nodes = @(
    @{ Name = 'A'; Rpc = 19443; P2p = 19444 },
    @{ Name = 'B'; Rpc = 19543; P2p = 19544 },
    @{ Name = 'C'; Rpc = 19643; P2p = 19644 }
)

function Get-NodeArgs($node) {
    $dir = Join-Path $labRoot $node.Name
    return @('-regtest', "-datadir=$dir", "-conf=$(Join-Path $dir 'bitcoin.conf')", "-rpcport=$($node.Rpc)")
}

function Invoke-NodeRpc($node, [string[]]$RpcArgs) {
    $baseArgs = Get-NodeArgs $node
    # Capture native stderr without exposing cookie credentials.
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $cli @baseArgs '-rpcclienttimeout=2' @RpcArgs 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $savedPreference
    }
    if ($code -ne 0) { throw "Node $($node.Name): RPC unavailable or rejected ($code). See lab-data/$($node.Name)/regtest/debug.log." }
    return ($output -join "`n")
}

function Get-Chain($node) {
    $chain = (Invoke-NodeRpc $node @('getblockchaininfo')) | ConvertFrom-Json
    if ($chain.chain -ne 'regtest') { throw 'Expected regtest; refusing to continue.' }
    return $chain
}

if (!(Test-Path -LiteralPath $daemon) -or !(Test-Path -LiteralPath $cli)) {
    throw "Bitcoin Core binaries not found in $BitcoinBin"
}

if ($Action -eq 'Reset') {
    $expectedRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'lab-data')).TrimEnd('\')
    $resolvedRoot = [System.IO.Path]::GetFullPath($labRoot).TrimEnd('\')
    if (![string]::Equals($resolvedRoot, $expectedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to reset unexpected path: $resolvedRoot"
    }

    foreach ($node in $nodes) {
        $configPath = Join-Path (Join-Path $labRoot $node.Name) 'bitcoin.conf'
        if (!(Test-Path -LiteralPath $configPath)) { continue }
        try {
            $null = Get-Chain $node
            $null = Invoke-NodeRpc $node @('stop')
            Write-Host "Requested clean shutdown: Node $($node.Name)"
        } catch { }
    }

    $deadline = (Get-Date).AddSeconds(30)
    do {
        $running = 0
        foreach ($node in $nodes) {
            try { $null = Get-Chain $node; $running++ } catch { }
        }
        if ($running -eq 0) { break }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    if ($running -ne 0) { throw 'Node shutdown timed out. Lab data was not deleted.' }

    if (Test-Path -LiteralPath $resolvedRoot) {
        Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
    }

    foreach ($node in $nodes) {
        $dir = Join-Path $labRoot $node.Name
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        $settings = @(
            'regtest=1', 'server=1', 'prune=0', 'dbcache=64',
            'maxmempool=32', 'maxconnections=16', 'rpcthreads=2', 'par=1', 'discover=0',
            'dnsseed=0', 'fixedseeds=0', 'natpmp=0', 'listenonion=0',
            'printtoconsole=0', 'logips=0',
            '[regtest]', 'listen=1', 'connect=0',
            "bind=127.0.0.1:$($node.P2p)", "port=$($node.P2p)",
            'rpcbind=127.0.0.1', 'rpcallowip=127.0.0.1', "rpcport=$($node.Rpc)"
        )
        if ($node.Name -eq 'A') {
            $settings += @('addnode=127.0.0.1:19544', 'addnode=127.0.0.1:19644')
        }
        $settings | Set-Content -LiteralPath (Join-Path $dir 'bitcoin.conf') -Encoding ASCII
    }

    foreach ($node in $nodes) {
        $baseArgs = Get-NodeArgs $node
        $quotedArgs = $baseArgs | ForEach-Object { '"' + $_ + '"' }
        $process = Start-Process -FilePath $daemon -ArgumentList $quotedArgs -WindowStyle Hidden -PassThru
        Write-Host "Started Node $($node.Name), PID $($process.Id)"
    }
    $deadline = (Get-Date).AddSeconds(30)
    do {
        $ready = 0
        foreach ($node in $nodes) {
            try { $null = Get-Chain $node; $ready++ } catch { }
        }
        if ($ready -eq $nodes.Count) { break }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    if ($ready -ne $nodes.Count) { throw 'Reset startup timed out. Inspect each node regtest/debug.log.' }
    foreach ($peerPort in @(19544, 19644)) {
        $null = Invoke-NodeRpc $nodes[0] @('addnode', "127.0.0.1:$peerPort", 'onetry')
    }
    Write-Host 'Reset complete. Blocks, wallets, balances, peer cache, and lab history can now be recreated.'
    exit 0
}

if ($Action -eq 'Setup') {
    foreach ($node in $nodes) {
        $dir = Join-Path $labRoot $node.Name
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        $configPath = Join-Path $dir 'bitcoin.conf'
        if (Test-Path -LiteralPath $configPath) {
            Write-Host "Preserved existing config: $configPath"
            continue
        }
        $settings = @(
            'regtest=1', 'server=1', 'prune=0', 'dbcache=64',
            'maxmempool=32', 'maxconnections=16', 'rpcthreads=2', 'par=1', 'discover=0',
            'dnsseed=0', 'fixedseeds=0', 'natpmp=0', 'listenonion=0',
            'printtoconsole=0', 'logips=0',
            '[regtest]', 'listen=1', 'connect=0',
            "bind=127.0.0.1:$($node.P2p)", "port=$($node.P2p)",
            'rpcbind=127.0.0.1', 'rpcallowip=127.0.0.1', "rpcport=$($node.Rpc)"
        )
        if ($node.Name -eq 'A') {
            $settings += @('addnode=127.0.0.1:19544', 'addnode=127.0.0.1:19644')
        }
        $settings | Set-Content -LiteralPath $configPath -Encoding ASCII
        Write-Host "Created Node $($node.Name): RPC $($node.Rpc), P2P $($node.P2p)"
    }
    exit 0
}

foreach ($node in $nodes) {
    $configPath = Join-Path (Join-Path $labRoot $node.Name) 'bitcoin.conf'
    if (!(Test-Path -LiteralPath $configPath)) { throw 'Run .\lab.ps1 Setup first.' }
}

if ($Action -eq 'Start') {
    foreach ($node in $nodes) {
        $running = $false
        try { $null = Get-Chain $node; $running = $true } catch { }
        if ($running) { Write-Host "Node $($node.Name) already running."; continue }
        $baseArgs = Get-NodeArgs $node
        # Start-Process joins ArgumentList; quote each argument to preserve paths with spaces.
        $quotedArgs = $baseArgs | ForEach-Object { '"' + $_ + '"' }
        $process = Start-Process -FilePath $daemon -ArgumentList $quotedArgs -WindowStyle Hidden -PassThru
        Write-Host "Started Node $($node.Name), PID $($process.Id)"
    }
    $deadline = (Get-Date).AddSeconds(30)
    do {
        $ready = 0
        foreach ($node in $nodes) {
            try { $null = Get-Chain $node; $ready++ } catch { }
        }
        if ($ready -eq $nodes.Count) { break }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    if ($ready -ne $nodes.Count) { throw 'Startup timed out. Inspect each node regtest/debug.log; existing data is preserved.' }
    foreach ($peerPort in @(19544, 19644)) {
        $null = Invoke-NodeRpc $nodes[0] @('addnode', "127.0.0.1:$peerPort", 'onetry')
    }
}

if ($Action -eq 'Stop') {
    foreach ($node in $nodes) {
        $null = Get-Chain $node
        $null = Invoke-NodeRpc $node @('stop')
        Write-Host "Requested clean shutdown: Node $($node.Name)"
    }
    exit 0
}

$rows = foreach ($node in $nodes) {
    $chain = Get-Chain $node
    $network = (Invoke-NodeRpc $node @('getnetworkinfo')) | ConvertFrom-Json
    [pscustomobject]@{
        Node = $node.Name; Chain = $chain.chain; Blocks = $chain.blocks
        Peers = $network.connections; Pruned = $chain.pruned
        RPC = $node.Rpc; P2P = $node.P2p; BestBlock = $chain.bestblockhash
    }
}
$rows | Format-Table -AutoSize
