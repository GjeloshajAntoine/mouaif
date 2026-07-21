$chrome = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
$profile = "$env:TEMP\mouaif-chrome-debug-profile"
$args = @(
  '--remote-debugging-port=9222',
  "--user-data-dir=$profile",
  '--no-first-run',
  '--no-default-browser-check',
  '--remote-allow-origins=*',
  'http://127.0.0.1:5732/web/'
)
Start-Process -FilePath $chrome -ArgumentList $args
Start-Sleep -Seconds 3
try {
  $v = Invoke-RestMethod -Uri 'http://127.0.0.1:9222/json/version' -TimeoutSec 5
  Write-Output "OK $($v.Browser)"
} catch {
  Write-Output "FAILED: $($_.Exception.Message)"
}
