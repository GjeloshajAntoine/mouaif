$chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$userDataDir = "C:\Users\Admin\AppData\Local\Temp\chrome-mcp-profile"
$args = @(
    "--remote-debugging-port=9222",
    "--user-data-dir=`"$userDataDir`"",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--disable-features=WelcomePage,WhatsNew"
)
Start-Process $chromePath -ArgumentList $args
Start-Sleep -Seconds 5
try {
    $response = Invoke-RestMethod -Uri 'http://127.0.0.1:9222/json/version' -ErrorAction Stop
    Write-Output "Chrome debugging server is running:"
    $response | ConvertTo-Json
} catch {
    Write-Output "Failed to connect: $_"
}
