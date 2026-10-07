# Antigravity Live Terminal Interceptor Hook for Windows PowerShell
# Paste this into your PowerShell profile ($PROFILE)
# Supports both Windows PowerShell 5.1 and PowerShell 7+

if ($env:ANTIGRAVITY_TRAJECTORY_ID -and -not $env:__AGY_INTERCEPTED) {
    $cmdLineArgs = [System.Environment]::GetCommandLineArgs()
    $cmdIdx = -1
    $isEncoded = $false
    for ($i = 0; $i -lt $cmdLineArgs.Length; $i++) {
        $a = $cmdLineArgs[$i]
        if ($a -ieq '-Command' -or $a -ieq '-c') { $cmdIdx = $i; break }
    }
    if ($cmdIdx -eq -1) {
        for ($i = 0; $i -lt $cmdLineArgs.Length; $i++) {
            $a = $cmdLineArgs[$i]
            if ($a -ieq '-EncodedCommand' -or $a -ieq '-enc' -or $a -ieq '-en') {
                $cmdIdx = $i; $isEncoded = $true; break
            }
        }
    }
    if ($cmdIdx -ge 0 -and ($cmdIdx + 1) -lt $cmdLineArgs.Length) {
        $theCmd = $cmdLineArgs[$cmdIdx + 1]
        if ($isEncoded) {
            $theCmd = [System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String($theCmd))
        }
        $bridgePath = Join-Path $env:USERPROFILE '.antigravity-live\bridge.py'
        if (Test-Path $bridgePath) {
            $env:__AGY_INTERCEPTED = '1'
            $pyExe = 'python'
            foreach ($exe in @('py', 'python', 'python3')) {
                if (Get-Command $exe -ErrorAction SilentlyContinue) { $pyExe = $exe; break }
            }
            $b64 = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($theCmd))
            & $pyExe $bridgePath --base64 $b64
            exit $LASTEXITCODE
        }
    }
}
