# ============================================================
#  مداد — إيقاف النظام (واجهة حديثة)
#  يوقف: واجهة الويب (:5173) — خادم API (:3000) — قاعدة البيانات PostgreSQL (:5433) — شاشة التحميل (:5199)
#  يُشغَّل عبر stop.vbs الموجود في جذر المشروع.
#  للتدقيق البصري دون إيقاف أي شيء:  powershell -File _tools\stop.ps1 -SelfTest
# ============================================================
param([switch]$SelfTest)

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$logs = Join-Path $root '_tools\logs'
if (-not (Test-Path -LiteralPath $logs)) { New-Item -ItemType Directory -Path $logs | Out-Null }
$env:Path = (Join-Path $root '_tools\node') + ';' + $env:Path

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class MedadNative {
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int a, ref int v, int s);
  [DllImport("user32.dll")] public static extern bool ReleaseCapture();
  [DllImport("user32.dll")] public static extern int SendMessage(IntPtr h, int m, int w, int l);
}
"@

# ----- الألوان والخطوط -----
$bg     = [System.Drawing.Color]::FromArgb(15, 23, 42)
$card   = [System.Drawing.Color]::FromArgb(30, 41, 59)
$line   = [System.Drawing.Color]::FromArgb(51, 65, 85)
$textC  = [System.Drawing.Color]::FromArgb(241, 249, 255)
$muted  = [System.Drawing.Color]::FromArgb(148, 163, 184)
$green  = [System.Drawing.Color]::FromArgb(34, 197, 94)
$amber  = [System.Drawing.Color]::FromArgb(245, 158, 11)
$red    = [System.Drawing.Color]::FromArgb(239, 68, 68)

$font    = New-Object System.Drawing.Font('Segoe UI', 9)
$fontSm  = New-Object System.Drawing.Font('Segoe UI', 8.25)
$fontB   = New-Object System.Drawing.Font('Segoe UI', 11.5, [System.Drawing.FontStyle]::Bold)
$fontT   = New-Object System.Drawing.Font('Segoe UI', 10.5, [System.Drawing.FontStyle]::Bold)
$fontXL  = New-Object System.Drawing.Font('Segoe UI', 24, [System.Drawing.FontStyle]::Bold)

# ----- النافذة -----
$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition = 'CenterScreen'
$form.Size = New-Object System.Drawing.Size(440, 344)
$form.BackColor = $bg
$form.TopMost = $true
$form.KeyPreview = $true

# ----- الترويسة -----
$title = New-Object System.Windows.Forms.Label
$title.Text = 'إيقاف النظام'
$title.Font = $fontT
$title.ForeColor = $textC
$title.RightToLeft = 'Yes'
$title.AutoSize = $false
$title.TextAlign = 'MiddleLeft'
$title.Size = New-Object System.Drawing.Size(300, 24)
$title.Location = New-Object System.Drawing.Point(126, 9)

$subtitle = New-Object System.Windows.Forms.Label
$subtitle.Text = 'مداد — نظام إدارة ومحاسبة المكتبة'
$subtitle.Font = $fontSm
$subtitle.ForeColor = $muted
$subtitle.RightToLeft = 'Yes'
$subtitle.AutoSize = $false
$subtitle.TextAlign = 'MiddleLeft'
$subtitle.Size = New-Object System.Drawing.Size(300, 18)
$subtitle.Location = New-Object System.Drawing.Point(126, 31)

$closeBtn = New-Object System.Windows.Forms.Label
$closeBtn.Text = [string][char]0xD7
$closeBtn.Font = $font
$closeBtn.ForeColor = $muted
$closeBtn.TextAlign = 'MiddleCenter'
$closeBtn.Size = New-Object System.Drawing.Size(30, 24)
$closeBtn.Location = New-Object System.Drawing.Point(10, 11)
$closeBtn.Cursor = 'Hand'
$closeBtn.Add_Click({ $form.Close() })
$closeBtn.Add_MouseEnter({ $closeBtn.ForeColor = $red })
$closeBtn.Add_MouseLeave({ $closeBtn.ForeColor = $muted })

# ----- الحالة الرئيسية -----
$heroIcon = New-Object System.Windows.Forms.Label
$heroIcon.Text = ''
$heroIcon.Font = $fontXL
$heroIcon.ForeColor = $green
$heroIcon.AutoSize = $false
$heroIcon.Size = New-Object System.Drawing.Size(60, 48)
$heroIcon.Location = New-Object System.Drawing.Point(190, 54)
$heroIcon.TextAlign = 'MiddleCenter'

$heroText = New-Object System.Windows.Forms.Label
$heroText.Text = 'جاري إيقاف النظام'
$heroText.Font = $fontB
$heroText.ForeColor = $textC
$heroText.RightToLeft = 'Yes'
$heroText.AutoSize = $false
$heroText.TextAlign = 'MiddleCenter'
$heroText.Size = New-Object System.Drawing.Size(400, 26)
$heroText.Location = New-Object System.Drawing.Point(20, 106)

$heroSub = New-Object System.Windows.Forms.Label
$heroSub.Text = 'لحظات ويكتمل الإيقاف'
$heroSub.Font = $fontSm
$heroSub.ForeColor = $muted
$heroSub.RightToLeft = 'Yes'
$heroSub.AutoSize = $false
$heroSub.TextAlign = 'MiddleCenter'
$heroSub.Size = New-Object System.Drawing.Size(380, 18)
$heroSub.Location = New-Object System.Drawing.Point(30, 132)

# ----- صفوف الخدمات -----
$services = @('واجهة الويب', 'خادم API', 'قاعدة البيانات PostgreSQL', 'شاشة التحميل')
$rowDot = @()
$rowStatus = @()

for ($i = 0; $i -lt $services.Count; $i++) {
  $row = New-Object System.Windows.Forms.Panel
  $row.Size = New-Object System.Drawing.Size(392, 30)
  $row.Location = New-Object System.Drawing.Point(24, (152 + 34 * $i))
  $row.BackColor = $card

  $dot = New-Object System.Windows.Forms.Label
  $dot.Text = [string][char]0x25CF
  $dot.Font = $fontSm
  $dot.ForeColor = $muted
  $dot.TextAlign = 'MiddleCenter'
  $dot.Size = New-Object System.Drawing.Size(16, 30)
  $dot.Location = New-Object System.Drawing.Point(14, 0)

  $name = New-Object System.Windows.Forms.Label
  $name.Text = $services[$i]
  $name.Font = $font
  $name.ForeColor = $textC
  $name.RightToLeft = 'Yes'
  $name.AutoSize = $false
  $name.TextAlign = 'MiddleLeft'
  $name.Size = New-Object System.Drawing.Size(236, 30)
  $name.Location = New-Object System.Drawing.Point(142, 0)

  $status = New-Object System.Windows.Forms.Label
  $status.Text = '...'
  $status.Font = $fontSm
  $status.ForeColor = $muted
  $status.RightToLeft = 'Yes'
  $status.AutoSize = $false
  $status.TextAlign = 'MiddleRight'
  $status.Size = New-Object System.Drawing.Size(106, 30)
  $status.Location = New-Object System.Drawing.Point(16, 0)

  $row.Controls.Add($dot)
  $row.Controls.Add($name)
  $row.Controls.Add($status)
  $form.Controls.Add($row)
  $rowDot += , $dot
  $rowStatus += , $status
}

# ----- التذييل -----
$countLbl = New-Object System.Windows.Forms.Label
$countLbl.Text = ''
$countLbl.Font = $fontSm
$countLbl.ForeColor = $muted
$countLbl.RightToLeft = 'Yes'
$countLbl.AutoSize = $false
$countLbl.TextAlign = 'MiddleLeft'
$countLbl.Size = New-Object System.Drawing.Size(186, 18)
$countLbl.Location = New-Object System.Drawing.Point(230, 292)

$closeLbl = New-Object System.Windows.Forms.Label
$closeLbl.Text = ''
$closeLbl.Font = $fontSm
$closeLbl.ForeColor = $muted
$closeLbl.RightToLeft = 'Yes'
$closeLbl.AutoSize = $false
$closeLbl.TextAlign = 'MiddleRight'
$closeLbl.Size = New-Object System.Drawing.Size(186, 18)
$closeLbl.Location = New-Object System.Drawing.Point(24, 292)

$progressBar = New-Object System.Windows.Forms.ProgressBar
$progressBar.Size = New-Object System.Drawing.Size(392, 5)
$progressBar.Location = New-Object System.Drawing.Point(24, 320)
$progressBar.Maximum = 100
$progressBar.Value = 0

$form.Controls.Add($title)
$form.Controls.Add($subtitle)
$form.Controls.Add($closeBtn)
$form.Controls.Add($heroIcon)
$form.Controls.Add($heroText)
$form.Controls.Add($heroSub)
$form.Controls.Add($countLbl)
$form.Controls.Add($closeLbl)
$form.Controls.Add($progressBar)

# ----- إغلاق بـ Esc + سحب النافذة + حدّ خارجي -----
$form.Add_KeyDown({
  param($s, $e)
  if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Escape) { $s.Close() }
})

$dragHandler = {
  param($s, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    [void][MedadNative]::ReleaseCapture()
    [void][MedadNative]::SendMessage($form.Handle, 0xA1, 2, 0)
  }
}
$form.Add_MouseDown($dragHandler)
$title.Add_MouseDown($dragHandler)
$subtitle.Add_MouseDown($dragHandler)

$script:rounded = $false
$form.Add_Paint({
  param($s, $e)
  if (-not $script:rounded) {
    $pen = New-Object System.Drawing.Pen($script:line)
    $e.Graphics.DrawRectangle($pen, 0, 0, $s.ClientSize.Width - 1, $s.ClientSize.Height - 1)
    $pen.Dispose()
  }
})

# ----- دوال مساعدة -----
function Set-Row([int]$idx, [string]$state) {
  $d = $script:rowDot[$idx]
  $s = $script:rowStatus[$idx]
  switch ($state) {
    'stopping' { $d.ForeColor = $script:amber; $s.Text = 'جاري الإيقاف…'; $s.ForeColor = $script:amber }
    'stopped'  { $d.ForeColor = $script:green; $s.Text = 'متوقفة ✓';      $s.ForeColor = $script:green }
    'running'  { $d.ForeColor = $script:red;   $s.Text = 'قيد التشغيل';   $s.ForeColor = $script:red }
  }
}

function Test-PortOpen([int]$port) {
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $ar = $c.BeginConnect('127.0.0.1', $port, $null, $null)
    if ($ar.AsyncWaitHandle.WaitOne(250, $false) -and $c.Connected) { return $true }
    return $false
  } catch {
    return $false
  } finally {
    try { $c.Close() } catch {}
  }
}

# ----- مؤقتات -----
$script:dotsN = 0
$animTimer = New-Object System.Windows.Forms.Timer
$animTimer.Interval = 400
$animTimer.Add_Tick({
  $script:dotsN = ($script:dotsN + 1) % 4
  $heroText.Text = 'جاري إيقاف النظام' + ('.' * $script:dotsN)
})
$script:animTimer = $animTimer

$script:tick = 0
$closeTimer = New-Object System.Windows.Forms.Timer
$closeTimer.Interval = 100
$closeTimer.Add_Tick({
  $script:tick = $script:tick + 1
  $progressBar.Value = [Math]::Min($script:tick, $progressBar.Maximum)
  $remain = [Math]::Max(0, [int](($progressBar.Maximum - $script:tick) / 10))
  $closeLbl.Text = 'الإغلاق التلقائي خلال ' + $remain + ' ثوانٍ'
  if ($script:tick -ge $progressBar.Maximum) {
    $script:closeTimer.Stop()
    $form.Close()
  }
})
$script:closeTimer = $closeTimer

$form.Add_FormClosed({
  $script:animTimer.Stop()
  $script:closeTimer.Stop()
})

# ----- التنفيذ داخل حدث Shown -----
$ports = @(5173, 3000, 5433, 5199)
$script:killed = 0
$script:errorMsg = ''
$script:rowOpen = @()

$form.Add_Shown({
  $script:animTimer.Start()

  try {
    # محاولة تدوير زوايا النافذة على Windows 11
    try {
      $pref = 2
      [void][MedadNative]::DwmSetWindowAttribute($form.Handle, 33, [ref]$pref, 4)
      $script:rounded = $true
    } catch { $script:rounded = $false }

    for ($i = 0; $i -lt $services.Count; $i++) { Set-Row $i 'stopping' }
    [System.Windows.Forms.Application]::DoEvents()

  if (-not $SelfTest) {
    # 1) إيقاف قاعدة البيانات
    $pgLog = Join-Path $logs 'pg-stop.log'
    $pgArgs = '/c node _tools\pg-run.js stop >> "' + $pgLog + '" 2>&1'
    $pg = Start-Process -FilePath "$env:ComSpec" -ArgumentList $pgArgs -WorkingDirectory $root -WindowStyle Hidden -PassThru
    while (-not $pg.HasExited -and -not $form.IsDisposed) {
      [System.Windows.Forms.Application]::DoEvents()
      Start-Sleep -Milliseconds 120
    }

    # 2) إيقاف عمليات node/cmd التابعة للمشروع
    $markers = @('postgres.exe', 'npm-cli.js', 'nest.js', 'vite.js', 'dev:api', 'dev:web', 'splash-server.js')
    $seen = @{}
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'")
    foreach ($p in $procs) {
      $cl = $p.CommandLine
      if (-not $cl) { continue }
      $isSplash = $cl.IndexOf('splash-server.js', [System.StringComparison]::OrdinalIgnoreCase) -ge 0
      $hit = $false
      if ($isSplash) {
        $hit = $true
      } elseif ($cl.IndexOf($root, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
        foreach ($m in $markers) {
          if ($cl.IndexOf($m, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $hit = $true; break }
        }
      }
      if ($hit -and ($p.Name -ieq 'node.exe') -and (-not $isSplash) -and ($cl.IndexOf('\node_modules\', [System.StringComparison]::OrdinalIgnoreCase) -lt 0)) {
        $hit = $false
      }
      if ($hit -and -not $seen.ContainsKey([int]$p.ProcessId)) {
        $seen[[int]$p.ProcessId] = $true
        & taskkill.exe /PID $p.ProcessId /F /T 2>$null 1>$null
        $script:killed++
      }
    }

    # 3) إن ظلّت منافذ تستمع: إيقاف مالك المنفذ مباشرة
    foreach ($port in @(5199, 5173, 3000, 5433)) {
      if (Test-PortOpen $port) {
        $conns = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
        foreach ($cn in $conns) {
          $own = [int]$cn.OwningProcess
          if ($own -gt 0 -and -not $seen.ContainsKey($own)) {
            $seen[$own] = $true
            & taskkill.exe /PID $own /F /T 2>$null 1>$null
            $script:killed++
          }
        }
      }
    }
  }

  # 4) التحقق من حالة كل خدمة
  for ($i = 0; $i -lt $services.Count; $i++) {
    if ($form.IsDisposed) { break }
    $open = if ($SelfTest) { $false } else { Test-PortOpen $ports[$i] }
    $script:rowOpen += , $open
    if ($open) { Set-Row $i 'running' } else { Set-Row $i 'stopped' }
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 80
  }
} catch {
  $script:errorMsg = $_.Exception.Message
}

if ($form.IsDisposed) { return }

# ----- الحالة النهائية -----
$script:animTimer.Stop()
$allStopped = $true
if ($script:rowOpen.Count -lt $services.Count) { $allStopped = $false }
for ($i = 0; $i -lt $script:rowOpen.Count; $i++) { if ($script:rowOpen[$i]) { $allStopped = $false } }

if ($script:errorMsg) {
  $heroIcon.Text = '!'
  $heroIcon.ForeColor = $red
  $heroText.Text = 'حدث خطأ أثناء الإيقاف'
  $heroSub.Text = $script:errorMsg
} elseif ($allStopped) {
  $heroIcon.Text = [string][char]0x2713
  $heroIcon.ForeColor = $green
  $heroText.Text = 'تم إيقاف نظام مداد بنجاح'
  $heroSub.Text = 'جميع الخدمات متوقفة الآن'
} else {
  $heroIcon.Text = '!'
  $heroIcon.ForeColor = $amber
  $heroText.Text = 'تم الإيقاف مع تحذيرات'
  $heroSub.Text = 'بعض الخدمات لا تزال تعمل — راجع _tools\logs'
}

$w = [System.Windows.Forms.TextRenderer]::MeasureText($heroIcon.Text, $fontXL).Width
$heroIcon.Location = New-Object System.Drawing.Point([int](($form.ClientSize.Width - $w) / 2), 54)

$countLbl.Text = 'العمليات الموقوفة: ' + $script:killed
$closeLbl.Text = 'الإغلاق التلقائي خلال 10 ثوانٍ'

try {
  Add-Content -LiteralPath (Join-Path $logs 'stop.log') -Value ('{0}  killed={1}  ok={2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $script:killed, $allStopped) -Encoding UTF8
} catch {}

$script:closeTimer.Start()
})

if (-not $form.IsDisposed) { [void]$form.ShowDialog() }
