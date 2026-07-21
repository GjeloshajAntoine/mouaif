$chrome = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe' -ErrorAction SilentlyContinue
if ($chrome) {
    $chrome.'(Default)'
} else {
    $chrome32 = Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe' -ErrorAction SilentlyContinue
    if ($chrome32) {
        $chrome32.'(Default)'
    } else {
        Write-Output "Chrome not found in registry"
    }
}
