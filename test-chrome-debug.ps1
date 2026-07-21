Start-Sleep -Seconds 3
try {
    $response = Invoke-RestMethod -Uri 'http://127.0.0.1:9222/json/version' -ErrorAction Stop
    $response | ConvertTo-Json
} catch {
    Write-Output "Error: $_"
}
