# ============================================================
#  مداد — مشغّل سطح المكتب (بدون نوافذ سوداء)
#  يُشغَّل عبر اختصار .lnk:
#    Target:    powershell.exe
#    Arguments: -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "<root>\_tools\desktop-launch.ps1"
#    WindowStyle: 7 (مصغّر بدون تفعيل) — يمنع ومضة النافذة السوداء
#
#  التسلسل: splash أولاً (تفتح في المتصفح فوراً) → تهيئة خفيفة → PG →
#  .env → migrations (بصمة) → API+Web بالتوازي عبر CreateNoWindow
#  (الخادمان بلا أي نافذة console — لا ومضة ولا أيقونة في شريط المهام ولا تجمّد للجلسة الأم).
#
#  قاعدة VBS: لا نستخدم VBS للإخفاء إطلاقاً، ولا `start "" /min`
#  (الـ /min يترك نافذة مصغّرة مرئية في شريط المهام).
#  المنهج الوحيد: powershell -WindowStyle Hidden + ProcessStartInfo.CreateNoWindow.
# ============================================================
#Requires -Version 5.1

$ErrorActionPreference = 'Continue'

# ---------- 0) المسارات (مشتقة من موقع السكربت — يعمل من أي قرص/مسار) ----------
$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$logs = Join-Path $root '_tools\logs'
if (-not (Test-Path -LiteralPath $logs)) { New-Item -ItemType Directory -Path $logs | Out-Null }

$nodeExe = Join-Path $root '_tools\node\node.exe'
$pgTool = Join-Path $root '_tools\pg-run.js'
$splashTool = Join-Path $root '_tools\splash-server.js'

# Node المجمّع أولاً (قاعدة VBS: تحقق من الحجم قبل التشغيل — 0 بايت = تالف/مُفرَّغ)
$env:Path = (Join-Path $root '_tools\node') + ';' + $env:Path
Set-Location -LiteralPath $root

function Write-Log([string]$name, [string]$text) {
  try { Add-Content -LiteralPath (Join-Path $logs $name) -Value $text -Encoding UTF8 } catch {}
}

function Trim-Log([string]$name) {
  try {
    $f = Join-Path $logs $name
    if ((Test-Path -LiteralPath $f) -and ((Get-Item -LiteralPath $f).Length -gt 4MB)) {
      Remove-Item -LiteralPath $f -Force
    }
  } catch {}
}

function Test-ExeOk([string]$path, [long]$minBytes) {
  try {
    $it = Get-Item -LiteralPath $path -ErrorAction Stop
    return ($it.Length -ge $minBytes)
  } catch { return $false }
}

function Test-PortOpen([int]$port, [int]$timeoutMs = 1500) {
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $ar = $c.BeginConnect('127.0.0.1', $port, $null, $null)
    if ($ar.AsyncWaitHandle.WaitOne($timeoutMs, $false) -and $c.Connected) { return $true }
    return $false
  } catch { return $false } finally { try { $c.Close() } catch {} }
}

function Wait-ForPort([int]$port, [string]$label, [int]$tries, [int]$everyMs) {
  for ($k = 0; $k -lt $tries; $k++) {
    if (Test-PortOpen $port) { Write-Log 'launch.log' ("[{0}] {1} up (:{2})" -f (Get-Date -Format 'HH:mm:ss'), $label, $port); return $true }
    Start-Sleep -Milliseconds $everyMs
  }
  Write-Log 'launch.log' ("[{0}] {1} TIMEOUT (:{2})" -f (Get-Date -Format 'HH:mm:ss'), $label, $port)
  return $false
}

# بدء عملية خلفية بلا أي نافذة (المنهج المعتمد — لا VBS ولا start /min):
# System.Diagnostics.Process مع CreateNoWindow + WindowStyle.Hidden لا يُنشئ
# أي نافذة console أصلاً — لا ومضة، ولا زر في شريط المهام، ولا نافذة مصغّرة.
# (start "" /min ممنوع: يترك نافذة cmd مصغّرة ظاهرة في الشريط.)
Add-Type -AssemblyName System.Windows.Forms | Out-Null
function Start-Hidden([string]$command, [string]$logName) {
  $logPath = Join-Path $logs $logName
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "$env:ComSpec"
  $psi.Arguments = '/d /s /c "{0} >> ""{1}"" 2>&1"' -f $command, $logPath
  $psi.WorkingDirectory = $root
  $psi.CreateNoWindow = $true
  $psi.UseShellExecute = $false
  $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $p = [System.Diagnostics.Process]::Start($psi)
  return $p
}

Write-Log 'launch.log' ("[{0}] === launch ===" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
@('api.log', 'web.log', 'splash.log', 'migrate.log', 'pg-start.log', 'launch.log') | ForEach-Object { Trim-Log $_ }

# ---------- 1) فحص الثنائيات الحرجة قبل أي شيء (قاعدة الحجم — 0 بايت = تالف/مُفرَّغ من Defender) ----------
$npmCli = Join-Path $root '_tools\node\node_modules\npm\bin\npm-cli.js'
$esbuildDir = Join-Path $root 'node_modules\@esbuild\win32-x64'
$esbuildBin = Join-Path $esbuildDir 'esbuild.exe'
$ok = $true
if (-not (Test-ExeOk $nodeExe 50MB))   { Write-Log 'launch.log' 'node.exe missing or gutted (<50MB) — run Fix_Defender.bat, then npm install.'; $ok = $false }
if (-not (Test-Path -LiteralPath $npmCli)) { Write-Log 'launch.log' 'npm-cli.js missing — _tools\node is incomplete, reinstall it.'; $ok = $false }
if (-not (Test-ExeOk $esbuildBin 1MB)) {
  Write-Log 'launch.log' 'esbuild binary missing or gutted — reinstalling optional platform package...'
  try { Remove-Item -LiteralPath $esbuildDir -Recurse -Force -ErrorAction Stop } catch {}
  & $env:ComSpec /d /s /c "npm install @esbuild/win32-x64@0.21.5 --no-save --offline >> ""$logs\prisma.log"" 2>&1"
  if (-not (Test-Path -LiteralPath $esbuildBin)) {
    $found = Get-ChildItem -LiteralPath $esbuildDir -Recurse -Filter 'esbuild.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) {
      try {
        New-Item -ItemType Directory -Path (Split-Path -Parent $esbuildBin) -Force | Out-Null
        Copy-Item -LiteralPath $found.FullName -Destination $esbuildBin -Force
      } catch {}
    }
  }
  if (-not (Test-ExeOk $esbuildBin 1MB)) {
    Write-Log 'launch.log' 'esbuild still broken after reinstall — run Fix_Defender.bat first (Defender deletes it).'
    $ok = $false
  }
}
if (-not $ok) { exit 1 }

# ---------- 2) Splash أولاً + فتح المتصفح فوراً ----------
if (-not (Test-PortOpen 5199)) {
  Start-Hidden 'node _tools\splash-server.js' 'splash.log' | Out-Null
}
Wait-ForPort 5199 'splash' 20 500 | Out-Null
if (Test-PortOpen 5199) {
  Start-Process 'http://127.0.0.1:5199/' | Out-Null
}

# ---------- 3) shared-types dist إن غاب ----------
if (-not (Test-Path -LiteralPath (Join-Path $root 'packages\shared-types\dist\index.js'))) {
  & $env:ComSpec /d /s /c "npm run build -w packages/shared-types >> ""$logs\shared-types.log"" 2>&1"
}

# ---------- 4) Prisma generate إن غاب أو المخطط أحدث ----------
$prismaClient = Join-Path $root 'node_modules\.prisma\client\index.js'
$prismaSchema = Join-Path $root 'apps\api\prisma\schema.prisma'
$needGen = $false
if (-not (Test-Path -LiteralPath $prismaClient)) { $needGen = $true }
elseif (Test-Path -LiteralPath $prismaSchema) {
  if ((Get-Item -LiteralPath $prismaSchema).LastWriteTimeUtc -gt (Get-Item -LiteralPath $prismaClient).LastWriteTimeUtc) { $needGen = $true }
}
if ($needGen) {
  & $env:ComSpec /d /s /c "npm run prisma:generate >> ""$logs\prisma.log"" 2>&1"
}

# ---------- 5) PostgreSQL (فحص حجم ثنائياته أولاً — نسخة مُفرَّغة من Defender) ----------
$pgBin = Join-Path $root 'node_modules\@embedded-postgres\windows-x64\native\bin'
if ((-not (Test-ExeOk (Join-Path $pgBin 'postgres.exe') 5MB)) -or (-not (Test-ExeOk (Join-Path $pgBin 'pg_ctl.exe') 50KB))) {
  Write-Log 'launch.log' 'PostgreSQL binaries missing or gutted — reinstalling platform package...'
  try { Remove-Item -LiteralPath (Join-Path $root 'node_modules\@embedded-postgres\windows-x64') -Recurse -Force -ErrorAction Stop } catch {}
  & $env:ComSpec /d /s /c "npm install @embedded-postgres/windows-x64 --no-save --offline >> ""$logs\prisma.log"" 2>&1"
  if ((-not (Test-ExeOk (Join-Path $pgBin 'postgres.exe') 5MB)) -or (-not (Test-ExeOk (Join-Path $pgBin 'pg_ctl.exe') 50KB))) {
    Write-Log 'launch.log' 'PostgreSQL still broken — run Fix_Defender.bat first (Defender deletes the binaries).'
    exit 1
  }
}
# ملاحظة: حزمة windows-x64 لا تشحن initdb.exe — التهيئة الأولى تتم عبر embedded-postgres
# (pg-local.js setup) الذي يستخرج/يبني ما يلزم، لا عبر initdb مباشر.
& $env:ComSpec /d /s /c "node _tools\pg-run.js status >nul 2>&1"
if ($LASTEXITCODE -ne 0) {
  & $env:ComSpec /d /s /c "node _tools\pg-run.js start >> ""$logs\pg-start.log"" 2>&1"
  for ($k = 0; $k -lt 45; $k++) {
    & $env:ComSpec /d /s /c "node _tools\pg-run.js status >nul 2>&1"
    if ($LASTEXITCODE -eq 0) { break }
    Start-Sleep -Seconds 2
  }
  & $env:ComSpec /d /s /c "node _tools\pg-run.js status >nul 2>&1"
  if ($LASTEXITCODE -ne 0) {
    Write-Log 'launch.log' 'PostgreSQL failed to start — see _tools\logs\pg-start.log'
    exit 1
  }
}
Write-Log 'launch.log' 'PostgreSQL up'

# ---------- 6) .env أول مرة فقط ----------
$envFile = Join-Path $root 'apps\api\.env'
if (-not (Test-Path -LiteralPath $envFile)) {
  $example = Join-Path $root 'apps\api\.env.example'
  if (Test-Path -LiteralPath $example) { Copy-Item -LiteralPath $example -Destination $envFile }
  else { Set-Content -LiteralPath $envFile -Value 'DATABASE_URL="postgresql://medad:medad@localhost:5433/medad?schema=public"' -Encoding UTF8 }
}

# ---------- 7) Migrations عند تغيّر البصمة فقط ----------
$migRoot = Join-Path $root 'apps\api\prisma\migrations'
$sig = ''
if (Test-Path -LiteralPath $migRoot) {
  $sig = ((Get-ChildItem -LiteralPath $migRoot -Directory | Select-Object -ExpandProperty Name | Sort-Object) -join ';')
}
$sigFile = Join-Path $logs 'migrations.marker'
$needMigrate = $true
if (Test-Path -LiteralPath $sigFile) {
  try { $needMigrate = ((Get-Content -LiteralPath $sigFile -Raw) -ne $sig) } catch {}
}
if ($needMigrate) {
  & $env:ComSpec /d /s /c "npm run db:migrate >> ""$logs\migrate.log"" 2>&1"
  Set-Content -LiteralPath $sigFile -Value $sig -Encoding UTF8 -NoNewline
}

# ---------- 8) API + Web بالتوازي (نوافذ مخفية — بلا تجمّد) ----------
if (-not (Test-PortOpen 3000)) { Start-Hidden 'npm run dev:api' 'api.log' | Out-Null }
if (-not (Test-PortOpen 5173)) { Start-Hidden 'npm run dev:web' 'web.log' | Out-Null }

# ---------- 9) انتظار الويب؛ إن مات اللودر افتح الواجهة مباشرة ----------
Wait-ForPort 5173 'web' 60 1000 | Out-Null
if ((Test-PortOpen 5173) -and (-not (Test-PortOpen 5199))) {
  Start-Process 'http://127.0.0.1:5173/' | Out-Null
}

# ---------- 10) مراقبة API (اللودر يحوّل للتطبيق عند الجاهزية) ----------
Wait-ForPort 3000 'api' 90 2000 | Out-Null

Write-Log 'launch.log' '=== launch done ==='
exit 0
