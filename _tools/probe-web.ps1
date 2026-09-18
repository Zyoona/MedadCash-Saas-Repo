$r = Invoke-WebRequest -Uri 'http://[::1]:5173/' -UseBasicParsing -TimeoutSec 20
Write-Output ("STATUS: " + $r.StatusCode)
Write-Output ("HEAD: " + $r.Content.Substring(0, 200))
