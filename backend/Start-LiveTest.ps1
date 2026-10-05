param([switch]$EnableDelivery)
$ErrorActionPreference = 'Stop'

# Only the test credential is imported. Production env files and database settings are never loaded.
$credentialPath = Join-Path $PSScriptRoot '.env.test.local'
$tokenLines = @(Get-Content -LiteralPath $credentialPath | Where-Object { $_ -match '^TELEGRAM_BOT_TOKEN=' })
if ($tokenLines.Count -ne 1) { throw 'Expected exactly one test token variable.' }
$testToken = ($tokenLines[0] -split '=', 2)[1].Trim()
if ($testToken -notmatch '^8832831571:[A-Za-z0-9_-]{20,}$') { throw 'Expected the agreed test bot token.' }
try {
    $identity = Invoke-RestMethod -Uri ('https://api.telegram.org/bot' + $testToken + '/getMe') -TimeoutSec 20
} catch { throw 'Test bot identity check failed. Provider details suppressed to protect credentials.' }
if (-not $identity.ok -or $identity.result.id -ne 8832831571 -or $identity.result.username -cne 'test_megaorgi_bot') {
    throw 'Unexpected test bot identity; nothing was started.'
}

$jarPath = Join-Path $PSScriptRoot 'target/megabot-0.0.1-SNAPSHOT.jar'
if (-not (Test-Path -LiteralPath $jarPath -PathType Leaf)) { throw 'Build the backend with Maven verify first.' }
# Windows locks a running jar; keep Maven's build artifact free for repackage/verify.
$runtimeDirectory = Join-Path $PSScriptRoot 'target/live-test-runtime'
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
$runtimeJarPath = Join-Path $runtimeDirectory 'megabot-0.0.1-SNAPSHOT.jar'
Copy-Item -LiteralPath $jarPath -Destination $runtimeJarPath -Force
$javaExecutable = if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME 'bin/java.exe' } else { 'java' }
$composePath = Join-Path (Split-Path $PSScriptRoot -Parent) 'compose.live-test.yaml'
& docker compose -p megabot-live-test -f $composePath up -d --wait
if ($LASTEXITCODE -ne 0) { throw 'Isolated test database did not become ready.' }

$previousToken = $env:TELEGRAM_BOT_TOKEN
try {
    $env:TELEGRAM_BOT_TOKEN = $testToken
    $enabled = if ($EnableDelivery) { 'true' } else { 'false' }
    $mode = if ($EnableDelivery) { 'live' } else { 'disabled' }
    # Explicit arguments outrank inherited environment settings; secrets never go into command-line arguments.
    # Match PowerShell's existing Windows proxy route. No new proxy or production setting is introduced.
    & $javaExecutable '-Xmx384m' '-Djava.net.useSystemProxies=true' '-jar' $runtimeJarPath '--spring.profiles.active=live-test' `
        '--spring.datasource.url=jdbc:postgresql://127.0.0.1:55432/megabot_live_test' `
        '--spring.datasource.username=megabot_live_test_app' '--spring.datasource.password=megabot_live_test_local_only' `
        '--server.address=127.0.0.1' '--server.port=18081' '--megabot.integrations.google.mode=disabled' `
        "--megabot.integrations.telegram.mode=$mode" "--megabot.delivery.enabled=$enabled"
    if ($LASTEXITCODE -ne 0) { throw 'Isolated backend stopped with an error.' }
} finally {
    $env:TELEGRAM_BOT_TOKEN = $previousToken
    $testToken = $null
    $tokenLines = $null
}
