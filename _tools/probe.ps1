$r = Invoke-WebRequest -Uri 'http://127.0.0.1:5173/' -UseBasicParsing -TimeoutSec 20
Write-Output ("STATUS: " + $r.StatusCode)
Write-Output ("HEAD: " + $r.Content.Substring(0, 200))
$a = Invoke-RestMethod -Uri 'http://localhost:3000/api/health' -TimeoutSec 15
Write-Output ("API: " + ($a | ConvertTo-Json -Compress))
$t = Invoke-RestMethod -Uri 'http://localhost:3000/api/ledger/trial-balance/00000000-0000-4000-8000-000000000001' -TimeoutSec 15
Write-Output ("TRIAL: " + ($t | ConvertTo-Json -Compress))
