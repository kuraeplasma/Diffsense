param(
    [string]$Target = "dashboard.html"
)

if ($Target -match '^(https?://|file://)') {
    $destination = $Target
} else {
    $destination = "http://localhost:3000/$Target"
}

Start-Process $destination
Write-Output $destination
