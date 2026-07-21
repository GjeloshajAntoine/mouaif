Select-String -Path src\web\src\components\Chat.jsx -Pattern '^  (async )?function |^  const \w+ = (async )?\(|^  // ---' |
  ForEach-Object { '{0,6} {1}' -f $_.LineNumber, $_.Line.Trim().Substring(0, [Math]::Min(90, $_.Line.Trim().Length)) }
