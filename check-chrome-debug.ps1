Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*remote-debugging*' } | Select-Object ProcessId, CommandLine | Format-List
