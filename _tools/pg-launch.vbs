Option Explicit
Dim sh, pgCtl, dataDir, port, logFile, cmd
Set sh = CreateObject("WScript.Shell")
pgCtl = WScript.Arguments(0)
dataDir = WScript.Arguments(1)
port = WScript.Arguments(2)
logFile = WScript.Arguments(3)
' استخدام pg_ctl start - الطريقة الصحيحة لتشغيل PostgreSQL كخدمة خلفية على Windows
cmd = """" & pgCtl & """ start -D """ & dataDir & """ -o ""-p " & port & """ -l """ & logFile & """ -w"
sh.Run cmd, 0, True