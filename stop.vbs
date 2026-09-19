' ============================================================
'  مداد — إيقاف النظام بالكامل
'  يوقف واجهة الويب (:5173) وخادم API (:3000) وقاعدة البيانات PostgreSQL
'  ضع هذا الملف في جذر المشروع ثم اضغط عليه مرتين.
' ============================================================
Option Explicit

Const SW_HIDE = 0

Dim sh, fso, root, logs, wmi, procs, p, killed
Dim markers, i, cl, hit

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
logs = root & "\_tools\logs"
If Not fso.FolderExists(logs) Then fso.CreateFolder logs

sh.Environment("PROCESS")("Path") = root & "\_tools\node;" & sh.Environment("PROCESS")("Path")
sh.CurrentDirectory = root

sh.Run "cmd /c node _tools\pg-run.js stop >> """ & logs & "\pg-stop.log"" 2>&1", SW_HIDE, True

markers = Array("postgres.exe", "npm-cli.js", "nest.js", "vite.js", "dev:api", "dev:web", "splash-server.js")

killed = 0
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set procs = wmi.ExecQuery("SELECT ProcessId, Name, CommandLine FROM Win32_Process WHERE Name='node.exe' OR Name='cmd.exe'")
For Each p In procs
  If Not IsNull(p.CommandLine) Then
    cl = p.CommandLine
    hit = False
    If InStr(1, cl, "splash-server.js", vbTextCompare) > 0 Then
      hit = True
    ElseIf InStr(1, cl, root, vbTextCompare) > 0 Then
      For i = 0 To UBound(markers)
        If InStr(1, cl, markers(i), vbTextCompare) > 0 Then hit = True
      Next
    End If
    ' node.exe: لا نقتله إلا إذا كان من node_modules داخل المشروع (حماية من قتل أدوات غير ذات صلة)
    If hit And LCase(p.Name) = "node.exe" And InStr(1, cl, "splash-server.js", vbTextCompare) = 0 And InStr(1, cl, "\node_modules\", vbTextCompare) = 0 Then
      hit = False
    End If
    If hit Then
      sh.Run "taskkill /pid " & p.ProcessId & " /f /t", SW_HIDE, True
      killed = killed + 1
    End If
  End If
Next

sh.Popup "تم إيقاف نظام مداد." & vbCrLf & vbCrLf & _
         "عدد العمليات الموقفة: " & killed, 8, "مداد — إيقاف", vbInformation
WScript.Quit 0
