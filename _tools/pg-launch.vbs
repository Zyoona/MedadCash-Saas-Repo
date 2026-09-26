Option Explicit
Dim sh, postgres, dataDir, port, logFile, cmd
Set sh = CreateObject("WScript.Shell")
postgres = WScript.Arguments(0)
dataDir = WScript.Arguments(1)
port = WScript.Arguments(2)
logFile = WScript.Arguments(3)
' تشغيل postgres.exe مباشرة دون cmd /c لتجنب مشاكل الاقتباس
' استخدم مصفوفة وسيطات للتشغيل النظيف
Dim args
args = """" & postgres & """ -D """ & dataDir & """ -p " & port
' إعادة توجيه المخرجات إلى ملف السجل باستخدام shell redirection
cmd = "cmd /c " & args & " >> """ & logFile & """ 2>&1"
sh.Run cmd, 0, False