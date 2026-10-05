# Explicit live acceptance run. Never used by Maven/CI; only the owner-approved local sandbox.
param([switch]$RecoveryOnly)
$ErrorActionPreference = 'Stop'
$baseUrl = 'http://127.0.0.1:18081'
$composePath = Join-Path (Split-Path $PSScriptRoot -Parent) 'compose.live-test.yaml'
$runId = [Guid]::NewGuid().ToString('N')
$sessionHash = $null
$created = [System.Collections.Generic.List[string]]::new()

function Assert-Test([bool]$condition, [string]$message) {
    if (-not $condition) { throw $message }
}
function Test-Sql([string]$sql) {
    $result = $sql | & docker compose -p megabot-live-test -f $composePath exec -T db `
        psql -U megabot_live_test_admin -d megabot_live_test -v ON_ERROR_STOP=1 -At
    if ($LASTEXITCODE -ne 0) { throw 'Test database check failed.' }
    return $result
}
function Test-Api([string]$method, [string]$path, $body = $null, [string]$key = '', [int]$expected = 200) {
    $headers = @{ Cookie = "megabot_session=$rawSession"; Origin = $baseUrl }
    if ($key) { $headers['Idempotency-Key'] = $key }
    $request = @{ Uri = ($baseUrl + $path); Method = $method; Headers = $headers; TimeoutSec = 10; SkipHttpErrorCheck = $true }
    if ($null -ne $body) { $request.ContentType = 'application/json'; $request.Body = [Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 8 -Compress)) }
    $response = Invoke-WebRequest @request
    Assert-Test ($response.StatusCode -eq $expected) "Unexpected API status: $($response.StatusCode), expected $expected."
    return @{ Body = ($response.Content | ConvertFrom-Json); Headers = $response.Headers }
}
function New-TestBroadcast([string]$label, [string[]]$recipients, $due = $null, [string]$policy = 'send_late') {
    $body = @{ title = "ТЕСТ MegaBot · $label"; body = "Проверка тестового бота. Рабочие данные не используются. Запуск $runId";
        recipientMode = 'people'; recipientIds = $recipients; dispatchMode = 'now'; silent = $true; misfirePolicy = $policy }
    if ($null -ne $due) {
        $body.dispatchMode = 'scheduled'; $body.scheduledAt = $due.ToString('o'); $body.zoneId = 'Europe/Moscow'
        $body.body += "`nПлановое время (МСК): $($due.ToOffset([TimeSpan]::FromHours(3)).ToString('HH:mm:ss.fff'))"
    }
    $key = "live-$runId-$([Guid]::NewGuid().ToString('N'))"
    $response = Test-Api 'POST' '/api/v1/broadcasts' $body $key 201
    $created.Add($response.Body.id)
    return @{ Response = $response; Request = $body; Key = $key }
}
function Get-TestJournal([string]$id) {
    return @((Test-Api 'GET' "/api/v1/broadcasts/$id/deliveries").Body.items)
}
function Wait-TestSent([string]$id, [int]$count, [DateTimeOffset]$deadline) {
    do {
        $rows = @(Get-TestJournal $id)
        if (@($rows | Where-Object { $_.status -in @('failed','unknown','expired') }).Count) { throw 'Delivery did not finish safely; no manual retry will be attempted.' }
        $sent = @($rows | Where-Object { $_.status -eq 'sent' })
        if ($sent.Count -eq $count) {
            foreach ($row in $sent) {
                Assert-Test ($row.attemptCount -eq 1 -and $row.providerMessageId -gt 0) 'Missing provider proof or duplicate attempt.'
                Assert-Test ([DateTimeOffset]$row.requestStartedAt -ge [DateTimeOffset]$row.intendedAt) 'Delivery started early.'
            }
            $late = @($sent | ForEach-Object { ([DateTimeOffset]$_.requestStartedAt - [DateTimeOffset]$_.intendedAt).TotalMilliseconds })
            Write-Output ([pscustomobject]@{ broadcastId = $id; sent = $sent.Count; maxRequestLatenessMs = [Math]::Round(($late | Measure-Object -Maximum).Maximum, 1) })
            return
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    throw 'Delivery observation timed out; no blind retry.'
}

try {
    $listener = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 18081 -State Listen)
    Assert-Test ($listener.Count -eq 1) 'Expected one local sandbox listener.'
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener[0].OwningProcess)"
    Assert-Test ($process.Name -eq 'java.exe' -and $process.CommandLine.Contains('--spring.profiles.active=live-test') `
        -and $process.CommandLine.Contains('--megabot.delivery.enabled=true') `
        -and $process.CommandLine.Contains('--megabot.integrations.telegram.mode=live')) 'Expected the restricted live-test worker.'
    Assert-Test ((Invoke-RestMethod -Uri "$baseUrl/actuator/health/readiness" -TimeoutSec 5).status -eq 'UP') 'Sandbox not ready.'
    $rawSession = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
    $sessionHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($rawSession))).ToLowerInvariant()
    # Synthetic session fixture, not Telegram Mini App login acceptance. Only its hash reaches the test DB.
    Test-Sql @"
BEGIN;
DO `$`$ BEGIN
 IF current_database()<>'megabot_live_test' OR EXISTS (SELECT 1 FROM users WHERE
   NOT ((id='live_test_wonkersone' AND telegram_id=658274366) OR (id='live_test_earth_dr' AND telegram_id=703359098)))
   OR EXISTS (SELECT 1 FROM notification_deliveries WHERE status IN ('planned','retry','claimed','sending','unknown'))
 THEN RAISE EXCEPTION 'unexpected_test_dataset'; END IF;
END `$`$;
INSERT INTO users(id,telegram_id,username,real_name,role,registered) VALUES
 ('live_test_wonkersone',658274366,'wonkersone','Тестовый администратор','admin',true),
 ('live_test_earth_dr',703359098,'Earth_dr','Тестовый организатор','organizer',true)
 ON CONFLICT(id) DO NOTHING;
INSERT INTO sessions(token_hash,user_id,expires_at) VALUES ('$sessionHash','live_test_wonkersone',clock_timestamp()+interval '30 minutes');
COMMIT;
"@ | Out-Null
    $recipients = @('live_test_wonkersone','live_test_earth_dr')
    if ($RecoveryOnly) {
        $due = [DateTimeOffset]::UtcNow.AddSeconds(40)
        $late = New-TestBroadcast 'после восстановления' @('live_test_wonkersone') $due
        $skip = New-TestBroadcast 'пропустить при опоздании — не должно прийти' @('live_test_earth_dr') $due 'skip'
        foreach ($broadcast in @($late,$skip)) {
            Assert-Test (@(Get-TestJournal $broadcast.Response.Body.id | Where-Object { $_.status -ne 'planned' -or $_.attemptCount -ne 0 }).Count -eq 0) 'Recovery fixture already started.'
        }
        Assert-Test ((Test-Sql "select count(*) from notification_deliveries where status in ('claimed','sending');").Trim() -eq '0') 'Refusing to interrupt an active HTTP attempt.'
        # Abruptly stop only our verified local Java process; PostgreSQL/other apps are untouched.
        $listener = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 18081 -State Listen)
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener[0].OwningProcess)"
        $jarPath = Join-Path $PSScriptRoot 'target/live-test-runtime/megabot-0.0.1-SNAPSHOT.jar'
        Assert-Test ($listener.Count -eq 1 -and $process.Name -eq 'java.exe' -and $process.CommandLine.Contains($jarPath) `
            -and $process.CommandLine.Contains('--spring.profiles.active=live-test')) 'Refusing to stop an unverified process.'
        Stop-Process -Id $process.ProcessId
        Write-Output 'Recovery drill: test Java stopped before due time; database kept running.'
        while ([DateTimeOffset]::UtcNow -lt $due.AddSeconds(8)) { Start-Sleep -Milliseconds 250 }
        $previousJavaHome = $env:JAVA_HOME
        try {
            $env:JAVA_HOME = Split-Path (Split-Path $process.ExecutablePath -Parent) -Parent
            $launcher = Join-Path $PSScriptRoot 'Start-LiveTest.ps1'
            $shellPath = (Get-Process -Id $PID).Path
            Start-Process -FilePath $shellPath -ArgumentList @('-NoProfile','-File',('"'+$launcher+'"'),'-EnableDelivery') `
                -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot "target/live-recovery-startup-$runId.log") `
                -RedirectStandardError (Join-Path $PSScriptRoot "target/live-recovery-startup-errors-$runId.log") | Out-Null
        } finally { $env:JAVA_HOME = $previousJavaHome }
        $startupDeadline = [DateTimeOffset]::UtcNow.AddSeconds(30)
        $ready = $false
        do {
            try { $ready = (Invoke-RestMethod -Uri "$baseUrl/actuator/health/readiness" -TimeoutSec 2).status -eq 'UP' } catch { }
            if (-not $ready) { Start-Sleep -Milliseconds 250 }
        } while (-not $ready -and [DateTimeOffset]::UtcNow -lt $startupDeadline)
        Assert-Test $ready 'Test application did not recover.'
        Wait-TestSent $late.Response.Body.id 1 ([DateTimeOffset]::UtcNow.AddSeconds(25))
        $skipped = @(Get-TestJournal $skip.Response.Body.id)
        Assert-Test ($skipped.Count -eq 1 -and $skipped[0].status -eq 'expired' -and $skipped[0].attemptCount -eq 0) 'Skip policy attempted a late delivery.'
        Write-Output "Recovery PASS; run=$runId; provider-confirmed messages=1; send_late recovered, skip expired without HTTP."
    } else {
        $immediate = New-TestBroadcast 'сейчас' $recipients
        $immediateId = $immediate.Response.Body.id
        Wait-TestSent $immediateId 2 ([DateTimeOffset]::UtcNow.AddSeconds(30))
        $replay = Test-Api 'POST' '/api/v1/broadcasts' $immediate.Request $immediate.Key 201
        Assert-Test ($replay.Body.id -eq $immediateId -and $replay.Headers['Idempotency-Replayed'] -contains 'true') 'Replay did not preserve the original broadcast.'
        $conflicting = $immediate.Request.Clone(); $conflicting.body = 'Different payload must be rejected, not sent.'
        Test-Api 'POST' '/api/v1/broadcasts' $conflicting $immediate.Key 409 | Out-Null
        Assert-Test ((Get-TestJournal $immediateId).Count -eq 2) 'Replay created extra deliveries.'
        Write-Output 'Immediate send, replay and conflicting-key rejection: PASS'

        $due = [DateTimeOffset]::UtcNow.AddSeconds(40)
        $scheduled = New-TestBroadcast 'по расписанию' $recipients $due
        $cancelled = New-TestBroadcast 'отменено — не должно прийти' $recipients $due
        Test-Api 'POST' "/api/v1/broadcasts/$($cancelled.Response.Body.id)/cancel" @{ expectedVersion = $cancelled.Response.Body.version } "live-$runId-cancel" | Out-Null
        Assert-Test (@(Get-TestJournal $scheduled.Response.Body.id | Where-Object { $_.status -ne 'planned' -or $_.attemptCount -ne 0 }).Count -eq 0) 'Scheduled send started before due time.'
        Wait-TestSent $scheduled.Response.Body.id 2 ($due.AddSeconds(25))
        $cancelRows = @(Get-TestJournal $cancelled.Response.Body.id)
        Assert-Test ($cancelRows.Count -eq 2 -and @($cancelRows | Where-Object { $_.status -ne 'cancelled' -or $_.attemptCount -ne 0 }).Count -eq 0) 'Cancelled broadcast attempted delivery.'
        Write-Output 'Scheduled send and cancellation past original due time: PASS'

        $oldDue = [DateTimeOffset]::UtcNow.AddSeconds(40)
        $moved = New-TestBroadcast 'перенос времени' @('live_test_earth_dr') $oldDue
        $newDue = $oldDue.AddSeconds(20)
        $changed = $moved.Request.Clone(); $changed.scheduledAt = $newDue.ToString('o'); $changed.expectedVersion = $moved.Response.Body.version
        $changed.body = "Проверка переноса: отправка должна начаться не раньше $($newDue.ToOffset([TimeSpan]::FromHours(3)).ToString('HH:mm:ss.fff')) МСК. Запуск $runId"
        Test-Api 'PATCH' "/api/v1/broadcasts/$($moved.Response.Body.id)" $changed "live-$runId-move" | Out-Null
        Wait-TestSent $moved.Response.Body.id 1 ($newDue.AddSeconds(25))
        $moveRows = @(Get-TestJournal $moved.Response.Body.id)
        Assert-Test ($moveRows.Count -eq 2 -and @($moveRows | Where-Object { $_.contentRevision -eq 1 -and $_.status -eq 'cancelled' -and $_.attemptCount -eq 0 }).Count -eq 1) 'Old revision was not cancelled.'
        Assert-Test (@($moveRows | Where-Object { $_.status -eq 'sent' -and [DateTimeOffset]$_.requestStartedAt -lt $newDue }).Count -eq 0) 'Moved delivery started before the new due time.'
        Write-Output 'Reschedule, no old-revision send and provider proof: PASS'
        Write-Output "Live acceptance PASS; run=$runId; provider-confirmed messages=5; no phone receipt timing claim."
    }
} catch {
    # Do not expose HTTP request headers, session credentials or provider exception details.
    Write-Output 'Live acceptance FAILED; pending broadcasts will be cancelled, no automatic manual retry.'
    throw 'Live acceptance stopped. Inspect the test DB/journal; secret-bearing exception details suppressed.'
} finally {
    if ($sessionHash) {
        foreach ($id in $created) {
            try {
                $view = (Test-Api 'GET' "/api/v1/broadcasts/$id").Body
                $pending = @(Get-TestJournal $id | Where-Object { $_.status -in @('planned','retry','claimed','sending','unknown') })
                if ($view.lifecycleStatus -eq 'scheduled' -and $pending.Count) { Test-Api 'POST' "/api/v1/broadcasts/$id/cancel" @{ expectedVersion = $view.version } "live-$runId-cleanup-$id" | Out-Null }
            } catch { Write-Output 'A test broadcast could not be cancelled; disable the test worker and inspect its journal.' }
        }
        Test-Sql "UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash='$sessionHash';" | Out-Null
    }
    $rawSession = $null
}
