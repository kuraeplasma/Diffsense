param(
    [string]$Target = "dashboard.html"
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

if ($Target -match '^(https?://|file://)') {
    $destination = $Target
} else {
    $candidate = Join-Path $root $Target
    if (Test-Path $candidate) {
        $destination = $candidate
    } else {
        $destination = "http://localhost:3000/$Target"
    }
}

Start-Process $destination
Write-Output $destination
