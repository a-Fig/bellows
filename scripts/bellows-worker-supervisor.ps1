# Supervisor for a bellows Windows worker.
# Space-free path so Task Scheduler's `-File` parses cleanly (a bellows dir
# under a path containing spaces — e.g. "...\My Projects\..." — breaks a bare
# -File argument; keep this script, and ideally the checkout itself, on a
# space-free path).
#
# Design: this script IS the supervisor. Its while($true) loop relaunches node
# whenever the worker exits — including a clean self-update exit (see
# src/worker/selfUpdate.mjs + docs/TUTORIAL.md's Worker mode section: an idle
# worker that fast-forwards itself to origin/main calls process.exit(0) on
# purpose so THIS loop relaunches it on the new code) — so the Scheduled Task
# does NOT need (and must not use) action-restart — a task-level RestartCount
# misfires and spawns a second supervisor. The task's only jobs are: start
# this at logon, and keep exactly one instance (MultipleInstances=IgnoreNew).
# Every launch path here is wrapped so nothing can terminate the loop.
#
# Usage: operators pass -BellowsDir pointing at their machine's real bellows
# checkout; the default below is only a generic (deliberately space-free)
# placeholder, e.g.:
#   powershell -File scripts\bellows-worker-supervisor.ps1 -BellowsDir 'D:\work\bellows'

param(
  [string]$BellowsDir = 'C:\bellows'
)

$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath $BellowsDir

# API key value comes only from the environment (never bench.config.json).
# Persisted at User scope via setx; read it explicitly in case this process
# didn't inherit it.
if (-not $env:AGENT_TRIALS_API_KEY) {
  $env:AGENT_TRIALS_API_KEY = [Environment]::GetEnvironmentVariable('AGENT_TRIALS_API_KEY', 'User')
}

while ($true) {
  try {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $out = Join-Path $BellowsDir "worker.$stamp.log"
    $err = Join-Path $BellowsDir "worker.err.$stamp.log"
    $p = Start-Process -FilePath 'node' `
      -ArgumentList 'bin/bellows.mjs','worker','--poll' `
      -WorkingDirectory $BellowsDir `
      -RedirectStandardOutput $out -RedirectStandardError $err `
      -WindowStyle Hidden -PassThru
    Wait-Process -Id $p.Id
    "[supervisor] node exited (code=$($p.ExitCode)) at $(Get-Date -Format o) - restarting in 10s" |
      Out-File -FilePath $err -Append -Encoding utf8
  } catch {
    "[supervisor] launch error at $(Get-Date -Format o): $($_.Exception.Message)" |
      Out-File -FilePath (Join-Path $BellowsDir 'supervisor.err.log') -Append -Encoding utf8
  }
  Start-Sleep -Seconds 10
}
