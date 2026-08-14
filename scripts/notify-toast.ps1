# Tray balloon notification (NotifyIcon) — more reliable than WinRT toast.
# Reads the answer excerpt (base64 UTF-8) from the NOTIFY_TEXT environment
# variable, which sidesteps command-line escaping of base64 characters.
$excerpt = ''
$encoded = $env:NOTIFY_TEXT
if ($encoded -ne '' -and $encoded -ne $null) {
    try {
        $bytes = [Convert]::FromBase64String($encoded)
        $excerpt = [System.Text.Encoding]::UTF8.GetString($bytes)
    } catch {
        $excerpt = ''
    }
}
if ($excerpt -eq '') {
    $excerpt = 'Answer completed'
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Information
$notify.BalloonTipTitle = 'DeepSeek Harness'
$notify.BalloonTipText = $excerpt
$notify.Visible = $true
$notify.ShowBalloonTip(6000)

Start-Sleep -Seconds 7
$notify.Dispose()
