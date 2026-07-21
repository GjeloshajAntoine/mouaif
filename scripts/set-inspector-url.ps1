$body = @{ url = 'http://127.0.0.1:9222' } | ConvertTo-Json
$r = Invoke-RestMethod -Uri 'http://127.0.0.1:5732/api/inspector/config' -Method Put -ContentType 'application/json' -Body $body
$r | ConvertTo-Json -Compress
$t = Invoke-RestMethod -Uri 'http://127.0.0.1:5732/api/inspector/targets' -TimeoutSec 10
$t | ConvertTo-Json -Depth 4
